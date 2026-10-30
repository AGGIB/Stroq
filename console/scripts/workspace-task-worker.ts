import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { snapshotFile } from './agent-setup-files.mjs';
import { runtimeDigest } from './runtime-digest.mjs';
import {
  validateWorkspaceTaskRecord,
  validateWorkspaceTaskState,
  validateWorkspaceTaskVerification,
  type WorkspaceTaskRecord,
  type WorkspaceTaskVerification,
} from '../lib/workspace-task-controls.ts';
import {
  TASK_BYTES,
  assertTaskContext,
  taskFail,
  taskParents,
  stagedTaskPin,
  taskRecord,
  saveTaskManifest,
  type TaskOptions,
  type TaskRecord,
} from './workspace-task-store.ts';
import {
  prepareTaskDisable,
  prepareTaskRestore,
  applyTaskChange,
  recheckTaskChange,
  readTaskVault,
  type TaskPlan,
  type TaskHooks,
} from './workspace-task-transaction.ts';

interface Options extends TaskOptions {
  configurationLockHeld?: boolean;
  commitGuard?: { runtimePaths: Record<string, string>; expiresAt: number | null };
}
interface Request {
  operation: string;
  input?: Record<string, any>;
  options: Options;
}
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const stamp = () => new Date().toISOString();
async function guard(options: Options, mutation: boolean) {
  await assertTaskContext(options);
  const authority = options.commitGuard;
  if (
    !authority ||
    !authority.runtimePaths ||
    (mutation &&
      (!Number.isSafeInteger(authority.expiresAt) || Date.now() >= Number(authority.expiresAt)))
  )
    taskFail('task-preview-expired');
  try {
    if ((await runtimeDigest(authority.runtimePaths)) !== options.runtimeSha256)
      taskFail('runtime-unavailable');
  } catch {
    taskFail('runtime-unavailable');
  }
}
async function fileState(
  options: TaskOptions,
  record: TaskRecord,
): Promise<WorkspaceTaskRecord['fileState']> {
  try {
    const s = await snapshotFile(
        options.roots.project,
        join(options.project, '.vscode', 'tasks.json'),
        TASK_BYTES,
      ),
      m = record.manifest;
    if (!s.file) return 'missing';
    if (s.mode !== m.source.sourceMode || !isDeepStrictEqual(taskParents(s), m.parents))
      return 'changed';
    if (
      s.sha256 === m.manualSha256 &&
      (m.publication
        ? isDeepStrictEqual(s.file, m.publication)
        : m.staged && isDeepStrictEqual(stagedTaskPin(s.file), m.staged))
    )
      return 'manual-version';
    if (
      s.sha256 === m.source.sourceSha256 &&
      (isDeepStrictEqual(s.file, m.restoredPublication ?? m.original) ||
        (m.restoreStaged && isDeepStrictEqual(stagedTaskPin(s.file), m.restoreStaged)))
    )
      return 'original-version';
    return 'changed';
  } catch {
    return 'unverifiable';
  }
}
export async function projectTaskRecord(
  options: TaskOptions,
  record: TaskRecord,
  uncertain = false,
): Promise<WorkspaceTaskRecord> {
  const m = record.manifest,
    state = await fileState(options, record);
  const body: WorkspaceTaskRecord = {
    id: m.id,
    revision: record.revision,
    workspaceId: m.workspaceId,
    createdAt: m.createdAt,
    updatedAt: m.changedAt,
    status: uncertain ? 'uncertain' : m.phase === 'not-applied' ? 'unchanged' : m.phase,
    binding: {
      runId: m.source.runId,
      captureSha256: m.source.captureSha256,
      sourceId: m.source.sourceId as WorkspaceTaskRecord['binding']['sourceId'],
      sourceSha256: m.source.sourceSha256,
      sourceMode: m.source.sourceMode,
      captureComplete: m.source.captureComplete,
    },
    originalSha256: m.source.sourceSha256,
    manualSha256: m.manualSha256,
    mode: m.source.sourceMode,
    changes: m.changes,
    fileState: state,
    recoveryAvailable: true,
    canRestore: m.phase === 'manual' && state === 'manual-version' && !uncertain,
    verification: m.verification,
    hostEnforcement: false,
  };
  if (!validateWorkspaceTaskRecord(body)) taskFail('invalid-report');
  return body;
}
async function operationEvidence(options: TaskOptions, record: TaskRecord, uncertain = false) {
  return {
    record: await projectTaskRecord(options, record, uncertain),
    scopeSha256: record.manifest.source.scopeSha256,
  };
}
async function recordVerification(options: Options, input: Record<string, any>, hooks: TaskHooks) {
  if (
    !exact(input, ['recordId', 'expectedRevision', 'verification']) ||
    !validateWorkspaceTaskVerification(input.verification)
  )
    taskFail('invalid-report');
  const record = await taskRecord(options, input.recordId, input.expectedRevision);
  const verification: WorkspaceTaskVerification = input.verification;
  if (
    verification.status === 'recorded' &&
    Date.parse(verification.capturedAt) < Date.parse(record.manifest.createdAt)
  )
    taskFail('invalid-report');
  const manifest = { ...record.manifest, verification, changedAt: stamp() };
  const revision = await saveTaskManifest(options, manifest, record.revision, hooks.guard);
  return projectTaskRecord(options, await taskRecord(options, manifest.id, revision));
}
/** Private worker protocol. Browser inputs never include plans, filesystem paths or raw bytes. */
export async function runWorkspaceTaskWorker(request: Request, fault?: TaskHooks['fault']) {
  const { options, operation } = request,
    input = request.input ?? {};
  const mutation = ['task-apply', 'task-recheck', 'task-verification'].includes(operation);
  if (mutation && options.configurationLockHeld !== true) taskFail('tasks-busy');
  const hooks: TaskHooks = { guard: () => guard(options, mutation), fault };
  await hooks.guard();
  if (operation === 'task-state') {
    if (!exact(input, [])) taskFail('invalid-report');
    const vault = await readTaskVault(options),
      records = await Promise.all(vault.records.map((r) => projectTaskRecord(options, r)));
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const body = {
      schema: 'stroq-workspace-task-controls/1',
      workspaceId: options.workspaceId,
      generatedAt: stamp(),
      available: true,
      history: vault.marker.bytes === null ? 'missing' : 'ready',
      error: null,
      records,
    };
    if (!validateWorkspaceTaskState(body)) taskFail('invalid-report');
    return body;
  }
  if (operation === 'task-preview') {
    if (
      !exact(input, ['source', 'recordId', 'expiresAt']) ||
      input.expiresAt !== options.commitGuard?.expiresAt
    )
      taskFail('invalid-report');
    return prepareTaskDisable(options, input.source, {
      recordId: input.recordId,
      expiresAt: input.expiresAt,
    });
  }
  if (operation === 'task-restore-preview') {
    if (
      !exact(input, ['recordId', 'expectedRevision', 'expiresAt']) ||
      input.expiresAt !== options.commitGuard?.expiresAt
    )
      taskFail('invalid-report');
    return prepareTaskRestore(
      options,
      { recordId: input.recordId, expectedRevision: input.expectedRevision },
      input.expiresAt,
    );
  }
  if (operation === 'task-apply') {
    if (
      !exact(input, ['plan']) ||
      !exact(input.plan, [
        'action',
        'recordId',
        'expiresAt',
        'source',
        'before',
        'candidate',
        'changes',
        'recordRevision',
      ]) ||
      input.plan.expiresAt !== options.commitGuard?.expiresAt ||
      !['make-manual', 'restore'].includes(input.plan.action) ||
      !(input.plan.candidate instanceof Uint8Array) ||
      input.plan.candidate.byteLength > TASK_BYTES ||
      !(input.plan.before?.bytes instanceof Uint8Array) ||
      input.plan.before.bytes.byteLength > TASK_BYTES
    )
      taskFail('invalid-report');
    const plan: TaskPlan = {
      action: input.plan.action,
      recordId: input.plan.recordId,
      expiresAt: input.plan.expiresAt,
      source: input.plan.source,
      changes: input.plan.changes,
      recordRevision: input.plan.recordRevision,
      candidate: Buffer.from(input.plan.candidate),
      before: { ...input.plan.before, bytes: Buffer.from(input.plan.before.bytes) },
    };
    return operationEvidence(options, await applyTaskChange(options, plan, hooks));
  }
  if (operation === 'task-recheck') {
    if (!exact(input, ['recordId', 'expectedRevision'])) taskFail('invalid-report');
    let record: TaskRecord,
      uncertain = false;
    try {
      record = await recheckTaskChange(options, input.recordId, input.expectedRevision, hooks);
    } catch (error) {
      if ((error as Error).message !== 'task-recovery-required') throw error;
      record = await taskRecord(options, input.recordId, input.expectedRevision);
      uncertain = true;
    }
    return operationEvidence(
      options,
      record,
      uncertain && ['prepared', 'restoring'].includes(record.manifest.phase),
    );
  }
  if (operation === 'task-verification') return recordVerification(options, input, hooks);
  taskFail('invalid-report');
}
