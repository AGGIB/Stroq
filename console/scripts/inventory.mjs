import { randomUUID } from 'node:crypto';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { ensureInventoryStore } from './inventory-safe.mjs';
import { prepareCodexSkillApplyLock } from './mcp-containment-files.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const layout = runtimeLayout();
const REPOSITORY = layout.repository;
const WORKER = layout.adapter('inventory-worker.js');
const CORE = layout.core;
const runtimePaths = Object.freeze({
  cli: layout.cli,
  package: layout.package,
  manifest: layout.manifest,
  manifestRoot: layout.manifestRoot,
});
const loadSchema = () => import(pathToFileURL(layout.adapter('inventory-schema.js')).href);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fields = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const validSignalPreview = (value) =>
  fields(value, ['id', 'expectedSha256', 'expectedDecisionId', 'decision', 'reason']) &&
  validInspect({ id: value.id, expectedSha256: value.expectedSha256 }) &&
  (value.expectedDecisionId === null || uuid(value.expectedDecisionId));
const invalid = () => ({ status: 400, body: { error: 'invalid-request' } });
const conflict = () => ({ status: 409, body: { error: 'signal-conflict' } });
const codexError = (error = 'codex-control-unavailable', status = 409) => ({
  status,
  body: { error },
});
const known = new Set([
  'inventory-unavailable',
  'baseline-invalid',
  'review-conflict',
  'review-incomplete',
  'inspect-conflict',
  'signal-conflict',
  'signal-incomplete',
  'signal-store-unavailable',
  'signal-store-full',
]);
const validReview = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === 3 &&
  Object.keys(value).every((key) => ['itemId', 'sha256', 'expectedReviewedSha256'].includes(key)) &&
  typeof value.itemId === 'string' &&
  /^item-[a-f0-9]{24}$/.test(value.itemId) &&
  typeof value.sha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(value.sha256) &&
  (value.expectedReviewedSha256 === null ||
    (typeof value.expectedReviewedSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.expectedReviewedSha256)));
const validInspect = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'expectedSha256,id' &&
  typeof value.id === 'string' &&
  /^item-[a-f0-9]{24}$/.test(value.id) &&
  typeof value.expectedSha256 === 'string' &&
  /^[a-f0-9]{64}$/.test(value.expectedSha256);

const validCompare = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'expectedReviewedSha256,expectedSha256,id' &&
  validInspect({ id: value.id, expectedSha256: value.expectedSha256 }) &&
  (value.expectedReviewedSha256 === null ||
    (typeof value.expectedReviewedSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.expectedReviewedSha256)));

async function manualRoot(path) {
  const canonical = resolve(path),
    before = await lstat(canonical);
  if (!before.isDirectory() || before.isSymbolicLink() || (await realpath(canonical)) !== canonical)
    throw Error('changed-context');
  const pin = (stat) => ({
    path: canonical,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
  });
  const captured = pin(before),
    after = await lstat(canonical);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    JSON.stringify(captured) !== JSON.stringify(pin(after))
  )
    throw Error('changed-context');
  return captured;
}

export function createInventory({
  project = REPOSITORY,
  userHome = homedir(),
  home = process.env.STROQ_HOME ?? join(userHome, '.stroq'),
  workerPath = WORKER,
  timeoutMs = 25_000,
  mcpEnvironment = {},
  codexEnvironment = {},
} = {}) {
  const codexRoots = Promise.all([manualRoot(project), manualRoot(userHome)])
    .then(([project, user]) => ({ project, user }))
    .catch(() => null);
  async function sameCodexRoots(expected) {
    try {
      return (
        JSON.stringify(expected) ===
        JSON.stringify({ project: await manualRoot(project), user: await manualRoot(userHome) })
      );
    } catch {
      return false;
    }
  }
  let pending = null;
  let reviewing = false;
  let inspecting = false;
  let closed = false;
  let stop = null;
  const plans = new Map();
  const controlPlans = new Map();
  const controlBytes = 8 * 1024 * 1024;
  const pruneControls = () => {
    for (const [id, plan] of controlPlans)
      if (plan.expiresAt <= Date.now()) controlPlans.delete(id);
  };
  const prune = () => {
    for (const [key, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(key);
  };
  function exclusive(action) {
    if (pending || reviewing || inspecting)
      return Promise.resolve({ status: 409, body: { error: 'busy' } });
    inspecting = true;
    pending = Promise.resolve()
      .then(action)
      .finally(() => {
        pending = null;
        inspecting = false;
      });
    return pending;
  }
  async function run(operation, input = {}, deadline = Date.now() + timeoutMs, expectedRuntime) {
    const network = operation.startsWith('codex-network-');
    const pathGuard = operation.startsWith('codex-path-');
    const control = operation.startsWith('codex-control-') || network || pathGuard;
    const unavailable = pathGuard
      ? 'codex-path-guard-unavailable'
      : network
        ? 'codex-network-unavailable'
        : 'codex-control-unavailable';
    const runtimeChanged = pathGuard
      ? 'codex-path-guard-runtime-changed'
      : network
        ? 'codex-network-runtime-changed'
        : 'codex-control-runtime-changed';
    let validate, runtimeSha256, controlErrors;
    try {
      const stat = await lstat(workerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        throw new Error();
      const schema = await loadSchema();
      runtimeSha256 = await runtimeDigest(runtimePaths);
      if (expectedRuntime !== undefined && runtimeSha256 !== expectedRuntime)
        return codexError(runtimeChanged);
      controlErrors = new Set(
        pathGuard
          ? (schema.CODEX_PATH_GUARD_ERRORS ?? [])
          : network
            ? (schema.CODEX_NETWORK_GUARD_ERRORS ?? [])
            : (schema.CODEX_SKILL_CONTROL_ERRORS ?? []),
      );
      const validControlReceipt = (value) => {
        if (!schema.validateCodexSkillControlReceipt(value)) return false;
        const selected =
          operation === 'codex-control-apply'
            ? input.controlData.privatePlan.preview
            : input.controlData.request;
        return (
          value.operation ===
            (operation === 'codex-control-apply' ? selected.operation : 'recheck') &&
          value.operationId ===
            (operation === 'codex-control-apply' ? selected.id : selected.operationId) &&
          value.controlContextId === selected.controlContextId &&
          value.record.id === selected.recordId
        );
      };
      const controlValidators = {
        'codex-control-state': schema.validateCodexSkillControlState,
        'codex-control-apply': validControlReceipt,
        'codex-control-recheck': validControlReceipt,
        'codex-control-preview': (value) =>
          fields(value, ['preview', 'privatePlan']) &&
          schema.validateCodexSkillControlPreview(value.preview) &&
          schema.validateCodexSkillControlPrivatePlan(value.privatePlan) &&
          isDeepStrictEqual(value.preview, value.privatePlan.preview) &&
          isDeepStrictEqual(value.privatePlan.request, input.controlData.request) &&
          isDeepStrictEqual(value.privatePlan.context.user, input.codexExpectedRoots.user) &&
          schema.codexSkillControlPrivatePlanBytes(value.privatePlan) <= controlBytes &&
          serialize(value).byteLength <= controlBytes,
      };
      const validNetworkReceipt = (value) => {
        if (!schema.validateCodexNetworkGuardReceipt(value)) return false;
        const apply = operation === 'codex-network-apply';
        const selected = apply
          ? input.networkGuardData.privatePlan.preview
          : input.networkGuardData.request;
        return (
          value.operation === (apply ? selected.operation : 'recheck') &&
          value.operationId === (apply ? selected.id : selected.operationId) &&
          value.controlContextId === selected.controlContextId &&
          value.record.id === selected.recordId
        );
      };
      const networkValidators = {
        'codex-network-state': schema.validateCodexNetworkGuardState,
        'codex-network-capture': schema.validateCodexNetworkGuardCapture,
        'codex-network-preview': (value) =>
          fields(value, ['preview', 'privatePlan']) &&
          schema.validateCodexNetworkGuardPreview(value.preview) &&
          schema.validateCodexNetworkGuardPrivatePlan(value.privatePlan) &&
          isDeepStrictEqual(value.preview, value.privatePlan.preview) &&
          isDeepStrictEqual(value.privatePlan.request, input.networkGuardData.request) &&
          isDeepStrictEqual(value.privatePlan.context.user, input.codexExpectedRoots.user) &&
          schema.codexNetworkGuardPrivatePlanBytes(value.privatePlan) <= controlBytes &&
          serialize(value).byteLength <= controlBytes,
        'codex-network-check-prepare': (value) =>
          schema.validateCodexNetworkGuardCheckPreparation(value) &&
          value.binding.controlContextId === input.networkGuardData.request.controlContextId &&
          value.binding.captureSha256 === input.networkGuardData.request.captureSha256 &&
          value.binding.runtimeSha256 === runtimeSha256 &&
          schema.codexNetworkGuardCheckPreparationBytes(value) <= controlBytes &&
          serialize(value).byteLength <= controlBytes,
        'codex-network-apply': validNetworkReceipt,
        'codex-network-recheck': validNetworkReceipt,
      };
      const validPathReceipt = (value) => {
        if (!schema.validateCodexPathGuardReceipt(value)) return false;
        const apply = operation === 'codex-path-apply',
          selected = apply ? input.pathGuardData.privatePlan.preview : input.pathGuardData.request;
        return (
          value.operation === (apply ? selected.operation : 'recheck') &&
          value.operationId === selected.operationId &&
          value.controlContextId === selected.controlContextId &&
          value.record.id === selected.recordId
        );
      };
      const pathValidators = {
        'codex-path-state': schema.validateCodexPathGuardState,
        'codex-path-capture': schema.validateCodexPathGuardCapture,
        'codex-path-preview': (value) =>
          fields(value, ['preview', 'privatePlan']) &&
          schema.validateCodexPathGuardPreview(value.preview) &&
          schema.validateCodexPathGuardPrivatePlan(value.privatePlan) &&
          isDeepStrictEqual(value.preview, value.privatePlan.preview) &&
          isDeepStrictEqual(value.privatePlan.request, input.pathGuardData.request) &&
          isDeepStrictEqual(value.privatePlan.context.user, input.codexExpectedRoots.user) &&
          value.privatePlan.capture.binding.runtimeSha256 === runtimeSha256 &&
          schema.codexPathGuardPrivatePlanBytes(value.privatePlan) <= controlBytes &&
          serialize(value).byteLength <= controlBytes,
        'codex-path-apply': validPathReceipt,
        'codex-path-recheck': validPathReceipt,
      };
      validate = control
        ? (pathGuard ? pathValidators : network ? networkValidators : controlValidators)[operation]
        : operation.startsWith('signal-')
          ? schema.validateInventorySignalState
          : operation === 'codex-sources'
            ? schema.validateCodexSkillSourcesReport
            : operation === 'inspect'
              ? schema.validateInventoryEvidence
              : operation === 'compare'
                ? schema.validateInventoryComparison
                : schema.validateInventory;
      if (typeof validate !== 'function') throw new Error();
    } catch {
      return control
        ? codexError(unavailable, 503)
        : { status: 503, body: { error: 'engine-unavailable' } };
    }
    if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
    if (Date.now() >= deadline) return { status: 503, body: { error: 'deadline-exceeded' } };
    return new Promise((resolveRun) => {
      const worker = new Worker(workerPath, {
        workerData: {
          operation,
          project,
          userHome,
          home,
          deadline,
          mcpEnvironment,
          codexEnvironment,
          ...input,
          runtimeSha256,
          runtimePaths,
        },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
      let settled = false;
      let received = false;
      const finish = async (status, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop = null;
        // The caller may own the review lock. A worker must be stopped before
        // that lock is released, including on deadline, error and server close.
        await worker.terminate().catch(() => undefined);
        resolveRun({ status, body });
      };
      const timer = setTimeout(
        () => finish(503, { error: 'deadline-exceeded' }),
        Math.max(1, deadline - Date.now()),
      );
      stop = () => finish(503, { error: 'inventory-unavailable' });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.once('message', async (value) => {
        received = true;
        if (control && controlErrors.has(value?.error))
          return finish(value.error.includes('unavailable') ? 503 : 409, { error: value.error });
        if (known.has(value?.error))
          return finish(value.error === 'inventory-unavailable' ? 503 : 409, {
            error: value.error,
          });
        try {
          if (
            !validate(value) ||
            (![
              'codex-control-preview',
              'codex-network-preview',
              'codex-path-preview',
              'codex-network-check-prepare',
            ].includes(operation) &&
              JSON.stringify(value).length > 512 * 1024)
          )
            throw new Error();
        } catch {
          return finish(503, {
            error: control ? unavailable : 'inventory-unavailable',
          });
        }
        try {
          // Bind accepted captures to the runtime that actually completed them.
          if ((await runtimeDigest(runtimePaths)) !== runtimeSha256) throw new Error();
        } catch {
          return finish(503, {
            error: control ? runtimeChanged : 'engine-unavailable',
          });
        }
        finish(200, value);
      });
      worker.once('error', () => finish(503, { error: 'inventory-unavailable' }));
      worker.once('exit', () => {
        if (!received) finish(503, { error: 'inventory-unavailable' });
      });
    });
  }
  function controlExclusive(action) {
    return pending || reviewing || inspecting
      ? Promise.resolve(codexError('codex-control-busy'))
      : exclusive(action);
  }
  async function controlRun(operation, data, deadline = Date.now() + timeoutMs, expectedRuntime) {
    const expected = await codexRoots;
    if (!expected || !(await sameCodexRoots(expected))) return codexError('codex-control-stale');
    let result;
    try {
      result = await run(
        operation,
        { controlData: data, codexExpectedRoots: expected },
        deadline,
        expectedRuntime,
      );
    } catch {
      return codexError('codex-control-unavailable', 503);
    }
    if (!(await sameCodexRoots(expected))) return codexError('codex-control-stale');
    if (result.status !== 200 && !result.body.error?.startsWith('codex-control-'))
      return codexError('codex-control-unavailable', 503);
    return result;
  }
  async function controlLocked(operation, data, deadline, expectedRuntime) {
    try {
      const expected = await codexRoots;
      if (!expected || !(await sameCodexRoots(expected))) return codexError('codex-control-stale');
      if (closed) return codexError('codex-control-unavailable', 503);
      if (Date.now() >= deadline) return codexError('codex-control-stale');
      const { withLock } = await import(pathToFileURL(CORE).href);
      const lock = await prepareCodexSkillApplyLock(userHome, expected.user);
      return await withLock(
        lock.path,
        () => controlRun(operation, { ...data, writerLockHeld: true }, deadline, expectedRuntime),
        {
          timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())),
          fs: lock.fs,
        },
      );
    } catch {
      return codexError('codex-control-unavailable', 503);
    }
  }
  function nativeConfigurationOperation(family, operation, data, options = {}) {
    const pathGuard = family === 'path',
      base = pathGuard ? 'codex-path' : 'codex-network',
      prefix = pathGuard ? 'codex-path-guard' : 'codex-network';
    if (
      !['state', 'capture', 'preview', 'apply', 'recheck', ...(pathGuard ? [] : ['check-prepare'])]
        .map((action) => base + '-' + action)
        .includes(operation)
    )
      return Promise.resolve(invalid());
    if (pending || reviewing || inspecting) return Promise.resolve(codexError(prefix + '-busy'));
    return exclusive(async () => {
      const deadline = Math.min(options.deadline ?? Date.now() + timeoutMs, Date.now() + timeoutMs);
      const execute = async (expected, writerLockHeld = false) => {
        if (closed) return codexError(prefix + '-unavailable', 503);
        const result = await run(
          operation,
          {
            [pathGuard ? 'pathGuardData' : 'networkGuardData']: {
              ...data,
              ...(writerLockHeld ? { writerLockHeld: true } : {}),
            },
            codexExpectedRoots: expected,
          },
          deadline,
          options.expectedRuntime,
        );
        if (!(await sameCodexRoots(expected))) return codexError(prefix + '-stale');
        return result.status !== 200 && !result.body.error?.startsWith(prefix + '-')
          ? codexError(prefix + '-unavailable', 503)
          : result;
      };
      try {
        const expected = await codexRoots;
        if (!expected || !(await sameCodexRoots(expected))) return codexError(prefix + '-stale');
        if ([base + '-apply', base + '-recheck'].includes(operation)) {
          if (options.writer !== true || closed || Date.now() >= deadline)
            return codexError(prefix + '-stale');
          const { withLock } = await import(pathToFileURL(CORE).href),
            lock = await prepareCodexSkillApplyLock(userHome, expected.user);
          return await withLock(lock.path, () => execute(expected, true), {
            timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())),
            fs: lock.fs,
          });
        }
        return await execute(expected);
      } catch {
        return codexError(prefix + '-unavailable', 503);
      }
    });
  }
  async function performReview(input) {
    const deadline = Date.now() + timeoutMs;
    // Preserve the first scan before creating the store, then rescan while
    // locked. Refresh never acquires a lock or creates anything on disk.
    const before = await run('read', {}, deadline);
    if (before.status !== 200) return before;
    if (before.body.baseline.status === 'invalid')
      return { status: 409, body: { error: 'baseline-invalid' } };
    const chosen = before.body.items.find((item) => item.id === input.itemId);
    if (
      !chosen ||
      chosen.sha256 !== input.sha256 ||
      chosen.reviewedSha256 !== input.expectedReviewedSha256
    )
      return { status: 409, body: { error: 'review-conflict' } };
    if (chosen.scan.status === 'incomplete')
      return { status: 409, body: { error: 'review-incomplete' } };
    try {
      const { withLock } = await import(pathToFileURL(CORE).href);
      const store = resolve(home);
      if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
      if (Date.now() >= deadline) return { status: 503, body: { error: 'deadline-exceeded' } };
      await ensureInventoryStore(store);
      // Workers share the server PID. Owning this lock in a worker would leave
      // it looking permanently live after that worker was terminated.
      return await withLock(
        join(store, 'console', 'inventory.lock'),
        () => run('review', { ...input, reviewLockHeld: true }, deadline),
        { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
      );
    } catch (error) {
      return {
        status: error?.message === 'baseline-invalid' ? 409 : 503,
        body: {
          error:
            error?.message === 'baseline-invalid'
              ? 'baseline-invalid'
              : Date.now() >= deadline
                ? 'deadline-exceeded'
                : 'inventory-unavailable',
        },
      };
    }
  }
  return {
    // Server-only fixed bridge. No HTTP route accepts an operation name or private plan.
    async codexNetworkRuntime() {
      if (closed) throw Error('codex-network-unavailable');
      return runtimeDigest(runtimePaths);
    },
    codexNetworkOperation(operation, data, options) {
      return nativeConfigurationOperation('network', operation, data, options);
    },
    async codexPathGuardRuntime() {
      if (closed) throw Error('codex-path-guard-unavailable');
      return runtimeDigest(runtimePaths);
    },
    codexPathGuardOperation(operation, data, options) {
      return nativeConfigurationOperation('path', operation, data, options);
    },
    codexControlState(input) {
      if (!fields(input, [])) return Promise.resolve(invalid());
      return controlExclusive(() => controlRun('codex-control-state', {}));
    },
    async codexControlPreview(input) {
      try {
        const schema = await loadSchema();
        if (
          !schema.validateCodexSkillControlSelection(input) &&
          !schema.validateCodexSkillControlRestoreSelection(input)
        )
          return invalid();
        input = structuredClone(input);
        return await controlExclusive(async () => {
          pruneControls();
          if (controlPlans.size >= 8) return codexError('codex-control-store-full');
          const runtime = await runtimeDigest(runtimePaths);
          if (input.operation === 'disable' && input.expectedRuntimeSha256 !== runtime)
            return codexError('codex-control-runtime-changed');
          const response = await controlRun('codex-control-preview', { request: input });
          if (response.status !== 200) return response;
          const { preview, privatePlan } = response.body;
          const expiresAt = Date.parse(preview.expiresAt),
            createdAt = Date.parse(preview.createdAt);
          const bytes = Math.max(
            schema.codexSkillControlPrivatePlanBytes(privatePlan),
            serialize(privatePlan).byteLength,
          );
          if (
            closed ||
            expiresAt <= Date.now() ||
            createdAt > Date.now() ||
            controlPlans.has(preview.id)
          )
            return codexError('codex-control-stale');
          if (runtime !== (await runtimeDigest(runtimePaths)))
            return codexError('codex-control-runtime-changed');
          if (
            !Number.isSafeInteger(bytes) ||
            bytes > controlBytes ||
            [...controlPlans.values()].reduce((sum, p) => sum + p.bytes, 0) + bytes > controlBytes
          )
            return codexError('codex-control-store-full');
          controlPlans.set(preview.id, { privatePlan, expiresAt, runtime, bytes });
          return { status: 200, body: preview };
        });
      } catch {
        return codexError('codex-control-unavailable', 503);
      }
    },
    codexControlApply(input) {
      // Recognition is deliberately first: every attempt burns a known preview,
      // including malformed consent, changed context, busy, expiry and shutdown.
      const plan =
        input && typeof input === 'object' ? controlPlans.get(input.previewId) : undefined;
      if (plan) controlPlans.delete(input.previewId);
      pruneControls();
      if (!plan || plan.expiresAt <= Date.now())
        return Promise.resolve(codexError('codex-control-stale'));
      const restore = plan.privatePlan.preview.operation === 'restore';
      if (
        !fields(input, [
          'previewId',
          'controlContextId',
          'acknowledgeSharedUserConfig',
          'acknowledgeRetention',
          ...(restore ? ['acknowledgeWeakening'] : []),
        ]) ||
        input.controlContextId !== plan.privatePlan.preview.controlContextId ||
        input.acknowledgeSharedUserConfig !== true ||
        input.acknowledgeRetention !== true ||
        (restore && input.acknowledgeWeakening !== true)
      )
        return Promise.resolve(invalid());
      return controlExclusive(async () => {
        try {
          if (plan.runtime !== (await runtimeDigest(runtimePaths)))
            return codexError('codex-control-runtime-changed');
          return await controlLocked(
            'codex-control-apply',
            {
              privatePlan: plan.privatePlan,
              acknowledgeSharedUserConfig: true,
              acknowledgeRetention: true,
              ...(restore ? { acknowledgeWeakening: true } : {}),
            },
            Math.min(Date.now() + timeoutMs, plan.expiresAt),
            plan.runtime,
          );
        } catch {
          return codexError('codex-control-unavailable', 503);
        }
      });
    },
    async codexControlRecheck(input) {
      try {
        const schema = await loadSchema();
        if (!schema.validateCodexSkillControlRecheckSelection(input)) return invalid();
        input = structuredClone(input);
        return controlExclusive(() =>
          controlLocked('codex-control-recheck', { request: input }, Date.now() + timeoutMs),
        );
      } catch {
        return codexError('codex-control-unavailable', 503);
      }
    },
    codexSources(input) {
      if (!fields(input, [])) return Promise.resolve(invalid());
      return exclusive(async () => {
        const expected = await codexRoots;
        const unavailable = () => ({ status: 503, body: { error: 'inventory-unavailable' } });
        if (!expected || !(await sameCodexRoots(expected))) return unavailable();
        const result = await run(
          'codex-sources',
          { codexExpectedRoots: expected },
          Date.now() + Math.min(timeoutMs, 15000),
        );
        return result.status === 200 && !(await sameCodexRoots(expected)) ? unavailable() : result;
      });
    },
    // Internal scheduler only. The browser cannot select a worker operation.
    observe() {
      return exclusive(() => run('observe'));
    },
    read() {
      if (reviewing || inspecting) return Promise.resolve({ status: 409, body: { error: 'busy' } });
      if (pending) return pending;
      pending = run('read').finally(() => {
        pending = null;
      });
      return pending;
    },
    async review(input) {
      if (!validReview(input)) return { status: 400, body: { error: 'invalid-request' } };
      input = Object.freeze({ ...input });
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      reviewing = true;
      pending = performReview(input).finally(() => {
        pending = null;
        reviewing = false;
      });
      return pending;
    },
    async inspect(input) {
      if (!validInspect(input)) return { status: 400, body: { error: 'invalid-request' } };
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      inspecting = true;
      pending = run('inspect', input).finally(() => {
        pending = null;
        inspecting = false;
      });
      return pending;
    },
    async compare(input) {
      if (!validCompare(input)) return { status: 400, body: { error: 'invalid-request' } };
      if (pending || reviewing) return { status: 409, body: { error: 'busy' } };
      inspecting = true;
      pending = run('compare', { ...input }).finally(() => {
        pending = null;
        inspecting = false;
      });
      return pending;
    },
    async signalState(input) {
      if (!validInspect(input)) return invalid();
      return exclusive(() => run('signal-state', { ...input }));
    },
    async signalPreview(input) {
      if (!validSignalPreview(input)) return invalid();
      input = Object.freeze({ ...input });
      let schema;
      try {
        schema = await loadSchema();
      } catch {
        return { status: 503, body: { error: 'engine-unavailable' } };
      }
      if (typeof schema.signalReasonMatches !== 'function')
        return { status: 503, body: { error: 'engine-unavailable' } };
      if (!schema.signalReasonMatches(input.decision, input.reason)) return invalid();
      return exclusive(async () => {
        prune();
        if (plans.size >= 8) return { status: 409, body: { error: 'signal-preview-limit' } };
        const response = await run('signal-preview', input);
        if (response.status !== 200) return response;
        const state = response.body,
          previewId = randomUUID(),
          expiresAt = Date.parse(state.generatedAt) + 120000;
        const preview = {
          schema: 'stroq-inventory-signal-preview/1',
          source: 'local',
          workspaceId: state.workspaceId,
          previewId,
          expiresAt: new Date(expiresAt).toISOString(),
          decision: input.decision,
          reason: input.reason,
          expectedDecisionId: input.expectedDecisionId,
          state,
          limitations: schema.INVENTORY_SIGNAL_LIMITATIONS,
        };
        if (closed || Date.now() >= expiresAt || !schema.validateInventorySignalPreview(preview))
          return { status: 503, body: { error: 'inventory-unavailable' } };
        plans.set(
          previewId,
          Object.freeze({
            expiresAt,
            binding: structuredClone(state.binding),
            decision: input.decision,
            reason: input.reason,
            expectedDecisionId: input.expectedDecisionId,
          }),
        );
        return { status: 200, body: preview };
      });
    },
    async signalApply(input) {
      if (
        !fields(input, ['previewId', 'acknowledgeSignalOnly']) ||
        !uuid(input.previewId) ||
        input.acknowledgeSignalOnly !== true
      )
        return invalid();
      const previewId = input.previewId;
      return exclusive(async () => {
        const plan = plans.get(previewId);
        plans.delete(previewId);
        prune();
        if (!plan || plan.expiresAt <= Date.now()) return conflict();
        const deadline = Math.min(Date.now() + timeoutMs, plan.expiresAt);
        try {
          const schema = await loadSchema();
          const { withLock } = await import(pathToFileURL(CORE).href);
          if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
          // Only an explicit, live preview can create this private metadata store.
          await ensureInventoryStore(resolve(home));
          return await withLock(
            join(resolve(home), 'console', 'inventory.lock'),
            async () => {
              if (closed) return { status: 503, body: { error: 'inventory-unavailable' } };
              if (Date.now() >= deadline) return conflict();
              const response = await run(
                'signal-apply',
                { ...plan, previewExpiresAt: plan.expiresAt, signalLockHeld: true },
                deadline,
              );
              if (response.status !== 200) return response;
              const state = response.body,
                record = state.decision;
              if (!record) return { status: 503, body: { error: 'inventory-unavailable' } };
              const receipt = {
                schema: 'stroq-inventory-signal-receipt/1',
                source: 'local',
                workspaceId: state.workspaceId,
                previewId,
                recordId: record.id,
                decision: record.decision,
                recordedAt: record.recordedAt,
                state,
                baselineChanged: false,
                permissionsChanged: false,
              };
              return schema.validateInventorySignalReceipt(receipt)
                ? { status: 200, body: receipt }
                : { status: 503, body: { error: 'inventory-unavailable' } };
            },
            { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
          );
        } catch {
          return {
            status: 503,
            body: { error: Date.now() >= deadline ? 'deadline-exceeded' : 'inventory-unavailable' },
          };
        }
      });
    },
    async close() {
      closed = true;
      plans.clear();
      controlPlans.clear();
      stop?.();
      await pending;
    },
  };
}
