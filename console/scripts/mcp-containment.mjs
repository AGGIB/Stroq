import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runtimeLayout } from './runtime-layout.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { runtimeDigest as hashRuntime } from './agent-setup-cli.mjs';
import { prepareApplyLock } from './mcp-containment-files.mjs';

const layout = runtimeLayout();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const previewRequest = (v) =>
  ['remove-registration', 'protect-registration'].includes(v?.action)
    ? closed(v, [
        'action',
        'id',
        'expectedSha256',
        ...(Object.hasOwn(v, 'toolApproval') ? ['toolApproval'] : []),
      ]) &&
      (!Object.hasOwn(v, 'toolApproval') ||
        (v.action === 'protect-registration' && v.toolApproval === true)) &&
      typeof v.id === 'string' &&
      /^item-[a-f0-9]{24}$/.test(v.id) &&
      typeof v.expectedSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(v.expectedSha256)
    : v?.action === 'restore-registration' &&
      closed(v, ['action', 'recordId']) &&
      typeof v.recordId === 'string' &&
      UUID.test(v.recordId);
const applyRequest = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  ['previewId', 'confirm', 'acknowledgeSessionLimits', 'acknowledgePrivateRetention'].every((key) =>
    Object.hasOwn(v, key),
  ) &&
  Object.keys(v).every((key) =>
    [
      'previewId',
      'confirm',
      'acknowledgeSessionLimits',
      'acknowledgePrivateRetention',
      'acknowledgeProxyEffects',
      'acknowledgeSharedPolicyContext',
      'acknowledgeToolContracts',
    ].includes(key),
  ) &&
  (!Object.hasOwn(v, 'acknowledgeProxyEffects') || v.acknowledgeProxyEffects === true) &&
  (!Object.hasOwn(v, 'acknowledgeSharedPolicyContext') ||
    v.acknowledgeSharedPolicyContext === true) &&
  (!Object.hasOwn(v, 'acknowledgeToolContracts') || v.acknowledgeToolContracts === true) &&
  typeof v.previewId === 'string' &&
  UUID.test(v.previewId) &&
  v.confirm === true &&
  v.acknowledgeSessionLimits === true &&
  v.acknowledgePrivateRetention === true;
const statusOf = (error) =>
  error === 'invalid-request'
    ? 400
    : error === 'mcp-containment-recovery-required'
      ? 422
      : [
            'mcp-containment-busy',
            'mcp-containment-conflict',
            'mcp-containment-full',
            'mcp-containment-preview-missing',
            'mcp-containment-preview-expired',
            'mcp-containment-preview-stale',
          ].includes(error)
        ? 409
        : 503;
const fail = (error) => ({ status: statusOf(error), body: { error } });
const known = new Set([
  'mcp-containment-conflict',
  'mcp-containment-unsupported',
  'mcp-containment-full',
  'mcp-containment-preview-stale',
  'mcp-containment-recovery-required',
  'mcp-containment-unavailable',
  'deadline-exceeded',
]);

/** Only fixed workers and server-selected roots. Fixture options never come from browser input. */
export function createMcpContainmentService({
  project = layout.repository,
  userHome = homedir(),
  home = join(userHome, '.stroq'),
  paths = ENGINE_PATHS,
  workerPath = layout.adapter('mcp-containment-worker.js'),
  timeoutMs = 25_000,
  now = Date.now,
  runtimeDigest = () => hashRuntime(paths),
  platform = process.platform,
  mcpEnvironment = {},
  fault = null,
} = {}) {
  let stopped = false,
    pending = null,
    stop = null;
  const plans = new Map();
  async function currentRuntime() {
    const value = await runtimeDigest();
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      throw new Error('engine-unavailable');
    return value;
  }
  async function run(operation, input = {}, deadline = Date.now() + timeoutMs) {
    let validate;
    try {
      const s = await lstat(workerPath);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 16 * 1024 * 1024) throw new Error();
      const schema = await import(pathToFileURL(layout.adapter('mcp-containment-schema.js')).href);
      validate =
        operation === 'state'
          ? schema.validateMcpContainmentState
          : operation === 'preview'
            ? schema.validateMcpContainmentPreview
            : schema.validateMcpContainmentReceipt;
      if (typeof validate !== 'function') throw new Error();
    } catch {
      return fail('engine-unavailable');
    }
    if (stopped) return fail('server-stopped');
    if (Date.now() >= deadline) return fail('deadline-exceeded');
    return new Promise((resolveRun) => {
      const worker = new Worker(workerPath, {
        workerData: { operation, project, userHome, platform, mcpEnvironment, deadline, ...input },
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
        await worker.terminate().catch(() => undefined);
        resolveRun(response);
      };
      const timer = setTimeout(
        () => finish(fail('deadline-exceeded')),
        Math.max(1, deadline - Date.now()),
      );
      stop = () => finish(fail('server-stopped'));
      worker.stdout.resume();
      worker.stderr.resume();
      worker.once('message', (value) => {
        try {
          if (closed(value, ['error']) && known.has(value.error)) return finish(fail(value.error));
          if (
            !closed(value, operation === 'preview' ? ['kind', 'body', 'plan'] : ['kind', 'body']) ||
            value.kind !== (operation === 'preview' ? 'plan' : 'result') ||
            JSON.stringify(value).length > 512 * 1024 ||
            !validate(value.body) ||
            (operation === 'preview' &&
              (!value.plan ||
                typeof value.plan !== 'object' ||
                JSON.stringify(value.plan).length > 16 * 1024))
          )
            return finish(fail('mcp-containment-unavailable'));
          finish({
            status: 200,
            body: value.body,
            ...(operation === 'preview' ? { plan: value.plan } : {}),
          });
        } catch {
          finish(fail('mcp-containment-unavailable'));
        }
      });
      worker.once('error', () => finish(fail('mcp-containment-unavailable')));
      worker.once('exit', () => finish(fail('mcp-containment-unavailable')));
    });
  }
  async function exclusive(operation) {
    if (stopped) return fail('server-stopped');
    if (pending) return fail('mcp-containment-busy');
    pending = operation().catch((error) =>
      fail(
        error.message === 'engine-unavailable'
          ? error.message
          : /^lock timeout:/.test(error.message)
            ? 'mcp-containment-busy'
            : known.has(error.message)
              ? error.message
              : 'mcp-containment-unavailable',
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
        let fingerprint = null;
        try {
          fingerprint = await currentRuntime();
        } catch {
          /* Retain read-only history. */
        }
        return run('state', {
          runtimeAvailable: fingerprint !== null,
          runtime:
            fingerprint === null
              ? null
              : {
                  fingerprint,
                  command: process.execPath,
                  entry: paths.cli,
                  home: resolve(home),
                  userHome: resolve(userHome),
                },
        });
      });
    },
    preview(input) {
      if (!previewRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const deadline = Date.now() + timeoutMs,
          runtime = await currentRuntime(),
          id = randomUUID(),
          created = now();
        const response = await run(
          'preview',
          {
            input,
            runtime: {
              fingerprint: runtime,
              command: process.execPath,
              entry: paths.cli,
              home: resolve(home),
              userHome: resolve(userHome),
            },
            previewId: id,
            recordId: randomUUID(),
            createdAt: new Date(created).toISOString(),
            expiresAt: new Date(created + 120_000).toISOString(),
          },
          deadline,
        );
        if (response.status !== 200) return response;
        if (runtime !== (await currentRuntime())) return fail('mcp-containment-preview-stale');
        if (stopped) return fail('server-stopped');
        for (const [key, value] of plans) if (value.expires <= created) plans.delete(key);
        while (plans.size >= 8) plans.delete(plans.keys().next().value);
        plans.set(id, { plan: response.plan, runtime, expires: created + 120_000 });
        return { status: 200, body: response.body };
      });
    },
    apply(input) {
      if (!applyRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const selected = plans.get(input.previewId);
        if (!selected) return fail('mcp-containment-preview-missing');
        if (
          (selected.plan.proxy !== null && input.acknowledgeProxyEffects !== true) ||
          (selected.plan.action === 'protect-registration' &&
            selected.plan.proxy?.toolApproval === true &&
            input.acknowledgeToolContracts !== true) ||
          (selected.plan.action === 'protect-registration' &&
            selected.plan.artifact.scope === 'user' &&
            input.acknowledgeSharedPolicyContext !== true)
        )
          return fail('invalid-request');
        plans.delete(input.previewId);
        if (selected.expires <= now()) return fail('mcp-containment-preview-expired');
        const deadline = Date.now() + timeoutMs;
        if (selected.runtime !== (await currentRuntime()))
          return fail('mcp-containment-preview-stale');
        if (stopped) return fail('server-stopped');
        const { withLock } = await import(pathToFileURL(layout.core).href);
        const lock = await prepareApplyLock(userHome);
        return withLock(
          lock.path,
          async () => {
            if (stopped) return fail('server-stopped');
            if (Date.now() >= deadline) return fail('deadline-exceeded');
            if (selected.runtime !== (await currentRuntime()))
              return fail('mcp-containment-preview-stale');
            return run(
              'apply',
              {
                plan: selected.plan,
                previewId: input.previewId,
                fault,
                runtime: {
                  fingerprint: selected.runtime,
                  command: process.execPath,
                  entry: paths.cli,
                  home: resolve(home),
                  userHome: resolve(userHome),
                },
              },
              deadline,
            );
          },
          { timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())), fs: lock.fs },
        );
      });
    },
    async close() {
      stopped = true;
      plans.clear();
      stop?.();
      await pending;
    },
  };
}
