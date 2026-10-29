import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { rootIdentity } from './agent-setup-files.mjs';
import { createRunStore } from './run-store.mjs';
import { captureHookConfiguration, sameHookCapture } from './hook-check-capture.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const AGENTS = ['claude-code', 'codex', 'cursor'];
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ERRORS = new Set([
  'engine-unavailable',
  'platform-unsupported',
  'configuration-unreadable',
  'hooks-not-configured',
  'policy-unavailable',
  'preview-stale',
  'preview-expired',
  'hook-check-busy',
  'history-unavailable',
  'deadline-exceeded',
  'output-limit',
  'server-stopped',
  'cancelled',
  'invalid-report',
  'cleanup-failed',
  'hook-check-failed',
]);
const HISTORY_ERRORS = [
  'unavailable',
  'unsafe-path',
  'invalid-history',
  'read-failed',
  'write-failed',
];
const MAX_MEMORY = 8 * 1024 * 1024;
const TTL = 120_000;
const hash = (v) => createHash('sha256').update(v).digest('hex');
const copy = (v) => structuredClone(v);
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const fail = (status, error) => ({ status, body: { error } });
const errorCode = (error) =>
  ERRORS.has(error?.message)
    ? error.message
    : error?.message === 'invalid-policy'
      ? 'policy-unavailable'
      : 'hook-check-failed';

/** Isolated hook executions have their own history and cannot become native-host proof. */
export async function createHookCheckService(configuration = {}) {
  const options = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome: homedir(),
    platform: process.platform,
    ...configuration,
  };
  options.home = resolve(options.home ?? join(options.userHome, '.stroq'));
  let roots = null;
  try {
    roots = {
      project: await rootIdentity(resolve(options.project)),
      user: await rootIdentity(resolve(options.userHome)),
    };
  } catch {
    /* Preview will report unavailable context. */
  }
  const selected = roots?.project.path ?? resolve(options.project);
  const workspaceId = `workspace-${hash(selected).slice(0, 24)}`;
  if (options.workspaceId !== undefined && options.workspaceId !== workspaceId)
    throw new TypeError('workspace-mismatch');
  const storeId = roots
    ? hash(`stroq-workspace/1\0${selected}\0${roots.project.dev}\0${roots.project.ino}`)
    : hash(`stroq-unavailable-workspace/1\0${selected}`);
  let schema = null;
  try {
    schema = await (
      options.loadValidator ??
      (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
    )();
  } catch {
    /* Missing validators cannot permit execution. */
  }
  const validJob = (job) =>
    schema?.validateHookCheckJob?.(job) === true && job.binding.workspaceId === workspaceId;
  const store = await (options.store ??
    createRunStore({
      home: options.home,
      workspaceId: storeId,
      namespace: 'hook-checks',
      loadValidator: async () => ({ validateRun: validJob }),
    }));
  let historyError = null;
  let jobs = new Map((store.runs ?? []).filter(validJob).map((job) => [job.id, copy(job)]));
  if (jobs.size !== (store.runs ?? []).length) {
    historyError = 'invalid-history';
    jobs = new Map();
  }
  const now = options.now ?? Date.now;
  const available = options.available ?? (() => engineAvailability(options.paths));
  const capture =
    options.capture ?? ((input) => captureHookConfiguration(input, options, roots, workspaceId));
  const run =
    options.run ??
    (async (input, extra) =>
      (await import('./hook-check-process.mjs')).executeHookCheck(input, extra));
  const plans = new Map(),
    expired = new Set(),
    operations = new Set();
  let memory = 0,
    busy = false,
    stopped = false,
    active = null,
    task = null,
    stopReason = null;
  const history = () => {
    const value = historyError ? { status: 'error', error: historyError } : store.state();
    return value.status === 'error'
      ? {
          status: 'error',
          error: HISTORY_ERRORS.includes(value.error) ? value.error : 'unavailable',
        }
      : { status: value.status === 'disabled' ? 'disabled' : 'ready' };
  };
  async function persist(next = [...jobs.values()]) {
    if (history().status !== 'ready') return false;
    try {
      return await store.write(next);
    } catch {
      historyError = 'write-failed';
      return false;
    }
  }
  let recovered = false;
  for (const [id, job] of jobs)
    if (job.status === 'running') {
      recovered = true;
      jobs.set(id, {
        ...job,
        status: 'failed',
        error: 'server-stopped',
        finishedAt: new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString(),
      });
    }
  if (recovered) await persist();
  function removePlan(id, wasExpired = false) {
    const plan = plans.get(id);
    if (!plan) return;
    plans.delete(id);
    clearTimeout(plan.timer);
    memory -= plan.memoryBytes;
    if (wasExpired) {
      expired.add(id);
      while (expired.size > 32) expired.delete(expired.values().next().value);
    }
  }
  async function engine() {
    try {
      const value = await available();
      const validSchema = ['Binding', 'Job', 'Preview', 'Result', 'State'].every(
        (name) => typeof schema?.[`validateHookCheck${name}`] === 'function',
      );
      return validSchema &&
        ![process.execPath, options.paths.cli].some((path) => /["$`\\\r\n]/.test(path)) &&
        value?.available === true &&
        typeof value.version === 'string' &&
        value.version.length <= 100
        ? { available: true, version: value.version }
        : { available: false, version: null };
    } catch {
      return { available: false, version: null };
    }
  }
  async function getState() {
    return {
      schema: 'stroq-hook-checks/1',
      workspaceId,
      engine: await engine(),
      agents: AGENTS.map((id) => ({
        id,
        supported: options.platform !== 'win32',
        reason: options.platform === 'win32' ? 'platform-unsupported' : null,
      })),
      history: history(),
      jobs: [...jobs.values()].map(copy),
    };
  }
  async function current(input) {
    if (!roots) throw new Error('configuration-unreadable');
    const captured = await capture(input);
    if (
      !schema?.validateHookCheckBinding?.(captured?.binding) ||
      captured.binding.workspaceId !== workspaceId ||
      captured.binding.agent !== input.agent ||
      captured.binding.scope !== input.scope ||
      !(captured.policyText === null || typeof captured.policyText === 'string') ||
      !Number.isSafeInteger(captured.memoryBytes) ||
      captured.memoryBytes < 0 ||
      captured.memoryBytes > MAX_MEMORY
    )
      throw new Error('invalid-report');
    return captured;
  }
  async function preview(input) {
    if (
      !closed(input, ['agent', 'scope']) ||
      !AGENTS.includes(input.agent) ||
      !['project', 'user'].includes(input.scope)
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'hook-check-busy');
    busy = true;
    try {
      const info = await engine();
      let reason =
        options.platform === 'win32'
          ? 'platform-unsupported'
          : !info.available
            ? 'engine-unavailable'
            : history().status !== 'ready'
              ? 'history-unavailable'
              : null;
      let captured = null;
      if (reason === null)
        try {
          captured = await current(input);
        } catch (error) {
          reason = errorCode(error);
        }
      const created = now(),
        id = randomUUID();
      const body = {
        schema: 'stroq-hook-check-preview/1',
        id,
        ...input,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(created + TTL).toISOString(),
        engineVersion: info.version,
        canStart: reason === null,
        reason,
        binding: captured?.binding ?? null,
      };
      if (stopped) return fail(503, 'server-stopped');
      if (!schema?.validateHookCheckPreview?.(body)) return fail(503, 'invalid-report');
      if (captured) {
        for (const [key, plan] of plans) if (plan.expires <= created) removePlan(key, true);
        while (plans.size >= 8 || memory + captured.memoryBytes > MAX_MEMORY)
          removePlan(plans.keys().next().value);
        const timer = setTimeout(() => removePlan(id, true), TTL);
        timer.unref();
        plans.set(id, {
          captured,
          body,
          expires: created + TTL,
          memoryBytes: captured.memoryBytes,
          timer,
        });
        memory += captured.memoryBytes;
      }
      return { status: 200, body: copy(body) };
    } finally {
      busy = false;
    }
  }
  async function assertCurrent(plan, adopt = false) {
    if (stopped) throw new Error('server-stopped');
    const info = await engine();
    if (!info.available || info.version !== plan.body.engineVersion)
      throw new Error('preview-stale');
    let fresh;
    try {
      fresh = await current({ agent: plan.body.agent, scope: plan.body.scope });
    } catch {
      throw new Error('preview-stale');
    }
    if (!(await sameHookCapture(plan.captured, fresh, adopt))) throw new Error('preview-stale');
    return fresh;
  }
  async function finish(job, next) {
    const retained = new Map(jobs);
    retained.set(job.id, next);
    if (await persist([...retained.values()])) jobs = retained;
    else
      jobs.set(job.id, {
        ...job,
        status: 'failed',
        finishedAt: new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString(),
        error: 'history-unavailable',
      });
  }
  function launch(plan, job) {
    const controller = new AbortController();
    active = { id: job.id, controller };
    stopReason = null;
    task = Promise.resolve()
      .then(async () => {
        await assertCurrent(plan);
        if (controller.signal.aborted) throw new Error(stopReason ?? 'cancelled');
        const result = await run(
          {
            agent: job.binding.agent,
            policyText: plan.captured.policyText,
            policySemanticSha256: job.binding.policySemanticSha256,
          },
          {
            adapterPath: options.adapterPath ?? runtimeLayout().adapter('hook-check-engine.js'),
            cliPath: options.paths.cli,
            signal: controller.signal,
            timeoutMs: options.timeoutMs,
          },
        );
        if (controller.signal.aborted) throw new Error(stopReason ?? 'cancelled');
        await assertCurrent(plan);
        const wrapped = {
          ...result,
          evidence: 'isolated-hook-execution',
          isolated: true,
          providerRequests: 0,
          hostEnforcement: false,
        };
        const completed = {
          ...job,
          status: 'completed',
          finishedAt: new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString(),
          result: wrapped,
        };
        if (!validJob(completed)) throw new Error('invalid-report');
        await finish(job, completed);
      })
      .catch(async (error) => {
        const code = stopReason ?? errorCode(error);
        await finish(job, {
          ...job,
          status: code === 'cancelled' ? 'cancelled' : 'failed',
          finishedAt: new Date(Math.max(now(), Date.parse(job.startedAt))).toISOString(),
          error: code,
        });
      })
      .finally(() => {
        active = null;
        task = null;
        stopReason = null;
      });
    return { status: 202, body: copy(job) };
  }
  async function start(input) {
    if (
      !closed(input, ['previewId']) ||
      typeof input.previewId !== 'string' ||
      !UUID.test(input.previewId)
    )
      return fail(400, 'invalid-request');
    if (stopped) return fail(503, 'server-stopped');
    if (busy || active) return fail(409, 'hook-check-busy');
    if (history().status !== 'ready') return fail(503, 'history-unavailable');
    const plan = plans.get(input.previewId);
    if (!plan) return fail(409, expired.has(input.previewId) ? 'preview-expired' : 'preview-stale');
    removePlan(input.previewId);
    if (plan.expires <= now()) return fail(409, 'preview-expired');
    busy = true;
    try {
      await assertCurrent(plan);
      const job = {
        schema: 'stroq-hook-check-job/1',
        id: randomUUID(),
        previewId: input.previewId,
        binding: plan.body.binding,
        status: 'running',
        startedAt: new Date(now()).toISOString(),
      };
      const previous = jobs;
      jobs = new Map([...jobs].slice(-31));
      jobs.set(job.id, job);
      if (!(await persist())) {
        jobs = previous;
        return fail(503, 'history-unavailable');
      }
      try {
        plan.captured = await assertCurrent(plan, true);
      } catch (error) {
        await finish(job, {
          ...job,
          status: 'failed',
          error: errorCode(error),
          finishedAt: job.startedAt,
        });
        throw error;
      }
      return launch(plan, job);
    } catch (error) {
      return fail(409, errorCode(error));
    } finally {
      busy = false;
    }
  }
  async function cancel(input) {
    if (!closed(input, ['jobId']) || typeof input.jobId !== 'string' || !UUID.test(input.jobId))
      return fail(400, 'invalid-request');
    if (!jobs.has(input.jobId)) return fail(404, 'not-found');
    if (active?.id === input.jobId) {
      stopReason = 'cancelled';
      active.controller.abort();
      await task;
    }
    return { status: 200, body: copy(jobs.get(input.jobId)) };
  }
  function track(work) {
    operations.add(work);
    work.finally(() => operations.delete(work)).catch(() => undefined);
    return work;
  }
  return {
    getState,
    preview: (input) => track(preview(input)),
    start: (input) => track(start(input)),
    cancel,
    getJob: (id) =>
      typeof id === 'string' && UUID.test(id) && jobs.has(id) ? copy(jobs.get(id)) : null,
    async close() {
      stopped = true;
      for (const id of plans.keys()) removePlan(id);
      expired.clear();
      if (active) {
        stopReason ??= 'server-stopped';
        active.controller.abort();
      }
      await Promise.allSettled([...operations, ...(task ? [task] : [])]);
    },
  };
}
