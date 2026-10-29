import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { rootIdentity } from './agent-setup-files.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import { executeTaskLock } from './task-lock-runner.mjs';
import { createTaskLockPages } from './task-lock-pages.mjs';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ID = /^task-[a-f0-9]{64}$/;
const TTL = 120_000,
  MAX_MEMORY = 8 * 1024 * 1024;
const ERRORS = new Set([
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'task-unavailable',
  'preview-stale',
  'preview-expired',
  'task-lock-busy',
  'deadline-exceeded',
  'invalid-report',
  'server-stopped',
  'task-lock-failed',
  'write-unconfirmed',
  'unsafe-source',
  'stale-evidence',
  'task-page-stale',
  'task-page-expired',
  'task-lookup-limit',
  'invalid-request',
]);
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);
const fail = (status, error) => ({ status, body: { error } });
const codeOf = (error) =>
  ERRORS.has(error?.message)
    ? error.message
    : error?.message === 'agent-configuration-busy'
      ? 'task-lock-busy'
      : error?.message === 'agent-configuration-unavailable' ||
          error?.message === 'engine-unavailable'
        ? 'runtime-unavailable'
        : 'task-lock-failed';
const statusOf = (code) =>
  [
    'preview-stale',
    'preview-expired',
    'task-lock-busy',
    'stale-evidence',
    'task-page-stale',
    'task-page-expired',
  ].includes(code)
    ? 409
    : code === 'task-unavailable'
      ? 404
      : code === 'invalid-request'
        ? 400
        : code === 'deadline-exceeded'
          ? 504
          : [
                'platform-unsupported',
                'unsafe-source',
                'write-unconfirmed',
                'task-lookup-limit',
              ].includes(code)
            ? 422
            : 503;

/** The only mutation is the signed permit store's empty irreversible revoked marker. */
export async function createTaskLockService(configuration = {}) {
  const options = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome: homedir(),
    platform: process.platform,
    ...configuration,
  };
  options.home = resolve(options.home ?? join(options.userHome, '.stroq'));
  let roots = null,
    schema = null;
  try {
    roots = {
      project: await rootIdentity(resolve(options.project)),
      user: await rootIdentity(resolve(options.userHome)),
    };
  } catch {
    /* Unavailable context is explicit in read-only state. */
  }
  const selected = roots?.project.path ?? resolve(options.project);
  const workspaceId = `workspace-${hash(selected).slice(0, 24)}`;
  if (options.workspaceId !== undefined && options.workspaceId !== workspaceId)
    throw new TypeError('workspace-mismatch');
  try {
    schema = await (
      options.loadValidator ??
      (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
    )();
  } catch {
    /* Missing schema cannot authorize writes. */
  }
  const now = options.now ?? Date.now;
  const available = options.available ?? (() => engineAvailability(options.paths));
  const digest = options.runtimeDigest ?? (() => runtimeDigest(options.paths));
  const lock = options.withLock ?? withAgentConfigurationLock;
  const plans = new Map(),
    expired = new Set(),
    operations = new Set();
  let memory = 0,
    stopped = false,
    busy = false,
    controller = null;
  const validate = (kind, value) => schema?.[`validateTaskLock${kind}`]?.(value) === true;
  const hasSchema = () =>
    ['State', 'Row', 'Preview', 'Receipt'].every(
      (kind) => typeof schema?.[`validateTaskLock${kind}`] === 'function',
    ) && Array.isArray(schema?.TASK_LOCK_LIMITATIONS);
  function removePlan(id, timedOut = false) {
    const plan = plans.get(id);
    if (!plan) return;
    plans.delete(id);
    clearTimeout(plan.timer);
    memory -= plan.bytes;
    if (timedOut) {
      expired.add(id);
      while (expired.size > 32) expired.delete(expired.values().next().value);
    }
  }
  async function context() {
    if (stopped) throw new Error('server-stopped');
    if (options.platform === 'win32') throw new Error('platform-unsupported');
    if (!roots) throw new Error('context-unavailable');
    try {
      const fresh = {
        project: await rootIdentity(roots.project.path),
        user: await rootIdentity(roots.user.path),
      };
      if (!isDeepStrictEqual(fresh, roots)) throw new Error();
    } catch {
      throw new Error('context-unavailable');
    }
    if (!hasSchema()) throw new Error('runtime-unavailable');
    try {
      const info = await available(),
        runtime = await digest();
      if (
        info?.available !== true ||
        typeof info.version !== 'string' ||
        !info.version.length ||
        info.version.length > 100 ||
        !SHA.test(runtime)
      )
        throw new Error();
      return { runtimeSha256: runtime, engineVersion: info.version };
    } catch {
      throw new Error('runtime-unavailable');
    }
  }
  async function assertBound(bound, afterWrite = false) {
    try {
      if (!isDeepStrictEqual(await context(), bound)) throw new Error();
    } catch {
      throw new Error(afterWrite ? 'write-unconfirmed' : 'preview-stale');
    }
  }
  function worker(operation, input, bound, extra = {}) {
    const { at, ...runnerOptions } = extra;
    return executeTaskLock(operation, input, {
      workerPath: options.workerPath,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      context: {
        project: selected,
        userHome: roots.user.path,
        home: options.home,
        workspaceId,
        paths: options.paths,
        platform: options.platform,
        rootBindings: roots,
        ...bound,
        now: new Date(at ?? now()).toISOString(),
        configurationLockHeld: operation === 'apply',
      },
      ...runnerOptions,
    });
  }
  function unavailable(reason) {
    const body = {
      schema: 'stroq-task-locks/1',
      workspaceId,
      host: 'claude-code',
      checkedAt: new Date(now()).toISOString(),
      currentPolicySha256: null,
      available: false,
      reason,
      coverage: { complete: false, limited: true, unverified: 0, foreign: 0 },
      tasks: [],
      limitations: schema?.TASK_LOCK_LIMITATIONS,
    };
    if (!validate('State', body)) throw new Error('runtime-unavailable');
    return body;
  }
  const pages = createTaskLockPages({
    workspaceId,
    schema,
    now,
    context,
    worker,
    assertBound,
    unavailable,
  });
  async function page(input) {
    return { status: 200, body: await pages.select(input) };
  }
  async function getState() {
    let bound;
    try {
      bound = await context();
    } catch (error) {
      const code = codeOf(error);
      if (['runtime-unavailable', 'context-unavailable', 'platform-unsupported'].includes(code))
        return unavailable(code);
      throw new Error(code);
    }
    const body = await worker('state', {}, bound);
    if (!validate('State', body) || body.workspaceId !== workspaceId)
      throw new Error('invalid-report');
    try {
      const fresh = await context();
      if (!isDeepStrictEqual(fresh, bound)) return unavailable('runtime-unavailable');
    } catch (error) {
      const code = codeOf(error);
      if (['context-unavailable', 'runtime-unavailable', 'platform-unsupported'].includes(code))
        return unavailable(code);
      throw new Error(code);
    }
    return copy(body);
  }
  async function incidentMetadata(input) {
    const entry = await options.selectEvidence(input);
    if (
      !entry ||
      !Number.isSafeInteger(entry.seq) ||
      entry.seq < 1 ||
      typeof entry.ts !== 'string' ||
      !Number.isFinite(Date.parse(entry.ts)) ||
      new Date(entry.ts).toISOString() !== entry.ts
    )
      throw new Error('stale-evidence');
    return { ...input, sequence: entry.seq, recordedAt: entry.ts };
  }
  async function relateIncident(input) {
    if (
      !closed(input, ['id', 'expectedEvidenceSha']) ||
      typeof input.expectedEvidenceSha !== 'string' ||
      !SHA.test(input.expectedEvidenceSha) ||
      input.id !== `incident-${input.expectedEvidenceSha}`
    )
      return fail(400, 'invalid-request');
    if (
      typeof options.selectEvidence !== 'function' ||
      typeof schema?.validateIncidentTaskReport !== 'function'
    )
      throw new Error('runtime-unavailable');
    input = Object.freeze({ ...input });
    const bound = await context(),
      metadata = await incidentMetadata(input);
    const body = await worker('incident', metadata, bound);
    if (
      schema.validateIncidentTaskReport(body) !== true ||
      body.workspaceId !== workspaceId ||
      body.incident.id !== input.id ||
      body.incident.evidenceSha256 !== input.expectedEvidenceSha ||
      body.incident.sequence !== metadata.sequence ||
      body.incident.recordedAt !== metadata.recordedAt
    )
      throw new Error('invalid-report');
    if (!isDeepStrictEqual(await incidentMetadata(input), metadata))
      throw new Error('stale-evidence');
    if (stopped) throw new Error('server-stopped');
    await assertBound(bound);
    return { status: 200, body: copy(body) };
  }
  async function preview(input) {
    if (
      !closed(input, ['id', 'expectedPermitSha256']) ||
      typeof input.id !== 'string' ||
      !ID.test(input.id) ||
      typeof input.expectedPermitSha256 !== 'string' ||
      !SHA.test(input.expectedPermitSha256)
    )
      return fail(400, 'invalid-request');
    const bound = await context();
    const created = now(),
      made = await worker('preview', input, bound, { at: created });
    await assertBound(bound);
    if (
      !closed(made, ['task', 'plan', 'bindingSha256', 'canApply', 'reason']) ||
      made.plan === null ||
      typeof made.plan !== 'object' ||
      Array.isArray(made.plan)
    )
      throw new Error('invalid-report');
    const body = {
      schema: 'stroq-task-lock-preview/1',
      id: randomUUID(),
      workspaceId,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + TTL).toISOString(),
      task: made.task,
      bindingSha256: made.bindingSha256,
      canApply: made.canApply,
      reason: made.reason,
    };
    if (
      !validate('Preview', body) ||
      body.task.id !== input.id ||
      body.task.permitSha256 !== input.expectedPermitSha256
    )
      throw new Error('invalid-report');
    if (stopped) throw new Error('server-stopped');
    if (body.canApply) {
      const bytes = serialize({ body, plan: made.plan, bound }).byteLength;
      if (bytes > MAX_MEMORY) throw new Error('invalid-report');
      for (const [id, plan] of plans) if (plan.expires <= now()) removePlan(id, true);
      while (plans.size >= 8 || memory + bytes > MAX_MEMORY) removePlan(plans.keys().next().value);
      const timer = setTimeout(() => removePlan(body.id, true), Math.max(1, created + TTL - now()));
      timer.unref();
      plans.set(body.id, { body, plan: made.plan, bound, bytes, timer, expires: created + TTL });
      memory += bytes;
    }
    return { status: 200, body: copy(body) };
  }
  async function apply(input) {
    if (
      !closed(input, ['previewId', 'acknowledgeTaskInterruption']) ||
      typeof input.previewId !== 'string' ||
      !UUID.test(input.previewId) ||
      input.acknowledgeTaskInterruption !== true
    )
      return fail(400, 'invalid-request');
    const plan = plans.get(input.previewId);
    if (!plan) return fail(409, expired.has(input.previewId) ? 'preview-expired' : 'preview-stale');
    removePlan(input.previewId);
    if (plan.expires <= now()) return fail(409, 'preview-expired');
    await assertBound(plan.bound);
    let launched = false;
    try {
      return await lock(
        {
          home: options.home,
          version: plan.bound.engineVersion,
          runtime: plan.bound.runtimeSha256,
        },
        async () => {
          await assertBound(plan.bound);
          const receiptId = randomUUID();
          const body = await worker(
            'apply',
            {
              plan: plan.plan,
              previewId: input.previewId,
              receiptId,
              bindingSha256: plan.body.bindingSha256,
            },
            plan.bound,
            {
              onStart: () => {
                launched = true;
              },
            },
          );
          if (
            !validate('Receipt', body) ||
            body.id !== receiptId ||
            body.previewId !== input.previewId ||
            body.workspaceId !== workspaceId ||
            body.taskId !== plan.body.task.id ||
            body.permitSha256 !== plan.body.task.permitSha256
          )
            throw new Error('invalid-report');
          await assertBound(plan.bound, true);
          return { status: 200, body: copy(body) };
        },
        { timeoutMs: 3000 },
      );
    } catch (error) {
      const code = codeOf(error);
      if (
        launched &&
        !['preview-stale', 'task-unavailable', 'unsafe-source', 'write-unconfirmed'].includes(code)
      )
        throw new Error('write-unconfirmed');
      throw new Error(code);
    }
  }
  async function exclusive(action, input, read = false) {
    if (stopped) {
      if (read) throw new Error('server-stopped');
      return fail(503, 'server-stopped');
    }
    if (busy) {
      if (read) throw new Error('task-lock-busy');
      return fail(409, 'task-lock-busy');
    }
    busy = true;
    controller = new AbortController();
    try {
      return await action(input);
    } catch (error) {
      const code = codeOf(error);
      if (read) throw new Error(code);
      return fail(statusOf(code), code);
    } finally {
      busy = false;
      controller = null;
    }
  }
  function track(action, input, read = false) {
    const operation = exclusive(action, input, read);
    operations.add(operation);
    operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  }
  return {
    getState: () => track(getState, undefined, true),
    getPage: () => track(pages.first, undefined, true),
    page: (input) => track(page, input),
    preview: (input) => track(preview, input),
    relateIncident: (input) => track(relateIncident, input),
    apply: (input) => track(apply, input),
    async close() {
      stopped = true;
      pages.close();
      for (const id of plans.keys()) removePlan(id);
      expired.clear();
      controller?.abort();
      await Promise.allSettled([...operations]);
    },
  };
}
