import type { Incident } from './incidents';
import { incidentTaskKey } from './incident-task-binding';
import {
  sameSessionTaintIdentity,
  validateSessionTaintInspection,
  validateSessionTaintPreview,
  validateSessionTaintReceipt,
  type SessionTaintInspection,
  type SessionTaintPreview,
  type SessionTaintReceipt,
  type SessionTaintRecord,
} from './session-taint';
type Finding = Pick<Incident, 'id' | 'evidenceSha' | 'sequence' | 'recordedAt'>;
export const sessionTaintKey = incidentTaskKey;
export function sessionTaintInspectionMatches(
  value: unknown,
  finding: Finding,
  workspaceId: string,
): value is SessionTaintInspection {
  return (
    validateSessionTaintInspection(value) &&
    value.workspaceId === workspaceId &&
    value.incident.id === finding.id &&
    value.incident.evidenceSha256 === finding.evidenceSha &&
    value.incident.sequence === finding.sequence &&
    value.incident.recordedAt === finding.recordedAt
  );
}
function sameSnapshot(left: SessionTaintInspection, right: SessionTaintInspection) {
  return (
    sameSessionTaintIdentity(left, right) &&
    left.revisionSha256 === right.revisionSha256 &&
    left.taint.status === right.taint.status &&
    left.taint.sources === right.taint.sources &&
    left.taint.since === right.taint.since &&
    left.taint.sha256 === right.taint.sha256 &&
    left.provenance.sha256 === right.provenance.sha256 &&
    left.provenance.records === right.provenance.records &&
    left.provenance.suspect === right.provenance.suspect &&
    left.provenance.pending === right.provenance.pending &&
    left.provenance.incomplete === right.provenance.incomplete &&
    left.provenance.digestsLost === right.provenance.digestsLost
  );
}
export function sessionTaintPreviewMatches(
  value: unknown,
  inspection: SessionTaintInspection,
): value is SessionTaintPreview {
  return (
    validateSessionTaintPreview(value) &&
    sameSnapshot(value.inspection, inspection) &&
    value.inspection.checkedAt >= inspection.checkedAt
  );
}
export function sessionTaintRecordMatchesPreview(
  record: SessionTaintRecord,
  preview: SessionTaintPreview,
) {
  return (
    record.id === preview.recordId &&
    record.createdAt >= preview.createdAt &&
    sameSnapshot(record.before, preview.inspection)
  );
}
export function sameSessionTaintRecord(left: SessionTaintRecord, right: SessionTaintRecord) {
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    sameSnapshot(left.before, right.before)
  );
}
export function sessionTaintReceiptMatches(
  value: unknown,
  preview: SessionTaintPreview,
  startedAt: string,
): value is SessionTaintReceipt {
  return (
    validateSessionTaintReceipt(value) &&
    value.operation === 'clear' &&
    value.writeConfirmed &&
    value.checkedAt >= startedAt &&
    sessionTaintRecordMatchesPreview(value.record, preview)
  );
}
type PendingWrite = { preview: SessionTaintPreview; startedAt: string };
const pending = new WeakMap<object, Map<string, PendingWrite>>();
const observed = new WeakMap<object, Map<string, SessionTaintRecord>>();
export function sessionTaintObservedUnfinished(transport: object) {
  let records = observed.get(transport);
  if (!records) {
    records = new Map();
    observed.set(transport, records);
  }
  return records;
}
export function sessionTaintPendingWrites(transport: object) {
  let writes = pending.get(transport);
  if (!writes) {
    writes = new Map();
    pending.set(transport, writes);
  }
  return writes;
}
export function sessionTaintConfirmRecheck(transport: object, receipt: SessionTaintReceipt) {
  const writes = sessionTaintPendingWrites(transport),
    write = writes.get(receipt.record.id),
    records = sessionTaintObservedUnfinished(transport),
    record = records.get(receipt.record.id);
  if (
    (!write && !record) ||
    !validateSessionTaintReceipt(receipt) ||
    receipt.operation !== 'recheck' ||
    (write &&
      (receipt.checkedAt < write.startedAt ||
        !sessionTaintRecordMatchesPreview(receipt.record, write.preview))) ||
    (record && !sameSessionTaintRecord(receipt.record, record)) ||
    !(
      (receipt.writeConfirmed && receipt.record.status === 'cleared') ||
      (!receipt.writeConfirmed && receipt.record.status === 'unchanged')
    )
  )
    return false;
  writes.delete(receipt.record.id);
  records.delete(receipt.record.id);
  return true;
}
