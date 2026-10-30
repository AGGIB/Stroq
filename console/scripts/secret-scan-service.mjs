import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { executeSecretScan } from './secret-scan-process.mjs';
import { closedSecretObject as closed, validSecretReport } from './secret-scan-safe.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const TTL = 120_000;
const fail = (status, error) => ({ status, body: { error } });
const ERRORS = [
  'engine-unavailable',
  'input-limit',
  'deadline-exceeded',
  'output-limit',
  'cancelled',
  'invalid-report',
  'server-stopped',
];
const safeError = (error) => (ERRORS.includes(error?.message) ? error.message : 'scan-failed');

function environmentSnapshot(source) {
  const entries = Object.entries(source).filter(([, value]) => typeof value === 'string');
  if (entries.length > 2048 || Buffer.byteLength(JSON.stringify(entries)) > 512 * 1024)
    throw new Error('input-limit');
  return Object.fromEntries(entries);
}

// Only explicit session-layout settings are inspected before consent. Do not enumerate
// credential-shaped environment values until launch has accepted the exact preview.
function environmentContext(source) {
  return Object.fromEntries(
    ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'APPDATA'].flatMap((name) => {
      const value = source[name];
      if (value === undefined || value === '') return [];
      if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/.test(value))
        throw new Error('input-limit');
      return [[name, value]];
    }),
  );
}

/** This fingerprint reads executable code and directory identities, never credentials or transcripts. */
async function fingerprint(options) {
  const adapterRoot = await rootIdentity(resolve(options.adapter, '..'));
  const file = await snapshotFile(adapterRoot, options.adapter, 16 * 1024 * 1024);
  if (file.bytes === null) throw new Error('engine-unavailable');
  const hash = createHash('sha256')
    .update(await runtimeDigest(options.paths))
    .update(file.bytes);
  for (const root of [options.project, options.userHome]) {
    const real = await realpath(root);
    const identity = await lstat(real);
    if (!identity.isDirectory()) throw new Error('engine-unavailable');
    hash.update(real).update(String(identity.dev)).update(String(identity.ino));
  }
  return hash
    .update(resolve(options.home))
    .update(JSON.stringify(environmentContext(options.environment)))
    .digest('hex');
}

/** Preview is disclosure only. Credential reads begin after exact single-use consent. */
export async function createSecretScanService(options = {}) {
  const resolved = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome: homedir(),
    home: options.home ?? process.env.STROQ_HOME ?? join(options.userHome ?? homedir(), '.stroq'),
    adapter: runtimeLayout().adapter('secret-scan-engine.js'),
    environment: process.env,
    ...options,
  };
  const now = options.now ?? Date.now;
  const available =
    options.available ??
    (async () => {
      try {
        const s = await lstat(resolved.adapter);
        if (!s.isFile() || s.isSymbolicLink()) throw new Error();
      } catch {
        return { available: false, version: null };
      }
      return engineAvailability(resolved.paths);
    });
  const digest = options.fingerprint ?? (() => fingerprint(resolved));
  const run =
    options.run ??
    ((input, extra) =>
      executeSecretScan(input, {
        ...resolved,
        environment: environmentSnapshot(resolved.environment),
        ...extra,
      }));
  const plans = new Map();
  const jobs = new Map();
  const operations = new Set();
  const pending = new Set();
  let active = null;
  let stopped = false;
  let busy = false;
  const clone = (value) => structuredClone(value);

  async function getState() {
    return {
      schema: 'stroq-secrets/1',
      engine: await available(),
      jobs: [...jobs.values()].map(clone),
    };
  }

  async function preview(input) {
    if (!closed(input, ['scope']) || !['project', 'last'].includes(input.scope))
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'scan-busy');
    busy = true;
    try {
      const engine = await available();
      const runtime = engine.available ? await digest() : null;
      const created = now();
      const body = {
        schema: 'stroq-secrets-preview/1',
        id: randomUUID(),
        scope: input.scope,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + TTL).toISOString(),
        engineVersion: engine.version,
        canStart: engine.available,
        reason: engine.available ? null : 'engine-unavailable',
        disclosure: {
          credentialValuesInMemoryOnly: true,
          readsHomeCredentialFiles: true,
          readsEnvironmentCredentials: true,
          readsProjectEnvFiles: true,
          readsProjectAncestorEnvFiles: true,
          readsRelatedSessionEnvFiles: true,
          followsCredentialFileSymlinks: true,
          readsRegisteredCanaryFiles: true,
          readsAgentAndGitMetadata: true,
          readsReferencedSavedOutputs: true,
          readsSelectedProjectTranscripts: true,
          enumeratesSessionMetadata: true,
          readsCursorStoreForDiscovery: true,
          externalRequests: false,
          writesCredentials: false,
          deadlineMs: 120_000,
          heapLimitMiB: 256,
        },
      };
      if (stopped) return fail(503, 'server-stopped');
      for (const [id, plan] of plans) if (plan.expires <= created) plans.delete(id);
      while (plans.size >= 8) plans.delete(plans.keys().next().value);
      if (engine.available) plans.set(body.id, { body, runtime, expires: created + TTL });
      return { status: 200, body: clone(body) };
    } catch (error) {
      return fail(503, safeError(error));
    } finally {
      busy = false;
    }
  }

  function launch(plan) {
    const environment = environmentSnapshot(resolved.environment);
    const controller = new AbortController();
    const id = randomUUID();
    const job = {
      schema: 'stroq-secrets-job/1',
      id,
      scope: plan.body.scope,
      status: 'running',
      startedAt: new Date(now()).toISOString(),
    };
    while (jobs.size >= 8) jobs.delete(jobs.keys().next().value);
    jobs.set(id, job);
    active = { id, controller };
    const task = Promise.resolve()
      .then(() => run({ scope: job.scope }, { signal: controller.signal, environment }))
      .then((result) => {
        if (
          !controller.signal.aborted &&
          (!validSecretReport(result) || result.scope !== job.scope)
        )
          throw new Error('invalid-report');
        jobs.set(id, {
          ...job,
          status: controller.signal.aborted ? 'cancelled' : 'completed',
          finishedAt: new Date(now()).toISOString(),
          ...(controller.signal.aborted ? {} : { result: clone(result) }),
        });
      })
      .catch((error) =>
        jobs.set(id, {
          ...job,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          finishedAt: new Date(now()).toISOString(),
          ...(controller.signal.aborted ? {} : { error: safeError(error) }),
        }),
      )
      .finally(() => {
        if (active?.id === id) active = null;
        pending.delete(task);
      });
    pending.add(task);
    return { status: 202, body: clone(job) };
  }

  async function start(input) {
    if (
      !closed(input, ['previewId', 'acknowledgeCredentialRead']) ||
      typeof input.previewId !== 'string' ||
      !UUID.test(input.previewId) ||
      input.acknowledgeCredentialRead !== true
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'scan-busy');
    const plan = plans.get(input.previewId);
    if (!plan) return fail(409, 'preview-missing');
    plans.delete(input.previewId);
    if (plan.expires <= now()) return fail(409, 'preview-expired');
    busy = true;
    try {
      const engine = await available();
      if (
        !engine.available ||
        engine.version !== plan.body.engineVersion ||
        (await digest()) !== plan.runtime
      )
        return fail(409, 'preview-stale');
      if (stopped) return fail(503, 'server-stopped');
      if (plan.expires <= now()) return fail(409, 'preview-expired');
      return launch(plan);
    } catch (error) {
      return fail(409, safeError(error));
    } finally {
      busy = false;
    }
  }

  async function cancel(input) {
    if (!closed(input, ['jobId']) || typeof input.jobId !== 'string' || !UUID.test(input.jobId))
      return fail(400, 'invalid-request');
    if (!jobs.has(input.jobId)) return fail(404, 'not-found');
    if (active?.id === input.jobId) {
      active.controller.abort();
      await Promise.allSettled([...pending]);
    }
    return { status: 200, body: clone(jobs.get(input.jobId)) };
  }
  const track = (promise) => {
    operations.add(promise);
    void promise.finally(() => operations.delete(promise));
    return promise;
  };
  return {
    getState,
    preview: (input) => track(preview(input)),
    start: (input) => track(start(input)),
    cancel,
    getJob: (id) => (jobs.has(id) ? clone(jobs.get(id)) : null),
    async close() {
      stopped = true;
      plans.clear();
      active?.controller.abort();
      await Promise.allSettled([...operations, ...pending]);
    },
  };
}
