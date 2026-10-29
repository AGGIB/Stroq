import { closed, count, hash, member, stamp } from './local-guards';

export const INCIDENT_ASSESSMENT_LABELS = {
  'false-positive': 'Marked false positive',
  'accepted-risk': 'Risk accepted',
  'confirmed-issue': 'Marked as issue',
  reopened: 'Reopened',
} as const;
export type IncidentAssessmentDecision = keyof typeof INCIDENT_ASSESSMENT_LABELS;
export const INCIDENT_ASSESSMENT_REASONS = {
  'incorrect-match': 'The finding does not match this event',
  'benign-content': 'Benign content was incorrectly flagged',
  'intended-workflow': 'Needed for this workflow',
  'controlled-test': 'Part of a controlled test',
  'compensating-control': 'Compensating controls are in place',
  'unintended-action': 'An unintended action was requested',
  'suspicious-content': 'Suspicious content needs attention',
  'sensitive-data-risk': 'Sensitive data may be at risk',
  'new-evidence': 'New evidence needs review',
  reassess: 'Reassess this finding',
} as const;
export type IncidentAssessmentReason = keyof typeof INCIDENT_ASSESSMENT_REASONS;
export const INCIDENT_ASSESSMENT_REASON_DECISIONS: Record<
  IncidentAssessmentReason,
  IncidentAssessmentDecision
> = {
  'incorrect-match': 'false-positive',
  'benign-content': 'false-positive',
  'intended-workflow': 'accepted-risk',
  'controlled-test': 'accepted-risk',
  'compensating-control': 'accepted-risk',
  'unintended-action': 'confirmed-issue',
  'suspicious-content': 'confirmed-issue',
  'sensitive-data-risk': 'confirmed-issue',
  'new-evidence': 'reopened',
  reassess: 'reopened',
};
export const INCIDENT_ASSESSMENT_ERRORS = [
  'runtime-unavailable',
  'history-unavailable',
  'store-full',
  'stale-evidence',
  'stale-assessment',
  'assessment-unchanged',
  'invalid-request',
  'preview-unavailable',
  'preview-expired',
  'busy',
  'write-unconfirmed',
  'clock-unavailable',
  'server-stopped',
  'incident-assessments-unavailable',
] as const;
export type IncidentAssessmentError = (typeof INCIDENT_ASSESSMENT_ERRORS)[number];
export const INCIDENT_ASSESSMENT_ERROR_MESSAGES: Record<IncidentAssessmentError, string> = {
  'runtime-unavailable': 'The local assessment engine is unavailable. Reconnect first.',
  'history-unavailable': 'Assessment history could not be verified. No assessment was inferred.',
  'store-full': 'Assessment storage is full. Earlier records were preserved.',
  'stale-evidence': 'This exact finding is no longer available. Refresh investigations.',
  'stale-assessment': 'Assessment history changed. Review it before saving again.',
  'assessment-unchanged': 'This assessment and reason are already the latest recorded decision.',
  'invalid-request': 'The assessment request could not be verified.',
  'preview-unavailable': 'This assessment preview is unavailable or was already used.',
  'preview-expired': 'This assessment preview expired. Review the finding again.',
  busy: 'Another local assessment operation is running. Recheck after it finishes.',
  'write-unconfirmed': 'Saving may have completed. Explicitly recheck this assessment.',
  'clock-unavailable': 'The local clock could not establish a valid assessment time.',
  'server-stopped': 'The local server stopped. Reconnect and recheck any pending assessment.',
  'incident-assessments-unavailable': 'Local incident assessments are unavailable.',
};
export interface IncidentAssessmentBinding {
  id: string;
  evidenceSha256: string;
  sequence: number;
  recordedAt: string;
  kind: 'policy-deny' | 'policy-ask' | 'content-flag';
}
export interface IncidentAssessmentRecord {
  id: string;
  incident: IncidentAssessmentBinding;
  assessment: IncidentAssessmentDecision;
  reason: IncidentAssessmentReason;
  assessedAt: string;
  previousAssessmentId: string | null;
}
export interface IncidentAssessmentState {
  schema: 'stroq-incident-assessments/1';
  scope: 'local-journal';
  generatedAt: string;
  history: 'missing' | 'ready' | 'unavailable';
  revision: string | null;
  records: IncidentAssessmentRecord[];
  canRecord: boolean;
  error: IncidentAssessmentError | null;
}
export interface IncidentAssessmentPreview {
  schema: 'stroq-incident-assessment-preview/1';
  id: string;
  recordId: string;
  createdAt: string;
  expiresAt: string;
  incident: IncidentAssessmentBinding;
  assessment: IncidentAssessmentDecision;
  reason: IncidentAssessmentReason;
  previousAssessmentId: string | null;
  storeRevision: string | null;
}
export interface IncidentAssessmentReceipt {
  schema: 'stroq-incident-assessment-receipt/1';
  operation: 'record' | 'recheck';
  checkedAt: string;
  status: 'recorded' | 'not-present';
  recordId: string;
  expectedEvidenceSha: string;
  revision: string | null;
  record: IncidentAssessmentRecord | null;
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const nullableUuid = (v: unknown): v is string | null => v === null || uuid(v);
const nullableHash = (v: unknown): v is string | null => v === null || hash(v);
export function assessmentReasonMatches(assessment: unknown, reason: unknown): boolean {
  return (
    member(assessment, Object.keys(INCIDENT_ASSESSMENT_LABELS)) &&
    typeof reason === 'string' &&
    Object.hasOwn(INCIDENT_ASSESSMENT_REASON_DECISIONS, reason) &&
    INCIDENT_ASSESSMENT_REASON_DECISIONS[reason as IncidentAssessmentReason] === assessment
  );
}
export function validateIncidentAssessmentBinding(v: unknown): v is IncidentAssessmentBinding {
  return (
    exact(v, ['id', 'evidenceSha256', 'sequence', 'recordedAt', 'kind']) &&
    hash(v.evidenceSha256) &&
    v.id === `incident-${v.evidenceSha256}` &&
    count(v.sequence, Number.MAX_SAFE_INTEGER) &&
    v.sequence > 0 &&
    stamp(v.recordedAt) &&
    member(v.kind, ['policy-deny', 'policy-ask', 'content-flag'])
  );
}
export function validateIncidentAssessmentRecord(v: unknown): v is IncidentAssessmentRecord {
  return (
    exact(v, ['id', 'incident', 'assessment', 'reason', 'assessedAt', 'previousAssessmentId']) &&
    uuid(v.id) &&
    validateIncidentAssessmentBinding(v.incident) &&
    assessmentReasonMatches(v.assessment, v.reason) &&
    stamp(v.assessedAt) &&
    nullableUuid(v.previousAssessmentId) &&
    v.previousAssessmentId !== v.id &&
    (v.assessment !== 'reopened' || v.previousAssessmentId !== null)
  );
}
export function sameIncidentAssessmentBinding(
  left: IncidentAssessmentBinding,
  right: IncidentAssessmentBinding,
): boolean {
  return (
    left.id === right.id &&
    left.evidenceSha256 === right.evidenceSha256 &&
    left.sequence === right.sequence &&
    left.recordedAt === right.recordedAt &&
    left.kind === right.kind
  );
}
function validHistory(
  records: unknown[],
  generatedAt: string,
): records is IncidentAssessmentRecord[] {
  const ids = new Set<string>();
  const latest = new Map<string, IncidentAssessmentRecord>();
  let assessedAt: string | null = null;
  for (const row of records) {
    if (
      !validateIncidentAssessmentRecord(row) ||
      ids.has(row.id) ||
      row.assessedAt > generatedAt ||
      (assessedAt !== null && row.assessedAt < assessedAt)
    )
      return false;
    const prior = latest.get(row.incident.id);
    if (
      row.previousAssessmentId !== (prior?.id ?? null) ||
      (prior && !sameIncidentAssessmentBinding(prior.incident, row.incident)) ||
      (prior && prior.assessment === row.assessment && prior.reason === row.reason) ||
      (row.assessment === 'reopened' && (!prior || prior.assessment === 'reopened'))
    )
      return false;
    ids.add(row.id);
    latest.set(row.incident.id, row);
    assessedAt = row.assessedAt;
  }
  return true;
}
export function validateIncidentAssessmentState(v: unknown): v is IncidentAssessmentState {
  if (
    !exact(v, [
      'schema',
      'scope',
      'generatedAt',
      'history',
      'revision',
      'records',
      'canRecord',
      'error',
    ]) ||
    v.schema !== 'stroq-incident-assessments/1' ||
    v.scope !== 'local-journal' ||
    !stamp(v.generatedAt) ||
    !member(v.history, ['missing', 'ready', 'unavailable']) ||
    !nullableHash(v.revision) ||
    !Array.isArray(v.records) ||
    v.records.length > 512 ||
    !validHistory(v.records, v.generatedAt) ||
    typeof v.canRecord !== 'boolean' ||
    !(v.error === null || member(v.error, INCIDENT_ASSESSMENT_ERRORS))
  )
    return false;
  if (v.history === 'unavailable')
    return v.revision === null && v.records.length === 0 && !v.canRecord && v.error !== null;
  if (v.history === 'missing' && (v.revision !== null || v.records.length !== 0)) return false;
  if (v.history === 'ready' && !hash(v.revision)) return false;
  if (v.records.length === 512 && v.canRecord) return false;
  return v.canRecord ? v.error === null : v.error === 'store-full';
}
export function validateIncidentAssessmentPreview(v: unknown): v is IncidentAssessmentPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'recordId',
      'createdAt',
      'expiresAt',
      'incident',
      'assessment',
      'reason',
      'previousAssessmentId',
      'storeRevision',
    ]) &&
    v.schema === 'stroq-incident-assessment-preview/1' &&
    uuid(v.id) &&
    uuid(v.recordId) &&
    v.id !== v.recordId &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) === 120000 &&
    validateIncidentAssessmentBinding(v.incident) &&
    assessmentReasonMatches(v.assessment, v.reason) &&
    nullableUuid(v.previousAssessmentId) &&
    v.previousAssessmentId !== v.recordId &&
    nullableHash(v.storeRevision) &&
    (v.previousAssessmentId === null || v.storeRevision !== null) &&
    (v.assessment !== 'reopened' || v.previousAssessmentId !== null)
  );
}
export function validateIncidentAssessmentReceipt(v: unknown): v is IncidentAssessmentReceipt {
  if (
    !exact(v, [
      'schema',
      'operation',
      'checkedAt',
      'status',
      'recordId',
      'expectedEvidenceSha',
      'revision',
      'record',
    ]) ||
    v.schema !== 'stroq-incident-assessment-receipt/1' ||
    !member(v.operation, ['record', 'recheck']) ||
    !stamp(v.checkedAt) ||
    !uuid(v.recordId) ||
    !hash(v.expectedEvidenceSha) ||
    !nullableHash(v.revision)
  )
    return false;
  if (v.status === 'not-present') return v.operation === 'recheck' && v.record === null;
  return (
    v.status === 'recorded' &&
    hash(v.revision) &&
    validateIncidentAssessmentRecord(v.record) &&
    v.record.id === v.recordId &&
    v.record.incident.evidenceSha256 === v.expectedEvidenceSha &&
    v.record.assessedAt <= v.checkedAt
  );
}
export function incidentAssessmentMatchesPreview(
  record: IncidentAssessmentRecord,
  preview: IncidentAssessmentPreview,
): boolean {
  return (
    validateIncidentAssessmentRecord(record) &&
    validateIncidentAssessmentPreview(preview) &&
    record.id === preview.recordId &&
    sameIncidentAssessmentBinding(record.incident, preview.incident) &&
    record.assessment === preview.assessment &&
    record.reason === preview.reason &&
    record.previousAssessmentId === preview.previousAssessmentId &&
    record.assessedAt >= preview.createdAt &&
    record.assessedAt <= preview.expiresAt
  );
}
export function latestIncidentAssessment(
  records: readonly IncidentAssessmentRecord[],
  binding: IncidentAssessmentBinding,
): IncidentAssessmentRecord | null {
  return (
    records.findLast((record) => sameIncidentAssessmentBinding(record.incident, binding)) ?? null
  );
}
