import { closed, count, hash, member, stamp } from './local-guards';

export const SESSION_TAINT_ERRORS = [
  'context-unavailable',
  'runtime-unavailable',
  'platform-unsupported',
  'evidence-unavailable',
  'stale-evidence',
  'session-unavailable',
  'unsafe-state',
  'invalid-state',
  'provenance-unavailable',
  'session-busy',
  'stale-state',
  'not-tainted',
  'preview-unavailable',
  'preview-expired',
  'history-unavailable',
  'recovery-required',
  'recovery-full',
  'write-unconfirmed',
  'deadline-exceeded',
  'invalid-report',
  'session-taint-unavailable',
  'server-stopped',
  'cancelled',
] as const;
export type SessionTaintError = (typeof SESSION_TAINT_ERRORS)[number];
export const SESSION_TAINT_ERROR_MESSAGES: Record<SessionTaintError, string> = {
  'context-unavailable': 'The selected local context is unavailable. Reconnect first.',
  'runtime-unavailable':
    'The local session engine is unavailable. Reconnect after the build completes.',
  'platform-unsupported': 'Stored session taint controls are unavailable on this platform.',
  'evidence-unavailable': 'The exact recorded finding could not be verified.',
  'stale-evidence': 'This finding changed or left the captured journal. Refresh investigations.',
  'session-unavailable': 'The current stored session state could not be read.',
  'unsafe-state': 'The session files or their locations could not be safely verified.',
  'invalid-state': 'Stored session state could not be verified. No clear state was inferred.',
  'provenance-unavailable':
    'Learned-origin state could not be verified. Recheck before clearing taint.',
  'session-busy': 'Another session state operation is running. Recheck after it finishes.',
  'stale-state': 'The session state changed. Inspect it and prepare a fresh preview.',
  'not-tainted': 'No stored session taint needs clearing.',
  'preview-unavailable':
    'This preview is unavailable or was already used. Inspect the session again.',
  'preview-expired': 'This preview expired. Inspect the session and preview again.',
  'history-unavailable': 'Private session recovery history could not be verified.',
  'recovery-required': 'An earlier session change needs an explicit recheck.',
  'recovery-full': 'The private recovery limit was reached. Earlier records were preserved.',
  'write-unconfirmed': 'Clear completion is unknown. Recheck the recorded change.',
  'deadline-exceeded': 'The local operation timed out. Recheck any pending clear.',
  'invalid-report': 'The session response could not be verified.',
  'session-taint-unavailable':
    'Stored session taint controls are unavailable. Reconnect and retry.',
  'server-stopped': 'The local server stopped. Reconnect and recheck the change.',
  cancelled: 'The operation was interrupted. Recheck any pending change.',
};
export interface SessionTaintIncident {
  id: string;
  evidenceSha256: string;
  sequence: number;
  recordedAt: string;
}
export interface SessionTaintInspection {
  schema: 'stroq-session-taint-inspection/1';
  workspaceId: string;
  incident: SessionTaintIncident;
  sessionRef: string;
  checkedAt: string;
  revisionSha256: string;
  taint: {
    status: 'clear' | 'suspect';
    sources: number;
    since: string | null;
    sha256: string | null;
  };
  provenance: {
    sha256: string;
    records: number;
    suspect: number;
    incomplete: boolean;
    digestsLost: boolean;
    pending: number;
  };
}
export interface SessionTaintPreview {
  schema: 'stroq-session-taint-preview/1';
  id: string;
  recordId: string;
  createdAt: string;
  expiresAt: string;
  inspection: SessionTaintInspection;
  weakensRestrictions: true;
  provenancePreserved: true;
  privateRecovery: true;
  hostEnforcement: false;
}
export interface SessionTaintRecord {
  id: string;
  revisionSha256: string;
  createdAt: string;
  updatedAt: string;
  status: 'prepared' | 'cleared' | 'unchanged' | 'uncertain';
  before: SessionTaintInspection;
  afterTaintSha256: string | null;
  preservedProvenanceSha256: string | null;
  recoveryAvailable: boolean;
  current: SessionTaintInspection | null;
  error: SessionTaintError | null;
}
export interface SessionTaintReceipt {
  schema: 'stroq-session-taint-receipt/1';
  operation: 'clear' | 'recheck';
  checkedAt: string;
  writeConfirmed: boolean;
  record: SessionTaintRecord;
}
export interface SessionTaintState {
  schema: 'stroq-session-taint/1';
  workspaceId: string;
  generatedAt: string;
  available: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  error: SessionTaintError | null;
  records: SessionTaintRecord[];
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v);
const nullableError = (v: unknown) => v === null || member(v, SESSION_TAINT_ERRORS);
export function sameSessionTaintIdentity(
  left: SessionTaintInspection,
  right: SessionTaintInspection,
) {
  return (
    left.workspaceId === right.workspaceId &&
    left.sessionRef === right.sessionRef &&
    left.incident.id === right.incident.id &&
    left.incident.evidenceSha256 === right.incident.evidenceSha256 &&
    left.incident.sequence === right.incident.sequence &&
    left.incident.recordedAt === right.incident.recordedAt
  );
}
export function validateSessionTaintInspection(v: unknown): v is SessionTaintInspection {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'incident',
      'sessionRef',
      'checkedAt',
      'revisionSha256',
      'taint',
      'provenance',
    ]) ||
    v.schema !== 'stroq-session-taint-inspection/1' ||
    !workspace(v.workspaceId) ||
    !exact(v.incident, ['id', 'evidenceSha256', 'sequence', 'recordedAt']) ||
    !hash(v.incident.evidenceSha256) ||
    v.incident.id !== `incident-${v.incident.evidenceSha256}` ||
    !count(v.incident.sequence, Number.MAX_SAFE_INTEGER) ||
    v.incident.sequence < 1 ||
    !stamp(v.incident.recordedAt) ||
    !stamp(v.checkedAt) ||
    v.checkedAt < v.incident.recordedAt ||
    typeof v.sessionRef !== 'string' ||
    !/^session-[a-f0-9]{64}$/.test(v.sessionRef) ||
    !hash(v.revisionSha256) ||
    !exact(v.taint, ['status', 'sources', 'since', 'sha256']) ||
    !count(v.taint.sources) ||
    !nullableHash(v.taint.sha256) ||
    !exact(v.provenance, [
      'sha256',
      'records',
      'suspect',
      'incomplete',
      'digestsLost',
      'pending',
    ]) ||
    !hash(v.provenance.sha256) ||
    !count(v.provenance.records) ||
    !count(v.provenance.suspect) ||
    v.provenance.suspect > v.provenance.records ||
    typeof v.provenance.incomplete !== 'boolean' ||
    typeof v.provenance.digestsLost !== 'boolean' ||
    !count(v.provenance.pending)
  )
    return false;
  return v.taint.status === 'clear'
    ? v.taint.sources === 0 && v.taint.since === null
    : v.taint.status === 'suspect' &&
        v.taint.sources > 0 &&
        hash(v.taint.sha256) &&
        stamp(v.taint.since) &&
        v.taint.since <= v.checkedAt;
}
export function validateSessionTaintPreview(v: unknown): v is SessionTaintPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'recordId',
      'createdAt',
      'expiresAt',
      'inspection',
      'weakensRestrictions',
      'provenancePreserved',
      'privateRecovery',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-session-taint-preview/1' &&
    uuid(v.id) &&
    uuid(v.recordId) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) === 120000 &&
    validateSessionTaintInspection(v.inspection) &&
    v.inspection.taint.status === 'suspect' &&
    v.inspection.provenance.pending === 0 &&
    v.inspection.checkedAt <= v.createdAt &&
    v.weakensRestrictions === true &&
    v.provenancePreserved === true &&
    v.privateRecovery === true &&
    v.hostEnforcement === false
  );
}
export function validateSessionTaintRecord(v: unknown): v is SessionTaintRecord {
  if (
    !exact(v, [
      'id',
      'revisionSha256',
      'createdAt',
      'updatedAt',
      'status',
      'before',
      'afterTaintSha256',
      'preservedProvenanceSha256',
      'recoveryAvailable',
      'current',
      'error',
    ]) ||
    !uuid(v.id) ||
    !hash(v.revisionSha256) ||
    !stamp(v.createdAt) ||
    !stamp(v.updatedAt) ||
    v.updatedAt < v.createdAt ||
    !member(v.status, ['prepared', 'cleared', 'unchanged', 'uncertain']) ||
    !validateSessionTaintInspection(v.before) ||
    v.before.taint.status !== 'suspect' ||
    v.before.checkedAt > v.createdAt ||
    !nullableHash(v.afterTaintSha256) ||
    !nullableHash(v.preservedProvenanceSha256) ||
    typeof v.recoveryAvailable !== 'boolean' ||
    !nullableError(v.error) ||
    (v.current === null
      ? v.error === null
      : !validateSessionTaintInspection(v.current) ||
        !sameSessionTaintIdentity(v.before, v.current) ||
        v.current.checkedAt < v.before.checkedAt)
  )
    return false;
  if (v.status === 'cleared')
    return (
      hash(v.afterTaintSha256) &&
      v.afterTaintSha256 !== v.before.taint.sha256 &&
      v.preservedProvenanceSha256 === v.before.provenance.sha256
    );
  if (v.afterTaintSha256 !== null || v.preservedProvenanceSha256 !== null) return false;
  return true;
}
export function validateSessionTaintReceipt(v: unknown): v is SessionTaintReceipt {
  return (
    exact(v, ['schema', 'operation', 'checkedAt', 'writeConfirmed', 'record']) &&
    v.schema === 'stroq-session-taint-receipt/1' &&
    member(v.operation, ['clear', 'recheck']) &&
    stamp(v.checkedAt) &&
    typeof v.writeConfirmed === 'boolean' &&
    validateSessionTaintRecord(v.record) &&
    v.checkedAt >= v.record.updatedAt &&
    (v.record.current === null || v.checkedAt >= v.record.current.checkedAt) &&
    (!v.writeConfirmed || v.record.status === 'cleared') &&
    (v.operation !== 'clear' || v.writeConfirmed === true)
  );
}
export function validateSessionTaintState(v: unknown): v is SessionTaintState {
  return (
    exact(v, [
      'schema',
      'workspaceId',
      'generatedAt',
      'available',
      'history',
      'error',
      'records',
    ]) &&
    v.schema === 'stroq-session-taint/1' &&
    workspace(v.workspaceId) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    (v.available
      ? v.error === null && v.history !== 'unavailable'
      : member(v.error, SESSION_TAINT_ERRORS) && v.history === 'unavailable') &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateSessionTaintRecord) &&
    v.records.every(
      (record) =>
        record.before.workspaceId === v.workspaceId &&
        record.updatedAt <= (v.generatedAt as string) &&
        (record.current === null || record.current.checkedAt <= (v.generatedAt as string)),
    ) &&
    new Set(v.records.map((record) => record.id)).size === v.records.length &&
    ((v.available && v.history !== 'missing') || v.records.length === 0)
  );
}
