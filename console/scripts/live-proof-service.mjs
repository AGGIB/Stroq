import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { executeLiveEngine } from './live-proof-process.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const AGENTS = ['claude-code', 'codex', 'cursor'];
const TTL = 120_000;
const fail = (status, error) => ({ status, body: { error } });
const closed = (x, keys) =>
  x !== null &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((key) => Object.hasOwn(x, key));
const count = (x) => Number.isInteger(x) && x >= 3 && x <= 6;
const support = (agent, platform) =>
  !['claude-code', 'codex'].includes(agent)
    ? 'driver-unavailable'
    : (agent === 'codex') !== (platform === 'win32')
      ? 'platform-unmeasured'
      : null;
const errorCodes = new Set([
  'engine-unavailable',
  'configuration-unreadable',
  'preview-stale',
  'deadline-exceeded',
  'output-limit',
  'server-stopped',
  'cancelled',
  'invalid-report',
]);
const safeError = (error) => (errorCodes.has(error?.message) ? error.message : 'live-check-failed');

async function fileDigest(rootPath, suffix, limit = 1024 * 1024) {
  let at = rootPath;
  const file = join(rootPath, suffix);
  for (;;) {
    try {
      const root = await rootIdentity(at);
      return (await snapshotFile(root, join(root.path, relative(at, file)), limit)).sha256;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(at) === at)
        throw new Error('configuration-unreadable');
      at = dirname(at);
    }
  }
}

/** All executable chunks, adapter, policy and hook configuration are bound to the preview. */
async function fingerprint(input, options) {
  const files = [
    [
      dirname(options.adapter),
      options.adapter.slice(dirname(options.adapter).length + 1),
      16 * 1024 * 1024,
    ],
    [options.home, 'policy.yaml'],
    [options.home, 'install.json'],
  ];
  const environment = options.environment ?? process.env;
  if (input.agent === 'claude-code') {
    files.push(
      [options.userHome, '.claude/settings.json'],
      [options.project, '.claude/settings.json'],
      [options.project, '.claude/settings.local.json'],
    );
    if (environment.CLAUDE_CONFIG_DIR)
      files.push([resolve(environment.CLAUDE_CONFIG_DIR), 'settings.json']);
  } else {
    files.push(
      [options.userHome, '.codex/hooks.json'],
      [options.userHome, '.codex/config.toml'],
      [options.project, '.codex/hooks.json'],
      [options.project, '.codex/config.toml'],
    );
    if (environment.CODEX_HOME)
      files.push(
        [resolve(environment.CODEX_HOME), 'hooks.json'],
        [resolve(environment.CODEX_HOME), 'config.toml'],
      );
  }
  const hash = createHash('sha256').update(await runtimeDigest(options.paths));
  for (const [root, suffix, limit] of files)
    hash
      .update(root)
      .update('\0')
      .update(suffix)
      .update('\0')
      .update(await fileDigest(root, suffix, limit))
      .update('\0');
  return hash.digest('hex');
}

/** No live request is possible without a single-use, exact, current preview and explicit usage consent. */
export async function createLiveProofService(options = {}) {
  const resolved = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome: homedir(),
    home: options.home ?? process.env.STROQ_HOME ?? join(options.userHome ?? homedir(), '.stroq'),
    adapter: runtimeLayout().adapter('live-proof-engine.js'),
    platform: process.platform,
    ...options,
  };
  const now = options.now ?? Date.now;
  const available = options.available ?? (() => engineAvailability(resolved.paths));
  const inspect =
    options.inspect ??
    (async () => executeLiveEngine('inspect', { version: (await available()).version }, resolved));
  const detect =
    options.detect ??
    ((input) =>
      executeLiveEngine('detect', { agent: input.agent, cli: resolved.paths.cli }, resolved));
  const run =
    options.run ?? ((input, extra) => executeLiveEngine('run', input, { ...resolved, ...extra }));
  const digest = options.fingerprint ?? ((input) => fingerprint(input, resolved));
  const plans = new Map();
  const jobs = new Map();
  const pending = new Set();
  const operations = new Set();
  const shutdown = new AbortController();
  resolved.signal = shutdown.signal;
  const controllers = new Map();
  let stopped = false;
  let busy = false;
  let active = null;

  let statePending = null;
  let cachedState = null;
  let cachedAt = 0;
  async function readState() {
    const engine = await available();
    let proofs = {};
    if (engine.available) {
      try {
        proofs = (await inspect()).proofs;
      } catch {
        /* An unreadable record is never a pass. */
      }
    }
    return {
      schema: 'stroq-live/1',
      engine,
      target: 'isolated-host',
      agents: AGENTS.map((id) => ({
        id,
        supported: support(id, resolved.platform) === null,
        reason: support(id, resolved.platform),
        proof: proofs[id] ?? null,
      })),
      jobs: [...jobs.values()].map((job) => structuredClone(job)),
    };
  }

  function getState() {
    if (statePending) return statePending.then(structuredClone);
    if (cachedState && now() - cachedAt < 2000)
      return Promise.resolve(structuredClone({ ...cachedState, jobs: [...jobs.values()] }));
    statePending = readState()
      .then((state) => {
        cachedState = state;
        cachedAt = now();
        return state;
      })
      .finally(() => {
        statePending = null;
      });
    return statePending.then(structuredClone);
  }

  async function preview(input) {
    if (
      !closed(input, ['agent', 'maxRequests']) ||
      !['claude-code', 'codex'].includes(input.agent) ||
      !count(input.maxRequests)
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'live-check-busy');
    busy = true;
    try {
      const engine = await available();
      const platformReason = support(input.agent, resolved.platform);
      const reason = !engine.available ? 'engine-unavailable' : platformReason;
      const config = reason ? null : await inspect();
      const detected = reason ? null : await detect(input);
      const runtime = reason ? null : await digest(input);
      const created = now();
      const canStart =
        reason === null &&
        detected?.available === true &&
        typeof detected.version === 'string' &&
        typeof config?.policySha256 === 'string';
      const body = {
        schema: 'stroq-live-preview/1',
        id: randomUUID(),
        agent: input.agent,
        maxRequests: input.maxRequests,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + TTL).toISOString(),
        target: 'isolated-host',
        engineVersion: engine.version,
        hostVersion: detected?.version ?? null,
        policySha256: config?.policySha256 ?? null,
        supported: platformReason === null,
        canStart,
        reason: reason ?? (canStart ? null : 'host-not-found'),
        disclosure: {
          usesSubscription: true,
          maxRequests: input.maxRequests,
          externalRequests: true,
          temporaryProject: true,
          checks: ['allow', 'deny', 'control'],
          optionalSecretEgress: input.maxRequests >= 5,
        },
      };
      if (stopped) return fail(503, 'server-stopped');
      for (const [id, plan] of plans) if (plan.expires <= created) plans.delete(id);
      while (plans.size >= 8) plans.delete(plans.keys().next().value);
      if (canStart) plans.set(body.id, { body, runtime, expires: created + TTL });
      return { status: 200, body };
    } catch (error) {
      return fail(503, safeError(error));
    } finally {
      busy = false;
    }
  }

  function launch(plan) {
    const controller = new AbortController();
    const id = randomUUID();
    const job = {
      schema: 'stroq-live-job/1',
      id,
      agent: plan.body.agent,
      maxRequests: plan.body.maxRequests,
      status: 'running',
      startedAt: new Date(now()).toISOString(),
    };
    while (jobs.size >= 24) jobs.delete(jobs.keys().next().value);
    jobs.set(id, job);
    cachedState = null;
    controllers.set(id, controller);
    active = id;
    const task = Promise.resolve()
      .then(() =>
        run(
          {
            agent: job.agent,
            maxRequests: job.maxRequests,
            version: plan.body.engineVersion,
            cli: resolved.paths.cli,
            expected: { policySha256: plan.body.policySha256, hostVersion: plan.body.hostVersion },
            jobId: id,
          },
          { signal: controller.signal },
        ),
      )
      .then(
        (result) => {
          if (controller.signal.aborted)
            jobs.set(id, {
              ...job,
              status: 'cancelled',
              finishedAt: new Date(now()).toISOString(),
            });
          else
            jobs.set(id, {
              ...job,
              status: 'completed',
              finishedAt: new Date(now()).toISOString(),
              result,
            });
        },
        (error) => {
          jobs.set(id, {
            ...job,
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            finishedAt: new Date(now()).toISOString(),
            ...(controller.signal.aborted ? {} : { error: safeError(error) }),
          });
        },
      )
      .finally(() => {
        cachedState = null;
        controllers.delete(id);
        if (active === id) active = null;
        pending.delete(task);
      });
    pending.add(task);
    return { status: 202, body: structuredClone(job) };
  }

  async function start(input) {
    if (
      !closed(input, ['previewId', 'acknowledgeSubscriptionUsage', 'maxRequests']) ||
      !UUID.test(input.previewId) ||
      input.acknowledgeSubscriptionUsage !== true ||
      !count(input.maxRequests)
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'live-check-busy');
    const plan = plans.get(input.previewId);
    if (!plan) return fail(409, 'preview-missing');
    if (input.maxRequests !== plan.body.maxRequests) return fail(400, 'invalid-request');
    plans.delete(input.previewId);
    if (plan.expires <= now()) return fail(409, 'preview-expired');
    busy = true;
    try {
      const engine = await available();
      if (
        !engine.available ||
        engine.version !== plan.body.engineVersion ||
        (await digest(plan.body)) !== plan.runtime
      )
        return fail(409, 'preview-stale');
      const config = await inspect();
      const host = await detect(plan.body);
      if (
        config.policySha256 !== plan.body.policySha256 ||
        !host.available ||
        host.version !== plan.body.hostVersion ||
        (await digest(plan.body)) !== plan.runtime
      )
        return fail(409, 'preview-stale');
      if (plan.expires <= now()) return fail(409, 'preview-expired');
      if (stopped) return fail(503, 'server-stopped');
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
    const job = jobs.get(input.jobId);
    if (!job) return fail(404, 'not-found');
    controllers.get(input.jobId)?.abort();
    await Promise.allSettled([...pending]);
    return { status: 200, body: structuredClone(jobs.get(input.jobId)) };
  }

  function track(operation) {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
    return operation;
  }

  return {
    getState,
    preview: (input) => track(preview(input)),
    start: (input) => track(start(input)),
    cancel,
    getJob: (id) => (jobs.has(id) ? structuredClone(jobs.get(id)) : null),
    async close() {
      stopped = true;
      plans.clear();
      shutdown.abort();
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([
        ...operations,
        ...pending,
        ...(statePending ? [statePending] : []),
      ]);
    },
  };
}
