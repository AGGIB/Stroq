import type { WorkspaceTaskPreview, WorkspaceTaskReceipt } from './workspace-task-controls';
import { workspaceTaskRecordMatchesPreview } from './workspace-task-controls-binding';

type Transport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
export interface WorkspaceTaskPending {
  preview: WorkspaceTaskPreview;
  startedAt: string;
}
const writes = new WeakMap<Transport, Map<string, WorkspaceTaskPending>>();
export function workspaceTaskPendingWrites(transport: Transport) {
  let pending = writes.get(transport);
  if (!pending) {
    pending = new Map();
    writes.set(transport, pending);
  }
  return pending;
}
export function workspaceTaskConfirmRecheck(transport: Transport, receipt: WorkspaceTaskReceipt) {
  const pending = workspaceTaskPendingWrites(transport),
    write = pending.get(receipt.record.id);
  if (
    !write ||
    receipt.operation !== 'recheck' ||
    receipt.checkedAt < write.startedAt ||
    !workspaceTaskRecordMatchesPreview(receipt.record, write.preview)
  )
    return;
  if (
    (receipt.writeConfirmed && ['manual', 'restored'].includes(receipt.record.status)) ||
    (receipt.record.status === 'unchanged' && receipt.record.fileState === 'original-version')
  )
    pending.delete(receipt.record.id);
}
