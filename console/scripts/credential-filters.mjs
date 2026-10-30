import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runtimeLayout } from './runtime-layout.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { runtimeDigest as hashRuntime } from './agent-setup-cli.mjs';
import { assertTargetContext } from './credential-filter-targets.mjs';

const layout = runtimeLayout(),
  TTL = 120000,
  MAX_PLAN = 2 * 1024 * 1024,
  MAX_PLANS_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TARGETS = ['claude-project', 'claude-user', 'cursor-project'];
const ACKS = [
  'acknowledgeNativeLimits',
  'acknowledgePrivateRetention',
  'acknowledgeWeakenFilter',
  'acknowledgeReformat',
  'acknowledgeLink',
  'acknowledgeCredentialLoss',
  'acknowledgeSharedScope',
];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) =>
  object(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const previewRequest = (v) =>
  closed(v, ['action', 'target']) &&
  ['apply-filter', 'undo-filter'].includes(v.action) &&
  TARGETS.includes(v.target);
const applyRequest = (v) =>
  object(v) &&
  ['previewId', 'confirm', 'acknowledgeNativeLimits', 'acknowledgePrivateRetention'].every((key) =>
    Object.hasOwn(v, key),
  ) &&
  Object.keys(v).every((key) => ['previewId', 'confirm', ...ACKS].includes(key)) &&
  UUID.test(v.previewId) &&
  v.confirm === true &&
  v.acknowledgeNativeLimits === true &&
  v.acknowledgePrivateRetention === true &&
  ACKS.every((key) => !Object.hasOwn(v, key) || v[key] === true);
const known = new Set([
  'credential-filter-unavailable',
  'credential-filter-conflict',
  'credential-filter-mixed-history',
  'credential-filter-unsupported-source',
  'credential-filter-context-unavailable',
  'credential-filter-engine-unavailable',
  'credential-filter-platform-unsupported',
  'credential-filter-source-invalid',
  'credential-filter-source-limit',
  'credential-filter-source-unsafe',
  'credential-filter-storage-unavailable',
  'credential-filter-edited-block',
  'credential-filter-preview-stale',
  'credential-filter-recovery-required',
  'invalid-request',
  'deadline-exceeded',
]);
const fail = (error) => ({
  status:
    error === 'invalid-request'
      ? 400
      : error === 'credential-filter-recovery-required'
        ? 422
        : /busy|conflict|preview-|mixed-history|edited-block/.test(error)
          ? 409
          : 503,
  body: { error },
});

/** Fixed targets/runtimes only. Private prepared plans are never accepted from HTTP. */
export function createCredentialFilterService({
  project = layout.repository,
  userHome = homedir(),
  home = join(userHome, '.stroq'),
  claudeConfigDir = '',
  platform = process.platform,
  paths = ENGINE_PATHS,
  workerPath = layout.adapter('credential-filter-worker.js'),
  enginePath = layout.adapter('credential-filter-engine.js'),
  schemaPath = layout.adapter('credential-filter-schema.js'),
  timeoutMs = 25000,
  now = Date.now,
  runtimeDigest = () => hashRuntime(paths),
  fault = null,
} = {}) {
  const options = {
    project: resolve(project),
    userHome: resolve(userHome),
    home: resolve(home),
    claudeConfigDir,
    platform,
  };
  let stopped = false,
    pending = null,
    stop = null,
    expiryTimer = null;
  const plans = new Map();
  function prunePlans() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    for (const [key, value] of plans) if (value.expires <= now()) plans.delete(key);
    if (plans.size) {
      expiryTimer = setTimeout(
        prunePlans,
        Math.max(1, Math.min(...[...plans.values()].map((value) => value.expires)) - now()),
      );
      expiryTimer.unref();
    }
  }
  async function runtime() {
    const value = await runtimeDigest();
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      throw new Error('credential-filter-engine-unavailable');
    return value;
  }
  async function version() {
    try {
      const s = await lstat(paths.package);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 65536) throw new Error();
      const value = JSON.parse(await readFile(paths.package, 'utf8')).version;
      if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[\w.-]{1,30})?$/.test(value))
        throw new Error();
      return value;
    } catch {
      throw new Error('credential-filter-engine-unavailable');
    }
  }
  async function run(operation, input, deadline) {
    let schema, engineVersion;
    try {
      const s = await lstat(workerPath);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 * 1024) throw new Error();
      schema = await import(pathToFileURL(schemaPath).href);
      engineVersion = await version();
    } catch {
      return fail('credential-filter-engine-unavailable');
    }
    if (stopped) return fail('server-stopped');
    if (Date.now() >= deadline) return fail('deadline-exceeded');
    return new Promise((resolveRun) => {
      const worker = new Worker(workerPath, {
        workerData: { operation, ...options, version: engineVersion, deadline, ...input },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
      let settled = false;
      const finish = async (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop = null;
        // Parent's real manifest lock remains held until no writer can run again.
        await worker.terminate().catch(() => undefined);
        resolveRun(response);
      };
      const uncertain =
        operation === 'apply'
          ? 'credential-filter-recovery-required'
          : 'credential-filter-unavailable';
      const timer = setTimeout(
        () => finish(fail(operation === 'apply' ? uncertain : 'deadline-exceeded')),
        Math.max(1, deadline - Date.now()),
      );
      stop = () => finish(fail('server-stopped'));
      worker.stdout.resume();
      worker.stderr.resume();
      worker.once('message', (value) => {
        try {
          if (closed(value, ['error']) && known.has(value.error)) return finish(fail(value.error));
          const isPreview = operation === 'preview',
            validate =
              operation === 'state'
                ? schema.validateCredentialFilters
                : isPreview
                  ? schema.validateCredentialFilterPreview
                  : schema.validateCredentialFilterReceipt;
          if (
            !closed(value, isPreview ? ['kind', 'body', 'plan'] : ['kind', 'body']) ||
            value.kind !== (isPreview ? 'plan' : 'result') ||
            typeof validate !== 'function' ||
            !validate(value.body) ||
            Buffer.byteLength(JSON.stringify(value.body), 'utf8') > 65536
          )
            return finish(fail(uncertain));
          const size = isPreview ? Buffer.byteLength(JSON.stringify(value.plan), 'utf8') : 0;
          if (isPreview && (!object(value.plan) || size > MAX_PLAN))
            return finish(fail('credential-filter-source-limit'));
          finish({
            status: 200,
            body: value.body,
            ...(isPreview ? { plan: value.plan, size } : {}),
          });
        } catch {
          finish(fail(uncertain));
        }
      });
      worker.once('error', () => finish(fail(uncertain)));
      worker.once('exit', () => finish(fail(uncertain)));
    });
  }
  async function exclusive(operation) {
    if (stopped) return fail('server-stopped');
    if (pending) return fail('credential-filter-busy');
    pending = operation().catch((error) =>
      fail(
        /^lock timeout:/.test(error.message)
          ? 'credential-filter-busy'
          : known.has(error.message)
            ? error.message
            : 'credential-filter-unavailable',
      ),
    );
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    state() {
      return exclusive(async () => {
        let runtimeAvailable = true;
        try {
          await runtime();
        } catch {
          runtimeAvailable = false;
        }
        return run('state', { runtimeAvailable }, Date.now() + timeoutMs);
      });
    },
    preview(input) {
      if (!previewRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const deadline = Date.now() + timeoutMs,
          fingerprint = await runtime(),
          id = randomUUID(),
          created = now(),
          expiresAt = new Date(created + TTL).toISOString();
        const result = await run('preview', { input, previewId: id, expiresAt }, deadline);
        if (result.status !== 200) return result;
        if (fingerprint !== (await runtime())) return fail('credential-filter-preview-stale');
        if (stopped) return fail('server-stopped');
        prunePlans();
        const heldBytes = () => [...plans.values()].reduce((sum, value) => sum + value.size, 0);
        while (plans.size && (plans.size >= 8 || heldBytes() + result.size > MAX_PLANS_BYTES))
          plans.delete(plans.keys().next().value);
        plans.set(id, {
          plan: result.plan,
          body: result.body,
          size: result.size,
          runtime: fingerprint,
          expires: created + TTL,
        });
        prunePlans();
        return { status: 200, body: result.body };
      });
    },
    apply(input) {
      if (!applyRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const selected = plans.get(input.previewId);
        if (!selected) return fail('credential-filter-preview-missing');
        if (
          (selected.body.action === 'undo-filter' && input.acknowledgeWeakenFilter !== true) ||
          Object.entries(selected.body.needs).some(
            ([key, required]) => required && input[key] !== true,
          )
        )
          return fail('invalid-request');
        plans.delete(input.previewId);
        prunePlans();
        if (selected.expires <= now()) return fail('credential-filter-preview-expired');
        const deadline = Date.now() + timeoutMs;
        if (selected.runtime !== (await runtime())) return fail('credential-filter-preview-stale');
        await assertTargetContext(options, selected.plan.resolved);
        const execute = async () => {
          if (stopped) return fail('server-stopped');
          if (selected.runtime !== (await runtime()))
            return fail('credential-filter-preview-stale');
          return run('apply', { plan: selected.plan, fault }, deadline);
        };
        if (selected.body.operation === 'unchanged') return execute();
        const s = await lstat(enginePath);
        if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 * 1024)
          return fail('credential-filter-engine-unavailable');
        const url = pathToFileURL(enginePath);
        url.searchParams.set('runtime', selected.runtime);
        const engine = await import(url.href);
        if (typeof engine.withManifestLock !== 'function')
          return fail('credential-filter-engine-unavailable');
        return engine.withManifestLock(
          { home: options.home, version: await version(), now: () => new Date() },
          execute,
          { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
        );
      });
    },
    async close() {
      stopped = true;
      plans.clear();
      clearTimeout(expiryTimer);
      expiryTimer = null;
      stop?.();
      await pending;
    },
  };
}
