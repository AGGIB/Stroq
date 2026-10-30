import {
  validateWorkspaceReviewRun,
  type WorkspaceReviewRun,
  type WorkspaceReviewSource,
} from './workspace-review';
import { workspaceReviewHref } from './workspace-review-navigation';
import {
  WORKSPACE_TASK_SOURCE_ID,
  validateWorkspaceTaskPreview,
  validateWorkspaceTaskReceipt,
  type WorkspaceTaskBinding,
  type WorkspaceTaskPreview,
  type WorkspaceTaskReceipt,
  type WorkspaceTaskRecord,
} from './workspace-task-controls';

export function workspaceTaskBindingFor(
  run: WorkspaceReviewRun | null,
  source: WorkspaceReviewSource,
): WorkspaceTaskBinding | null {
  if (
    !validateWorkspaceReviewRun(run) ||
    run.status !== 'completed' ||
    !run.result ||
    source.id !== WORKSPACE_TASK_SOURCE_ID ||
    source.label !== '.vscode/tasks.json' ||
    source.labelHidden ||
    source.role !== 'workspace' ||
    source.kind !== 'file'
  )
    return null;
  const captured = run.result.capture.sources.find((value) => value.id === source.id);
  if (
    !captured ||
    captured.sha256 !== source.sha256 ||
    captured.mode !== source.mode ||
    captured.kind !== 'file' ||
    captured.role !== 'workspace' ||
    captured.label !== '.vscode/tasks.json' ||
    captured.labelHidden ||
    !run.result.capture.entries.some(
      (entry) =>
        entry.sourceId === source.id &&
        entry.kind === 'editor-autorun-task' &&
        entry.stage === 'on-open',
    )
  )
    return null;
  return {
    runId: run.id,
    captureSha256: run.result.capture.captureSha256,
    sourceId: WORKSPACE_TASK_SOURCE_ID,
    sourceSha256: source.sha256,
    sourceMode: source.mode,
    captureComplete: run.result.capture.complete,
  };
}
export function sameWorkspaceTaskBinding(left: WorkspaceTaskBinding, right: WorkspaceTaskBinding) {
  return (
    left.runId === right.runId &&
    left.captureSha256 === right.captureSha256 &&
    left.sourceId === right.sourceId &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceMode === right.sourceMode &&
    left.captureComplete === right.captureComplete
  );
}
export function sameWorkspaceTaskRecord(left: WorkspaceTaskRecord, right: WorkspaceTaskRecord) {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    sameWorkspaceTaskBinding(left.binding, right.binding) &&
    left.originalSha256 === right.originalSha256 &&
    left.manualSha256 === right.manualSha256 &&
    left.mode === right.mode &&
    left.changes.folderOpen === right.changes.folderOpen &&
    left.changes.worktreeCreated === right.changes.worktreeCreated
  );
}
export function workspaceTaskPreviewMatches(
  preview: unknown,
  binding: WorkspaceTaskBinding,
  workspaceId: string,
  record?: WorkspaceTaskRecord,
): preview is WorkspaceTaskPreview {
  return (
    validateWorkspaceTaskPreview(preview) &&
    preview.workspaceId === workspaceId &&
    sameWorkspaceTaskBinding(preview.binding, binding) &&
    (record
      ? preview.operation === 'restore' &&
        preview.recordId === record.id &&
        preview.recordRevision === record.revision &&
        preview.beforeSha256 === record.manualSha256 &&
        preview.afterSha256 === record.originalSha256 &&
        preview.changes.folderOpen === record.changes.folderOpen &&
        preview.changes.worktreeCreated === record.changes.worktreeCreated
      : preview.operation === 'make-manual')
  );
}
export function workspaceTaskReceiptMatches(
  receipt: unknown,
  preview: WorkspaceTaskPreview,
  startedAt: string,
): receipt is WorkspaceTaskReceipt {
  if (
    !validateWorkspaceTaskReceipt(receipt) ||
    receipt.operation !== preview.operation ||
    !receipt.writeConfirmed ||
    receipt.workspaceId !== preview.workspaceId ||
    receipt.record.id !== preview.recordId ||
    receipt.checkedAt < startedAt ||
    receipt.checkedAt < preview.createdAt ||
    !sameWorkspaceTaskBinding(receipt.record.binding, preview.binding)
  )
    return false;
  return workspaceTaskRecordMatchesPreview(receipt.record, preview);
}
export function workspaceTaskRecordMatchesPreview(
  record: WorkspaceTaskRecord,
  preview: WorkspaceTaskPreview,
) {
  return (
    record.id === preview.recordId &&
    record.workspaceId === preview.workspaceId &&
    sameWorkspaceTaskBinding(record.binding, preview.binding) &&
    record.originalSha256 === preview.binding.sourceSha256 &&
    record.mode === preview.sourceMode &&
    record.manualSha256 ===
      (preview.operation === 'restore' ? preview.beforeSha256 : preview.afterSha256) &&
    record.changes.folderOpen === preview.changes.folderOpen &&
    record.changes.worktreeCreated === preview.changes.worktreeCreated
  );
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function workspaceTaskRecordSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
) {
  const requested = params.has('taskControl'),
    recordId = params.get('taskControl');
  const valid =
    requested &&
    params.getAll('taskControl').length === 1 &&
    recordId !== null &&
    UUID.test(recordId);
  return { requested, invalid: requested && !valid, recordId: valid ? recordId : null };
}
export function workspaceTaskRecoveryHref(record: WorkspaceTaskRecord) {
  return `${workspaceReviewHref(record.binding.runId, record.workspaceId)}&${new URLSearchParams({ taskControl: record.id })}`;
}
