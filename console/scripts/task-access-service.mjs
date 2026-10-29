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
import { taskAccessError as codeOf, taskAccessStatus as statusOf } from './task-access-errors.mjs';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ID = /^task-[a-f0-9]{64}$/;
const TTL = 120_000,
  MAX_MEMORY = 8 * 1024 * 1024;
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const hash = (v) => createHash('sha256').update(v).digest('hex');
const response = (status, error) => ({ status, body: { error } });

/** A private, single-use approval plan; no signing key enters the parent process. */
export async function createTaskAccessService(configuration = {}) {
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
    /* Explicit context refusal. */
  }
  const project = roots?.project.path ?? resolve(options.project);
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  if (options.workspaceId !== undefined && options.workspaceId !== workspaceId)
    throw new TypeError('workspace-mismatch');
  try {
    schema = await (
      options.loadValidator ??
      (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
    )();
  } catch {
    /* Unbuilt engine never authorizes signing. */
  }
  const now = options.now ?? Date.now,
    available = options.available ?? (() => engineAvailability(options.paths));
  const digest = options.runtimeDigest ?? (() => runtimeDigest(options.paths)),
    lock = options.withLock ?? withAgentConfigurationLock;
  const plans = new Map(),
    expired = new Set(),
    operations = new Set();
  let memory = 0,
    busy = false,
    stopped = false,
    controller = null;
  const validate = (kind, value) => schema?.[`validateTaskAccess${kind}`]?.(value) === true;
  function forget(id, didExpire = false) {
    const plan = plans.get(id);
    if (!plan) return;
    clearTimeout(plan.timer);
    plans.delete(id);
    memory -= plan.bytes;
    if (didExpire) {
      expired.add(id);
      while (expired.size > 32) expired.delete(expired.values().next().value);
    }
  }
  async function context() {
    if (stopped) throw new Error('server-stopped');
    if (options.platform === 'win32') throw new Error('platform-unsupported');
    if (!roots) throw new Error('context-unavailable');
    try {
      if (
        !isDeepStrictEqual(
          { project: await rootIdentity(project), user: await rootIdentity(roots.user.path) },
          roots,
        )
      )
        throw new Error();
    } catch {
      throw new Error('context-unavailable');
    }
    if (
      !['Preview', 'Receipt', 'State'].every(
        (kind) => typeof schema?.[`validateTaskAccess${kind}`] === 'function',
      ) ||
      !Array.isArray(schema?.TASK_ACCESS_LIMITATIONS)
    )
      throw new Error('runtime-unavailable');
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
      return { engineVersion: info.version, runtimeSha256: runtime };
    } catch {
      throw new Error('runtime-unavailable');
    }
  }
  async function assertBound(bound, afterWrite = false) {
    try {
      if (!isDeepStrictEqual(bound, await context())) throw new Error();
    } catch {
      throw new Error(afterWrite ? 'write-unconfirmed' : 'preview-stale');
    }
  }
  function worker(operation, input, bound, extra = {}) {
    const { at, ...rest } = extra;
    return executeTaskLock(operation, input, {
      workerPath: options.workerPath,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      context: {
        project,
        userHome: roots.user.path,
        home: options.home,
        workspaceId,
        rootBindings: roots,
        platform: options.platform,
        paths: options.paths,
        ...bound,
        now: new Date(at ?? now()).toISOString(),
        configurationLockHeld: operation === 'access-issue',
      },
      ...rest,
    });
  }
  async function metadata(input) {
    if (typeof options.selectEvidence !== 'function') throw new Error('refusal-unavailable');
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
  async function preview(input) {
    if (
      !closed(input, ['id', 'expectedEvidenceSha']) ||
      typeof input.expectedEvidenceSha !== 'string' ||
      !SHA.test(input.expectedEvidenceSha) ||
      input.id !== `incident-${input.expectedEvidenceSha}`
    )
      return response(400, 'invalid-request');
    input = Object.freeze({ ...input });
    const bound = await context(),
      source = await metadata(input),
      created = now();
    const made = await worker('access-preview', source, bound, { at: created });
    await assertBound(bound);
    if (!isDeepStrictEqual(source, await metadata(input))) throw new Error('stale-evidence');
    if (
      !closed(made, ['task', 'operation', 'plan', 'grantExpiresAt']) ||
      !made.plan ||
      typeof made.plan !== 'object' ||
      Array.isArray(made.plan)
    )
      throw new Error('invalid-report');
    const expires = Math.min(created + TTL, Date.parse(made.grantExpiresAt));
    const body = {
      schema: 'stroq-task-access-preview/1',
      id: randomUUID(),
      workspaceId,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      grantExpiresAt: made.grantExpiresAt,
      incident: {
        id: source.id,
        evidenceSha256: source.expectedEvidenceSha,
        sequence: source.sequence,
        recordedAt: source.recordedAt,
      },
      task: made.task,
      operation: made.operation,
      limitations: schema.TASK_ACCESS_LIMITATIONS,
    };
    if (!validate('Preview', body)) throw new Error('invalid-report');
    if (stopped) throw new Error('server-stopped');
    if (now() >= expires) throw new Error('preview-expired');
    const bytes = serialize({ body, plan: made.plan, bound, source }).byteLength;
    if (bytes > MAX_MEMORY) throw new Error('invalid-report');
    for (const [id, plan] of plans) if (plan.expires <= now()) forget(id, true);
    while (plans.size >= 8 || memory + bytes > MAX_MEMORY) forget(plans.keys().next().value);
    const timer = setTimeout(() => forget(body.id, true), Math.max(1, expires - now()));
    timer.unref();
    plans.set(body.id, { body, plan: made.plan, bound, source, bytes, timer, expires });
    memory += bytes;
    return { status: 200, body: structuredClone(body) };
  }
  async function issue(input) {
    if (
      !closed(input, ['previewId', 'acknowledgeOneUse', 'acknowledgeSigningKeyUse']) ||
      typeof input.previewId !== 'string' ||
      !UUID.test(input.previewId) ||
      input.acknowledgeOneUse !== true ||
      input.acknowledgeSigningKeyUse !== true
    )
      return response(400, 'invalid-request');
    const plan = plans.get(input.previewId);
    if (!plan)
      return response(409, expired.has(input.previewId) ? 'preview-expired' : 'preview-stale');
    forget(input.previewId);
    if (plan.expires <= now()) return response(409, 'preview-expired');
    await assertBound(plan.bound);
    if (
      !isDeepStrictEqual(
        await metadata({
          id: plan.source.id,
          expectedEvidenceSha: plan.source.expectedEvidenceSha,
        }),
        plan.source,
      )
    )
      throw new Error('stale-evidence');
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
          if (plan.expires <= now()) throw new Error('preview-expired');
          if (
            !isDeepStrictEqual(
              await metadata({
                id: plan.source.id,
                expectedEvidenceSha: plan.source.expectedEvidenceSha,
              }),
              plan.source,
            )
          )
            throw new Error('stale-evidence');
          const receiptId = randomUUID();
          const body = await worker(
            'access-issue',
            { plan: plan.plan, previewId: input.previewId, receiptId },
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
            !isDeepStrictEqual(body.incident, plan.body.incident) ||
            body.taskId !== plan.body.task.id ||
            body.permitSha256 !== plan.body.task.permitSha256 ||
            body.fingerprint !== plan.body.operation.fingerprint ||
            body.issuedAt !== plan.body.createdAt ||
            body.expiresAt !== plan.body.grantExpiresAt
          )
            throw new Error('invalid-report');
          await assertBound(plan.bound, true);
          if (
            !isDeepStrictEqual(
              await metadata({
                id: plan.source.id,
                expectedEvidenceSha: plan.source.expectedEvidenceSha,
              }),
              plan.source,
            )
          )
            throw new Error('write-unconfirmed');
          return { status: 200, body: structuredClone(body) };
        },
        { timeoutMs: 3000 },
      );
    } catch (error) {
      const code = codeOf(error);
      if (
        launched &&
        ![
          'preview-stale',
          'preview-expired',
          'stale-evidence',
          'task-unavailable',
          'unsafe-source',
          'legacy-refusal',
          'refusal-unavailable',
          'operation-unavailable',
          'permission-unavailable',
          'permission-active',
          'signing-key-unavailable',
          'signing-key-mismatch',
          'write-unconfirmed',
        ].includes(code)
      )
        throw new Error('write-unconfirmed');
      throw new Error(code);
    }
  }
  async function getState(input) {
    if (
      !closed(input, ['id', 'expectedPermitSha256']) ||
      typeof input.id !== 'string' ||
      !ID.test(input.id) ||
      typeof input.expectedPermitSha256 !== 'string' ||
      !SHA.test(input.expectedPermitSha256)
    )
      return response(400, 'invalid-request');
    const bound = await context(),
      body = await worker('access-state', input, bound);
    await assertBound(bound);
    if (
      !validate('State', body) ||
      body.workspaceId !== workspaceId ||
      body.taskId !== input.id ||
      body.permitSha256 !== input.expectedPermitSha256
    )
      throw new Error('invalid-report');
    return { status: 200, body: structuredClone(body) };
  }
  async function exclusive(action, input) {
    if (stopped) return response(503, 'server-stopped');
    if (busy) return response(409, 'task-lock-busy');
    busy = true;
    controller = new AbortController();
    try {
      return await action(input);
    } catch (error) {
      const code = codeOf(error);
      return response(statusOf(code), code);
    } finally {
      busy = false;
      controller = null;
    }
  }
  function track(action, input) {
    const operation = exclusive(action, input);
    operations.add(operation);
    operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  }
  return {
    preview: (input) => track(preview, input),
    issue: (input) => track(issue, input),
    getState: (input) => track(getState, input),
    close: async () => {
      stopped = true;
      controller?.abort();
      for (const id of plans.keys()) forget(id);
      await Promise.allSettled([...operations]);
    },
  };
}
