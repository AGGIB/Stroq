import { randomUUID, createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { createWorkspaceReviewContext } from './workspace-review-context.mjs';
import { withAgentConfigurationLock } from './agent-configuration-lock.mjs';
import { validateWorkspaceReviewRun } from '../lib/workspace-review.ts';
import {
  WORKSPACE_TASK_ERRORS,
  WORKSPACE_TASK_SOURCE_ID,
  validateWorkspaceTaskPreview,
  validateWorkspaceTaskState,
  validateWorkspaceTaskRecord,
  type WorkspaceTaskError,
  type WorkspaceTaskPreview,
  type WorkspaceTaskRecord,
} from '../lib/workspace-task-controls.ts';
import { createTaskVerification } from './workspace-task-verification.ts';
import type { TaskPlan } from './workspace-task-transaction.ts';

const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const copy = <T>(v: T): T => structuredClone(v);
const fail = (error: string, status = 503) => ({ status, body: { error } });
function codeOf(error: unknown): WorkspaceTaskError {
  const code = (error as Error)?.message;
  const mapped: Record<string, string> = {
    'task-store-unavailable': 'history-unavailable',
    'task-store-full': 'recovery-full',
    'stale-task-source': 'stale-source',
    'task-recovery-required': 'recovery-required',
    'task-write-unconfirmed': 'write-unconfirmed',
    'task-preview-expired': 'preview-stale',
    'agent-configuration-busy': 'tasks-busy',
    'agent-configuration-unavailable': 'runtime-unavailable',
    'engine-unavailable': 'runtime-unavailable',
    'unsafe-config': 'unsafe-source',
    'preview-stale': 'stale-source',
  };
  const result = mapped[code] ?? code;
  return WORKSPACE_TASK_ERRORS.includes(result as WorkspaceTaskError)
    ? (result as WorkspaceTaskError)
    : 'task-controls-unavailable';
}
const statusOf = (code: WorkspaceTaskError) =>
  ['stale-capture', 'stale-source', 'preview-stale', 'tasks-busy', 'recovery-unavailable'].includes(
    code,
  )
    ? 409
    : [
          'unsupported-task-config',
          'no-automatic-tasks',
          'recovery-required',
          'recovery-full',
          'unsafe-source',
          'write-unconfirmed',
        ].includes(code)
      ? 422
      : code === 'deadline-exceeded'
        ? 504
        : 503;
interface StoredPlan {
  public: WorkspaceTaskPreview;
  plan: TaskPlan;
  bound: any;
  size: number;
}
/** One fixed local task source, private recovery, explicit one-use consent and real static rechecks. */
export async function createWorkspaceTaskControl(configuration: Record<string, any> = {}) {
  const ctx = configuration.context ?? (await createWorkspaceReviewContext(configuration));
  const review = configuration.workspaceReview;
  const lock = configuration.withLock ?? withAgentConfigurationLock;
  const now = configuration.now ?? Date.now;
  const previews = new Map<string, StoredPlan>(),
    controllers = new Set<AbortController>(),
    pending = new Set<Promise<any>>(),
    captureIds = new Set<string>();
  let stopped = false,
    busy = false;
  const stamp = () => new Date(now()).toISOString();
  const assertLive = () => {
    if (stopped) throw new Error('server-stopped');
  };
  function tracked<T>(promise: Promise<T>) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  async function worker(
    operation: string,
    input: unknown,
    bound: any,
    expiresAt: number | null = null,
  ) {
    assertLive();
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await ctx.run(operation, input, bound, { signal: controller.signal, expiresAt });
    } finally {
      controllers.delete(controller);
    }
  }
  async function locked(bound: any, action: () => Promise<any>) {
    return lock(
      { home: ctx.options.home, version: bound.engineVersion, runtime: bound.runtimeSha256 },
      async () => {
        assertLive();
        await ctx.assert(bound);
        return action();
      },
      { timeoutMs: 3000 },
    );
  }
  async function getState() {
    try {
      assertLive();
      const bound = await ctx.current(),
        body = await worker('task-state', {}, bound);
      await ctx.assert(bound);
      if (!validateWorkspaceTaskState(body) || body.workspaceId !== ctx.workspaceId)
        throw new Error('invalid-report');
      return { status: 200, body: copy(body) };
    } catch (error) {
      return {
        status: 200,
        body: {
          schema: 'stroq-workspace-task-controls/1',
          workspaceId: ctx.workspaceId,
          generatedAt: stamp(),
          available: false,
          history: 'unavailable',
          error: codeOf(error),
          records: [],
        },
      };
    }
  }
  function prune() {
    for (const [id, p] of previews)
      if (now() >= Date.parse(p.public.expiresAt)) previews.delete(id);
  }
  function savePreview(plan: TaskPlan, bound: any, at: number) {
    assertLive();
    const body: WorkspaceTaskPreview = {
      schema: 'stroq-workspace-task-preview/1',
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      operation: plan.action,
      recordId: plan.recordId,
      recordRevision: plan.recordRevision,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 120000).toISOString(),
      binding: {
        runId: plan.source.runId,
        captureSha256: plan.source.captureSha256,
        sourceId: WORKSPACE_TASK_SOURCE_ID,
        sourceSha256: plan.source.sourceSha256,
        sourceMode: plan.source.sourceMode,
        captureComplete: plan.source.captureComplete,
      },
      beforeSha256: plan.before.sha256,
      afterSha256: createHash('sha256').update(plan.candidate).digest('hex'),
      changes: plan.changes,
      sourceMode: plan.source.sourceMode,
      manualTasksPreserved: true,
      formattingPreserved: true,
      completeFileBackup: true,
      hostEnforcement: false,
    };
    if (!validateWorkspaceTaskPreview(body) || now() >= at + 120000)
      throw new Error('invalid-report');
    const size = serialize(plan).byteLength;
    prune();
    if (
      previews.size >= 8 ||
      [...previews.values()].reduce((n, p) => n + p.size, size) > 8 * 1024 * 1024
    )
      throw new Error('tasks-busy');
    previews.set(body.id, { public: body, plan, bound, size });
    return { status: 200, body: copy(body) };
  }
  async function preview(input: unknown) {
    if (
      !exact(input, ['runId', 'expectedCaptureSha256', 'sourceId', 'expectedSourceSha256']) ||
      !uuid(input.runId) ||
      !sha(input.expectedCaptureSha256) ||
      !sha(input.expectedSourceSha256) ||
      typeof input.sourceId !== 'string'
    )
      return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('tasks-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current();
      if (!review || input.sourceId !== WORKSPACE_TASK_SOURCE_ID) throw new Error('stale-capture');
      const state = await review.getState(),
        run = review.getRun(input.runId);
      if (state.history?.status !== 'ready') throw new Error('history-unavailable');
      if (
        !validateWorkspaceReviewRun(run) ||
        run.status !== 'completed' ||
        run.workspaceId !== ctx.workspaceId
      )
        throw new Error('stale-capture');
      const capture = run.result!.capture,
        source = capture.sources.find((s) => s.id === WORKSPACE_TASK_SOURCE_ID);
      if (
        capture.captureSha256 !== input.expectedCaptureSha256 ||
        !source ||
        source.kind !== 'file' ||
        source.role !== 'workspace' ||
        source.sha256 !== input.expectedSourceSha256 ||
        capture.profile.engineVersion !== bound.engineVersion ||
        capture.profile.runtimeSha256 !== bound.runtimeSha256 ||
        capture.coverage.gaps.some((g) => g.sourceId === WORKSPACE_TASK_SOURCE_ID)
      )
        throw new Error('stale-capture');
      const at = now(),
        plan = await worker(
          'task-preview',
          {
            source: {
              runId: run.id,
              captureSha256: capture.captureSha256,
              sourceId: WORKSPACE_TASK_SOURCE_ID,
              sourceSha256: source.sha256,
              sourceMode: source.mode,
              captureComplete: capture.complete,
              capturedAt: capture.capturedAt,
              scopeSha256: capture.profile.scopeSha256,
              ...bound,
            },
            recordId: randomUUID(),
            expiresAt: at + 120000,
          },
          bound,
          at + 120000,
        );
      await ctx.assert(bound);
      return savePreview(plan, bound, at);
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  async function restorePreview(input: unknown) {
    if (
      !exact(input, ['recordId', 'expectedRevision']) ||
      !uuid(input.recordId) ||
      !sha(input.expectedRevision)
    )
      return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('tasks-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current(),
        at = now(),
        plan = await worker(
          'task-restore-preview',
          { ...input, expiresAt: at + 120000 },
          bound,
          at + 120000,
        );
      await ctx.assert(bound);
      return savePreview(plan, bound, at);
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  const { finish, stopCapture } = createTaskVerification({
    review,
    ctx,
    worker,
    locked,
    assertLive,
    captureIds,
    stamp,
    codeOf,
  });
  async function apply(input: unknown, action: 'make-manual' | 'restore') {
    const acknowledgement =
      action === 'make-manual' ? 'acknowledgeWorkspaceChange' : 'acknowledgeAutomaticExecution';
    if (
      !exact(input, ['previewId', acknowledgement, 'acknowledgeRecoveryRetention']) ||
      !uuid(input.previewId) ||
      input[acknowledgement] !== true ||
      input.acknowledgeRecoveryRetention !== true
    )
      return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('tasks-busy', 409);
    prune();
    const saved = previews.get(input.previewId);
    if (!saved || saved.public.operation !== action) return fail('preview-stale', 409);
    previews.delete(input.previewId);
    busy = true;
    try {
      const expiresAt = Date.parse(saved.public.expiresAt);
      const evidence = await locked(saved.bound, async () => {
        if (now() >= expiresAt) throw new Error('preview-stale');
        return worker('task-apply', { plan: saved.plan }, saved.bound, expiresAt);
      });
      if (
        !exact(evidence, ['record', 'scopeSha256']) ||
        !sha(evidence.scopeSha256) ||
        !validateWorkspaceTaskRecord(evidence.record) ||
        evidence.record.id !== saved.plan.recordId
      )
        throw new Error('write-unconfirmed');
      return await finish(
        evidence.record,
        saved.bound,
        action,
        expiresAt,
        true,
        evidence.scopeSha256,
      );
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  async function recheck(input: unknown) {
    if (!exact(input, ['recordId']) || !uuid(input.recordId)) return fail('invalid-request', 400);
    if (stopped) return fail('server-stopped');
    if (busy) return fail('tasks-busy', 409);
    busy = true;
    try {
      const bound = await ctx.current(),
        state = await worker('task-state', {}, bound),
        record = state.records.find((r: WorkspaceTaskRecord) => r.id === input.recordId);
      if (!record) throw new Error('recovery-unavailable');
      const expiresAt = now() + 120000,
        checked = await locked(bound, () =>
          worker(
            'task-recheck',
            { recordId: record.id, expectedRevision: record.revision },
            bound,
            expiresAt,
          ),
        );
      if (
        !exact(checked, ['record', 'scopeSha256']) ||
        !sha(checked.scopeSha256) ||
        !validateWorkspaceTaskRecord(checked.record)
      )
        throw new Error('invalid-report');
      return await finish(
        checked.record,
        bound,
        'recheck',
        expiresAt,
        ['manual', 'restored'].includes(checked.record.status),
        checked.scopeSha256,
      );
    } catch (error) {
      const code = codeOf(error);
      return fail(code, statusOf(code));
    } finally {
      busy = false;
    }
  }
  return {
    getState: () => tracked(getState()),
    preview: (v: unknown) => tracked(preview(v)),
    restorePreview: (v: unknown) => tracked(restorePreview(v)),
    apply: (v: unknown) => tracked(apply(v, 'make-manual')),
    restore: (v: unknown) => tracked(apply(v, 'restore')),
    recheck: (v: unknown) => tracked(recheck(v)),
    async close() {
      stopped = true;
      previews.clear();
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...captureIds].map(stopCapture));
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
