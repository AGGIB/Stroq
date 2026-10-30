import type { Incident } from './incidents';
import type { TaskAccessPreview, TaskAccessReceipt, TaskAccessState } from './task-access';
export function taskAccessPreviewMatches(
  preview: TaskAccessPreview,
  incident: Pick<Incident, 'id' | 'evidenceSha' | 'sequence' | 'recordedAt'>,
  workspaceId: string,
) {
  return (
    preview.workspaceId === workspaceId &&
    preview.incident.id === incident.id &&
    preview.incident.evidenceSha256 === incident.evidenceSha &&
    preview.incident.sequence === incident.sequence &&
    preview.incident.recordedAt === incident.recordedAt
  );
}
export function taskAccessReceiptMatches(receipt: TaskAccessReceipt, preview: TaskAccessPreview) {
  return (
    receipt.previewId === preview.id &&
    receipt.workspaceId === preview.workspaceId &&
    receipt.incident.id === preview.incident.id &&
    receipt.incident.evidenceSha256 === preview.incident.evidenceSha256 &&
    receipt.incident.sequence === preview.incident.sequence &&
    receipt.incident.recordedAt === preview.incident.recordedAt &&
    receipt.taskId === preview.task.id &&
    receipt.permitSha256 === preview.task.permitSha256 &&
    receipt.fingerprint === preview.operation.fingerprint &&
    receipt.issuedAt === preview.createdAt &&
    receipt.expiresAt === preview.grantExpiresAt
  );
}
export function taskAccessIssueInput(
  preview: TaskAccessPreview,
  oneUse: boolean,
  signingKey: boolean,
  now = Date.now(),
) {
  return oneUse === true &&
    signingKey === true &&
    now >= Date.parse(preview.createdAt) &&
    now < Date.parse(preview.expiresAt) &&
    now < Date.parse(preview.grantExpiresAt)
    ? { previewId: preview.id, acknowledgeOneUse: true, acknowledgeSigningKeyUse: true }
    : null;
}
export function taskAccessStateMatches(
  state: TaskAccessState,
  workspaceId: string,
  taskId: string,
  permitSha256: string,
) {
  return (
    state.workspaceId === workspaceId &&
    state.taskId === taskId &&
    state.permitSha256 === permitSha256
  );
}
