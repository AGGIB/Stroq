import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { atomicWrite, assertUnchanged, snapshotFile } from './agent-setup-files.mjs';
import { planWorkspaceTasks } from './workspace-task-transform.ts';
import {
  TASK_BYTES,
  assertTaskContext,
  checkTaskDeadline,
  taskHash,
  taskFail,
  taskParents,
  stagedTaskPin,
  taskRootBinding,
  validTaskSource,
  readTaskVault,
  createTaskRecord,
  saveTaskManifest,
  syncTaskDirectory,
  taskRecord,
  type TaskOptions,
  type TaskSource,
  type TaskSnapshot,
  type TaskManifest,
  type TaskRecord,
} from './workspace-task-store.ts';
export { readTaskVault } from './workspace-task-store.ts';
export interface TaskPlan {
  action: 'make-manual' | 'restore';
  recordId: string;
  expiresAt: number;
  source: TaskSource;
  before: TaskSnapshot;
  candidate: Buffer;
  changes: { folderOpen: number; worktreeCreated: number };
  recordRevision: string | null;
}
export interface TaskHooks {
  guard: () => Promise<void>;
  fault?: (stage: string, details?: Record<string, unknown>) => void | Promise<void>;
}
const target = (options: TaskOptions) => join(options.project, '.vscode', 'tasks.json');
const now = () => new Date().toISOString();
async function sourceSnapshot(options: TaskOptions) {
  await assertTaskContext(options);
  try {
    const captured = await snapshotFile(options.roots.project, target(options), TASK_BYTES);
    if (
      captured.bytes === null ||
      !captured.file ||
      captured.directories.length !== 2 ||
      captured.directories.some(
        (d) =>
          (d.mode & 0o022) !== 0 ||
          (typeof process.getuid === 'function' && d.uid !== process.getuid()),
      ) ||
      (typeof process.getuid === 'function' && captured.file.uid !== process.getuid())
    )
      taskFail('stale-task-source');
    return captured;
  } catch {
    taskFail('stale-task-source');
  }
}
function expiry(options: TaskOptions, expiresAt: number) {
  checkTaskDeadline(options);
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) taskFail('task-preview-expired');
}
export async function prepareTaskDisable(
  options: TaskOptions,
  source: TaskSource,
  meta: { recordId: string; expiresAt: number },
): Promise<TaskPlan> {
  expiry(options, meta.expiresAt);
  if (
    !validTaskSource(source) ||
    source.engineVersion !== options.engineVersion ||
    source.runtimeSha256 !== options.runtimeSha256
  )
    taskFail('stale-task-source');
  const before = await sourceSnapshot(options);
  if (before.sha256 !== source.sourceSha256 || before.mode !== source.sourceMode)
    taskFail('stale-task-source');
  const planned = planWorkspaceTasks(before.bytes!);
  const vault = await readTaskVault(options);
  if (vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase)))
    taskFail('task-recovery-required');
  return {
    action: 'make-manual',
    recordId: meta.recordId,
    expiresAt: meta.expiresAt,
    source,
    before,
    candidate: planned.bytes,
    changes: planned.changes,
    recordRevision: null,
  };
}
function sameCurrent(record: TaskRecord, captured: TaskSnapshot, restored = false) {
  const expected = restored ? record.manifest.restoredPublication : record.manifest.publication;
  return (
    captured.sha256 ===
      (restored ? record.manifest.source.sourceSha256 : record.manifest.manualSha256) &&
    captured.mode === record.manifest.source.sourceMode &&
    expected !== null &&
    isDeepStrictEqual(captured.file, expected) &&
    isDeepStrictEqual(taskParents(captured), record.manifest.parents)
  );
}
export async function prepareTaskRestore(
  options: TaskOptions,
  input: { recordId: string; expectedRevision: string },
  expiresAt: number,
): Promise<TaskPlan> {
  expiry(options, expiresAt);
  const record = await taskRecord(options, input.recordId, input.expectedRevision);
  const before = await sourceSnapshot(options);
  if (record.manifest.phase !== 'manual' || !sameCurrent(record, before))
    taskFail('task-recovery-required');
  return {
    action: 'restore',
    recordId: input.recordId,
    expiresAt,
    source: record.manifest.source,
    before,
    candidate: record.backup,
    changes: record.manifest.changes,
    recordRevision: record.revision,
  };
}
async function checkPlan(options: TaskOptions, plan: TaskPlan, hooks: TaskHooks) {
  expiry(options, plan.expiresAt);
  if (typeof hooks.guard !== 'function') taskFail('stale-task-source');
  await hooks.guard();
  await assertTaskContext(options);
  try {
    await assertUnchanged(options.roots.project, target(options), plan.before);
  } catch {
    taskFail('stale-task-source');
  }
}
export async function applyTaskChange(
  options: TaskOptions,
  plan: TaskPlan,
  hooks: TaskHooks,
): Promise<TaskRecord> {
  await checkPlan(options, plan, hooks);
  const beforeCommit = async () => {
    expiry(options, plan.expiresAt);
    await hooks.guard();
    await assertTaskContext(options);
  };
  let record: TaskRecord;
  if (plan.action === 'make-manual') {
    const fresh = await prepareTaskDisable(options, plan.source, {
      recordId: plan.recordId,
      expiresAt: plan.expiresAt,
    });
    if (!fresh.candidate.equals(plan.candidate) || !isDeepStrictEqual(fresh.changes, plan.changes))
      taskFail('stale-task-source');
    const stamp = now();
    const manifest: TaskManifest = {
      schema: 'stroq-workspace-task-record/1',
      id: plan.recordId,
      storeId: options.storeId,
      workspaceId: options.workspaceId,
      rootBinding: taskRootBinding(options),
      source: plan.source,
      createdAt: stamp,
      changedAt: stamp,
      phase: 'prepared',
      changes: plan.changes,
      bytes: plan.before.bytes!.length,
      manualSha256: taskHash(plan.candidate),
      original: plan.before.file!,
      parents: taskParents(plan.before),
      staged: null,
      publication: null,
      restoreStaged: null,
      restoredPublication: null,
      verification: null,
    };
    await checkPlan(options, plan, hooks);
    record = await createTaskRecord(options, manifest, plan.before.bytes!, async () => {
      await beforeCommit();
      await checkPlan(options, plan, hooks);
    });
  } else {
    record = await taskRecord(options, plan.recordId, plan.recordRevision!);
    if (
      record.manifest.phase !== 'manual' ||
      !sameCurrent(record, plan.before) ||
      !plan.candidate.equals(record.backup)
    )
      taskFail('stale-task-source');
    await checkPlan(options, plan, hooks);
    const manifest = { ...record.manifest, phase: 'restoring' as const, changedAt: now() };
    const revision = await saveTaskManifest(options, manifest, record.revision, async () => {
      await beforeCommit();
      await checkPlan(options, plan, hooks);
    });
    record = { ...record, manifest, revision };
  }
  try {
    await hooks.fault?.('after-intent');
    const published = await atomicWrite(
      options.roots.project,
      target(options),
      plan.candidate,
      plan.before,
      plan.source.sourceMode,
      {
        fault: async (stage?: string, details: Record<string, unknown> = {}) => {
          if (stage === 'before-rename') {
            await checkPlan(options, plan, hooks);
            const staged = await snapshotFile(
              options.roots.project,
              String(details.temporary),
              TASK_BYTES,
            );
            if (!staged.file || !staged.bytes?.equals(plan.candidate))
              taskFail('task-write-unconfirmed');
            const manifest = {
              ...record.manifest,
              changedAt: now(),
              ...(plan.action === 'make-manual'
                ? { staged: stagedTaskPin(staged.file) }
                : { restoreStaged: stagedTaskPin(staged.file) }),
            };
            const revision = await saveTaskManifest(
              options,
              manifest,
              record.revision,
              async () => {
                await beforeCommit();
                await checkPlan(options, plan, hooks);
              },
            );
            record = { ...record, manifest, revision };
            await hooks.fault?.('before-target-rename');
            await checkPlan(options, plan, hooks);
          } else if (stage === 'after-rename') await hooks.fault?.('after-target-rename');
        },
      },
    );
    await hooks.guard();
    expiry(options, plan.expiresAt);
    await assertTaskContext(options);
    const current = await sourceSnapshot(options);
    if (!current.bytes?.equals(plan.candidate) || !isDeepStrictEqual(current.file, published.file))
      taskFail('task-write-unconfirmed');
    await syncTaskDirectory(join(options.project, '.vscode'));
    const manifest = {
      ...record.manifest,
      changedAt: now(),
      ...(plan.action === 'make-manual'
        ? { phase: 'manual' as const, publication: published.file }
        : { phase: 'restored' as const, restoredPublication: published.file }),
    };
    const revision = await saveTaskManifest(options, manifest, record.revision, async () => {
      await hooks.fault?.('before-final-metadata');
      await beforeCommit();
      await assertUnchanged(options.roots.project, target(options), current);
    });
    record = await taskRecord(options, plan.recordId, revision);
    await hooks.guard();
    if (!sameCurrent(record, await sourceSnapshot(options), plan.action === 'restore'))
      taskFail('task-write-unconfirmed');
    return record;
  } catch {
    taskFail('task-write-unconfirmed');
  }
}
export async function recheckTaskChange(
  options: TaskOptions,
  id: string,
  revision: string,
  hooks: TaskHooks,
): Promise<TaskRecord> {
  if (typeof hooks.guard !== 'function') taskFail('stale-task-source');
  await hooks.guard();
  let record = await taskRecord(options, id, revision);
  const current = await sourceSnapshot(options),
    m = record.manifest;
  let phase: TaskManifest['phase'] = m.phase;
  let publication = m.publication,
    restoredPublication = m.restoredPublication;
  if (m.phase === 'prepared') {
    if (
      m.staged &&
      current.file &&
      current.sha256 === m.manualSha256 &&
      current.mode === m.source.sourceMode &&
      isDeepStrictEqual(stagedTaskPin(current.file), m.staged) &&
      isDeepStrictEqual(taskParents(current), m.parents)
    ) {
      phase = 'manual';
      publication = current.file;
    } else if (
      current.sha256 === m.source.sourceSha256 &&
      isDeepStrictEqual(current.file, m.original) &&
      isDeepStrictEqual(taskParents(current), m.parents)
    )
      phase = 'not-applied';
    else taskFail('task-recovery-required');
  } else if (m.phase === 'restoring') {
    if (
      m.restoreStaged &&
      current.file &&
      current.sha256 === m.source.sourceSha256 &&
      current.mode === m.source.sourceMode &&
      isDeepStrictEqual(stagedTaskPin(current.file), m.restoreStaged) &&
      isDeepStrictEqual(taskParents(current), m.parents)
    ) {
      phase = 'restored';
      restoredPublication = current.file;
    } else if (sameCurrent(record, current)) phase = 'manual';
    else taskFail('task-recovery-required');
  } else if (
    m.phase === 'manual'
      ? !sameCurrent(record, current)
      : m.phase === 'restored'
        ? !sameCurrent(record, current, true)
        : current.sha256 !== m.source.sourceSha256 || !isDeepStrictEqual(current.file, m.original)
  )
    taskFail('task-recovery-required');
  if (phase !== m.phase) {
    await hooks.guard();
    await assertTaskContext(options);
    if (phase === 'manual' || phase === 'restored')
      await syncTaskDirectory(join(options.project, '.vscode'));
    const manifest = { ...m, phase, publication, restoredPublication, changedAt: now() };
    const next = await saveTaskManifest(options, manifest, revision, async () => {
      await hooks.guard();
      await assertTaskContext(options);
      await assertUnchanged(options.roots.project, target(options), current);
    });
    record = await taskRecord(options, id, next);
  }
  return record;
}
