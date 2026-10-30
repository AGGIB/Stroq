import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runtimeLayout } from './runtime-layout.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { runtimeDigest as hashRuntime } from './agent-setup-cli.mjs';
import { prepareApplyLock } from './skill-quarantine-paths.mjs';

const layout = runtimeLayout();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const closed = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.sort().join(',');
const previewRequest = (input) =>
  input?.action === 'quarantine'
    ? closed(input, ['action', 'id', 'expectedSha256']) &&
      typeof input.id === 'string' &&
      typeof input.expectedSha256 === 'string' &&
      /^item-[a-f0-9]{24}$/.test(input.id) &&
      /^[a-f0-9]{64}$/.test(input.expectedSha256)
    : input?.action === 'restore' &&
      closed(input, ['action', 'recordId']) &&
      typeof input.recordId === 'string' &&
      UUID.test(input.recordId);
const applyRequest = (input) =>
  closed(input, ['previewId', 'confirm', 'acknowledgeSessionLimits']) &&
  typeof input.previewId === 'string' &&
  UUID.test(input.previewId) &&
  input.confirm === true &&
  input.acknowledgeSessionLimits === true;
const statusOf = (error) =>
  error === 'invalid-request'
    ? 400
    : error === 'quarantine-recovery-required'
      ? 422
      : [
            'quarantine-busy',
            'quarantine-conflict',
            'quarantine-unsupported',
            'quarantine-full',
            'quarantine-preview-missing',
            'quarantine-preview-expired',
            'quarantine-preview-stale',
          ].includes(error)
        ? 409
        : 503;
const fail = (error) => ({ status: statusOf(error), body: { error } });
const known = new Set([
  'quarantine-conflict',
  'quarantine-unsupported',
  'quarantine-full',
  'quarantine-preview-stale',
  'quarantine-recovery-required',
  'quarantine-unavailable',
  'deadline-exceeded',
]);

/** Fixed adapters and server-selected roots only; internal options support fixture fault tests. */
export function createSkillQuarantine({
  project = layout.repository,
  userHome = homedir(),
  paths = ENGINE_PATHS,
  workerPath = layout.adapter('skill-quarantine-worker.js'),
  timeoutMs = 25_000,
  now = Date.now,
  runtimeDigest = null,
  fault = null,
} = {}) {
  const getRuntime = runtimeDigest ?? (() => hashRuntime(paths));
  const trustedPaths = Object.freeze({
    cli: paths.cli,
    package: paths.package,
    manifest: paths.manifest,
    manifestRoot: paths.manifestRoot,
  });
  let stopped = false;
  let pending = null;
  let stop = null;
  const plans = new Map();
  async function run(operation, input = {}, deadline = Date.now() + timeoutMs) {
    let validate;
    try {
      const file = await lstat(workerPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 16 * 1024 * 1024)
        throw new Error();
      const schema = await import(pathToFileURL(layout.adapter('skill-quarantine-schema.js')).href);
      validate =
        operation === 'read'
          ? schema.validateSkillQuarantine
          : operation === 'preview'
            ? schema.validateSkillQuarantinePreview
            : schema.validateSkillQuarantineReceipt;
      if (typeof validate !== 'function') throw new Error();
    } catch {
      return fail('engine-unavailable');
    }
    if (stopped) return fail('server-stopped');
    if (Date.now() >= deadline) return fail('deadline-exceeded');
    return new Promise((resolveRun) => {
      const worker = new Worker(workerPath, {
        workerData: { operation, project, userHome, deadline, ...input },
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
        // The main process owns the apply lock. Termination MUST precede its release.
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
            !validate(value.body)
          )
            return finish(fail('quarantine-unavailable'));
          finish({
            status: 200,
            body: value.body,
            ...(operation === 'preview' ? { plan: value.plan } : {}),
          });
        } catch {
          finish(fail('quarantine-unavailable'));
        }
      });
      worker.once('error', () => finish(fail('quarantine-unavailable')));
      worker.once('exit', () => finish(fail('quarantine-unavailable')));
    });
  }
  async function exclusive(operation) {
    if (stopped) return fail('server-stopped');
    if (pending) return fail('quarantine-busy');
    pending = operation().catch((error) =>
      fail(
        error.message === 'engine-unavailable'
          ? error.message
          : /^lock timeout:/.test(error.message)
            ? 'quarantine-busy'
            : 'quarantine-unavailable',
      ),
    );
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    read() {
      return exclusive(() => run('read'));
    },
    preview(input) {
      if (!previewRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const deadline = Date.now() + timeoutMs;
        const runtime = await getRuntime();
        const trustedRuntime = runtimeDigest === null ? runtime : await hashRuntime(trustedPaths);
        const id = randomUUID();
        const created = now();
        const response = await run(
          'preview',
          {
            input,
            previewId: id,
            recordId: randomUUID(),
            createdAt: new Date(created).toISOString(),
            expiresAt: new Date(created + 120_000).toISOString(),
          },
          deadline,
        );
        if (response.status !== 200) return response;
        if (
          runtime !== (await getRuntime()) ||
          (runtimeDigest !== null && trustedRuntime !== (await hashRuntime(trustedPaths)))
        )
          return fail('quarantine-preview-stale');
        if (stopped) return fail('server-stopped');
        for (const [key, value] of plans) if (value.expires <= created) plans.delete(key);
        while (plans.size >= 8) plans.delete(plans.keys().next().value);
        plans.set(id, { plan: response.plan, runtime, trustedRuntime, expires: created + 120_000 });
        return { status: 200, body: response.body };
      });
    },
    apply(input) {
      if (!applyRequest(input)) return Promise.resolve(fail('invalid-request'));
      return exclusive(async () => {
        const selected = plans.get(input.previewId);
        if (!selected) return fail('quarantine-preview-missing');
        plans.delete(input.previewId);
        if (selected.expires <= now()) return fail('quarantine-preview-expired');
        const realExpiresAt = Date.now() + Math.max(0, selected.expires - now());
        const deadline = Math.min(Date.now() + timeoutMs, realExpiresAt);
        if (selected.runtime !== (await getRuntime())) return fail('quarantine-preview-stale');
        if (runtimeDigest !== null && selected.trustedRuntime !== (await hashRuntime(trustedPaths)))
          return fail('quarantine-preview-stale');
        if (stopped) return fail('server-stopped');
        const { withLock } = await import(pathToFileURL(layout.core).href);
        const lock = await prepareApplyLock(userHome);
        return withLock(
          lock.path,
          async () => {
            if (stopped) return fail('server-stopped');
            if (selected.expires <= now()) return fail('quarantine-preview-expired');
            if (Date.now() >= deadline) return fail('deadline-exceeded');
            if (selected.runtime !== (await getRuntime())) return fail('quarantine-preview-stale');
            if (
              runtimeDigest !== null &&
              selected.trustedRuntime !== (await hashRuntime(trustedPaths))
            )
              return fail('quarantine-preview-stale');
            return run(
              'apply',
              {
                plan: selected.plan,
                previewId: input.previewId,
                fault,
                commitGuard: {
                  runtimeSha256: selected.trustedRuntime,
                  paths: trustedPaths,
                  expiresAt: realExpiresAt,
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
