import type { TaskLockPreview, TaskLockReceipt, TaskLockRow } from './task-locks';

export function taskLockKey(
  workspaceId: string | null,
  task: TaskLockRow | null,
  generation: number,
) {
  if (
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !task ||
    !/^task-[a-f0-9]{64}$/.test(task.id) ||
    !/^[a-f0-9]{64}$/.test(task.permitSha256) ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return null;
  return `${workspaceId}:${task.id}:${task.permitSha256}:${generation}`;
}
export function taskLockPreviewMatches(
  preview: TaskLockPreview,
  task: TaskLockRow,
  workspaceId: string,
) {
  const next = preview.task;
  return (
    preview.workspaceId === workspaceId &&
    next.id === task.id &&
    next.permitSha256 === task.permitSha256 &&
    next.issuedAt === task.issuedAt &&
    next.expiresAt === task.expiresAt &&
    next.profile === task.profile &&
    next.policySha256 === task.policySha256 &&
    next.declaredMode === task.declaredMode &&
    JSON.stringify(next.scope) === JSON.stringify(task.scope)
  );
}
export function taskLockApplyInput(
  preview: TaskLockPreview,
  acknowledged: boolean,
  now = Date.now(),
) {
  return preview.canApply &&
    acknowledged === true &&
    now >= Date.parse(preview.createdAt) &&
    now < Date.parse(preview.expiresAt)
    ? { previewId: preview.id, acknowledgeTaskInterruption: true }
    : null;
}
export function taskLockReceiptMatches(receipt: TaskLockReceipt, preview: TaskLockPreview) {
  return (
    preview.canApply &&
    receipt.previewId === preview.id &&
    receipt.workspaceId === preview.workspaceId &&
    receipt.taskId === preview.task.id &&
    receipt.permitSha256 === preview.task.permitSha256 &&
    Date.parse(receipt.checkedAt) >= Date.parse(preview.createdAt)
  );
}
