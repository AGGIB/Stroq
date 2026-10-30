import { closed, count, hash, member, stamp } from './local-guards';
import { taskLockRowMatchesCapture, validateTaskLockRow, type TaskLockRow } from './task-locks';

export const INCIDENT_TASK_LIMITATIONS = [
  'This ID lookup does not verify the historical permit revision.',
  'A match identifies current signed metadata for the same task ID in this workspace.',
  'Known session or permit-time contradictions prevent a handoff; absent session binding stays unverified.',
  'Journal consistency is not independent authenticity and cannot detect tail truncation.',
  'Looking up a permission does not revoke it, resolve the finding or establish process termination.',
] as const;

export interface IncidentTaskReport {
  schema: 'stroq-incident-task/1';
  workspaceId: string;
  incident: { id: string; evidenceSha256: string; sequence: number; recordedAt: string };
  checkedAt: string;
  currentPolicySha256: string | null;
  status:
    | 'matched'
    | 'not-recorded'
    | 'invalid-reference'
    | 'permit-unavailable'
    | 'different-workspace'
    | 'session-mismatch'
    | 'time-mismatch'
    | 'evidence-unavailable';
  journal: {
    status: 'verified' | 'missing' | 'broken' | 'limit' | 'unavailable';
    sha256: string | null;
  };
  relation: 'task-id-only' | 'none';
  historicalPermitRelation: 'not-recorded';
  sessionRelation: 'matches' | 'differs' | 'unavailable';
  task: TaskLockRow | null;
  limitations: typeof INCIDENT_TASK_LIMITATIONS;
}

/** This validates a read-only ID association, never historical permit attribution. */
export function validateIncidentTaskReport(v: unknown): v is IncidentTaskReport {
  if (
    !closed(v, [
      'schema',
      'workspaceId',
      'incident',
      'checkedAt',
      'currentPolicySha256',
      'status',
      'journal',
      'relation',
      'historicalPermitRelation',
      'sessionRelation',
      'task',
      'limitations',
    ]) ||
    v.schema !== 'stroq-incident-task/1' ||
    typeof v.workspaceId !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(v.workspaceId) ||
    !closed(v.incident, ['id', 'evidenceSha256', 'sequence', 'recordedAt']) ||
    !hash(v.incident.evidenceSha256) ||
    v.incident.id !== `incident-${v.incident.evidenceSha256}` ||
    !count(v.incident.sequence, Number.MAX_SAFE_INTEGER) ||
    v.incident.sequence < 1 ||
    !stamp(v.incident.recordedAt) ||
    !stamp(v.checkedAt) ||
    !(v.currentPolicySha256 === null || hash(v.currentPolicySha256)) ||
    !member(v.status, [
      'matched',
      'not-recorded',
      'invalid-reference',
      'permit-unavailable',
      'different-workspace',
      'session-mismatch',
      'time-mismatch',
      'evidence-unavailable',
    ]) ||
    !closed(v.journal, ['status', 'sha256']) ||
    !member(v.journal.status, ['verified', 'missing', 'broken', 'limit', 'unavailable']) ||
    !(v.journal.sha256 === null || hash(v.journal.sha256)) ||
    (v.journal.status === 'missing' && v.journal.sha256 !== null) ||
    (v.journal.status === 'verified' && !hash(v.journal.sha256)) ||
    v.historicalPermitRelation !== 'not-recorded' ||
    !member(v.sessionRelation, ['matches', 'differs', 'unavailable']) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== INCIDENT_TASK_LIMITATIONS.length ||
    !v.limitations.every((item, i) => item === INCIDENT_TASK_LIMITATIONS[i])
  )
    return false;
  if (v.status === 'evidence-unavailable')
    return (
      v.journal.status !== 'verified' &&
      v.task === null &&
      v.relation === 'none' &&
      v.sessionRelation === 'unavailable'
    );
  if (v.journal.status !== 'verified') return false;
  if (v.status !== 'matched')
    return (
      v.task === null &&
      v.relation === 'none' &&
      (v.status === 'session-mismatch'
        ? v.sessionRelation === 'differs'
        : v.status === 'time-mismatch'
          ? v.sessionRelation !== 'differs'
          : v.sessionRelation === 'unavailable')
    );
  if (
    !validateTaskLockRow(v.task) ||
    v.relation !== 'task-id-only' ||
    v.sessionRelation === 'differs' ||
    v.task.evidence.status !== 'verified' ||
    v.task.evidence.journalSha256 !== v.journal.sha256 ||
    !taskLockRowMatchesCapture(v.task, v.currentPolicySha256 as string | null, v.checkedAt)
  )
    return false;
  const recordedAt = Date.parse(v.incident.recordedAt);
  return (
    Date.parse(v.task.issuedAt) <= recordedAt + 60_000 && recordedAt < Date.parse(v.task.expiresAt)
  );
}
