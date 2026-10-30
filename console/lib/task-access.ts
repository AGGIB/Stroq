import { closed, count, hash, member, stamp } from './local-guards';
import { unsafeCodePoints } from './shell';
import { hiddenCharacterError, validateTaskAccessReview } from './task-access-review';
import { isTaskLockId, validateTaskLockRow, type TaskLockRow } from './task-locks';
export const TASK_ACCESS_LIMITATIONS = [
  'One-use permissions apply only to the captured task launch and operation fingerprint.',
  'Read-target permission names the file target, resolved where available, not read offsets; other permissions bind the complete call.',
  'Additional missing permissions may still refuse a retry. No operation is started by issuing permission.',
  'Consumed means the gate spent the permission, not that the tool executed or completed.',
  'Existing extension files are not a complete issuance history; missing older metadata stays unverified.',
] as const;
export const TASK_ACCESS_ERRORS = [
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'task-unavailable',
  'stale-evidence',
  'unsafe-source',
  'legacy-refusal',
  'refusal-unavailable',
  'operation-unavailable',
  'signing-key-unavailable',
  'signing-key-mismatch',
  'permission-unavailable',
  'permission-active',
  'preview-stale',
  'preview-expired',
  'task-lock-busy',
  'deadline-exceeded',
  'invalid-report',
  'server-stopped',
  'write-unconfirmed',
  'task-access-failed',
] as const;
export type TaskAccessError = (typeof TASK_ACCESS_ERRORS)[number];
/**
 * One refusal for each character the review screen would not show as it is, named by code point
 * (`hidden-character-202e`): a closed list, made from the same table that finds the character.
 */
const HIDDEN_CHARACTER_MESSAGES = Object.fromEntries(
  unsafeCodePoints().map((code) => [
    hiddenCharacterError(code),
    `The refused operation contains U+${code.toString(16).toUpperCase().padStart(4, '0')}, a character that shows nothing or changes how the text around it reads, so the review cannot show exactly what would be allowed. Access cannot be issued from this record.`,
  ]),
) as Record<`hidden-character-${string}`, string>;
export const TASK_ACCESS_ERROR_MESSAGES: Readonly<
  Record<TaskAccessError | `hidden-character-${string}`, string>
> = {
  ...HIDDEN_CHARACTER_MESSAGES,
  'runtime-unavailable': 'The local runtime is unavailable.',
  'context-unavailable': 'The selected workspace could not be verified.',
  'platform-unsupported': 'One-use permission is unsupported on this platform.',
  'task-unavailable': 'The current task permit is unavailable or no longer eligible.',
  'stale-evidence': 'The selected refusal changed. Recheck the exact finding.',
  'unsafe-source': 'The permission source could not be read safely.',
  'legacy-refusal':
    'No signed request is available. Use a fresh Task Lock to request one-use access.',
  'refusal-unavailable': 'This finding is not a current extendable task refusal.',
  'operation-unavailable':
    'A complete review is unavailable. Access cannot be issued from this record.',
  'signing-key-unavailable': 'The existing signing key is unavailable. No key was created.',
  'signing-key-mismatch': 'The existing signing key does not match this task.',
  'permission-unavailable': 'Existing one-use permissions could not be verified.',
  'permission-active':
    'An extension file already exists for this operation. It will not be replaced.',
  'preview-stale': 'The refusal, permit or signing context changed. Prepare a fresh preview.',
  'preview-expired': 'The preview expired. Prepare it again.',
  'task-lock-busy': 'Another task permission operation is running. Recheck when it finishes.',
  'deadline-exceeded': 'The operation exceeded its deadline.',
  'invalid-report': 'The permission report could not be verified.',
  'server-stopped': 'The local server stopped before completion.',
  'write-unconfirmed':
    'Issue completion is unknown. Recheck existing permissions before another action.',
  'task-access-failed': 'One-use permission could not be issued.',
};
export interface TaskAccessIncident {
  id: string;
  evidenceSha256: string;
  sequence: number;
  recordedAt: string;
}
export interface TaskAccessPreview {
  schema: 'stroq-task-access-preview/1';
  id: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  grantExpiresAt: string;
  incident: TaskAccessIncident;
  task: TaskLockRow;
  operation: {
    tool: string;
    review: string;
    kind: 'read-target' | 'whole-call';
    fingerprint: string;
    requiredCount: number;
  };
  limitations: typeof TASK_ACCESS_LIMITATIONS;
}
export interface TaskAccessReceipt {
  schema: 'stroq-task-access-receipt/1';
  id: string;
  workspaceId: string;
  previewId: string;
  incident: TaskAccessIncident;
  taskId: string;
  permitSha256: string;
  fingerprint: string;
  extensionSha256: string;
  issuedAt: string;
  expiresAt: string;
  state: 'unused' | 'consumed';
  execution: 'unverified';
  limitations: typeof TASK_ACCESS_LIMITATIONS;
}
export interface TaskAccessPermission {
  fingerprint: string;
  extensionSha256: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  state: 'unused' | 'consumed' | 'expired' | 'invalid';
}
export interface TaskAccessState {
  schema: 'stroq-task-access/1';
  workspaceId: string;
  taskId: string;
  permitSha256: string;
  checkedAt: string;
  coverage: { complete: boolean; limited: boolean; unverified: number };
  permissions: TaskAccessPermission[];
  limitations: typeof TASK_ACCESS_LIMITATIONS;
}
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const limits = (v: unknown) =>
  Array.isArray(v) &&
  v.length === TASK_ACCESS_LIMITATIONS.length &&
  v.every((s, i) => s === TASK_ACCESS_LIMITATIONS[i]);
function incident(v: unknown): v is TaskAccessIncident {
  return (
    exact(v, ['id', 'evidenceSha256', 'sequence', 'recordedAt']) &&
    hash(v.evidenceSha256) &&
    v.id === `incident-${v.evidenceSha256}` &&
    count(v.sequence, Number.MAX_SAFE_INTEGER) &&
    v.sequence > 0 &&
    stamp(v.recordedAt)
  );
}
export function validateTaskAccessPreview(v: unknown): v is TaskAccessPreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'workspaceId',
      'createdAt',
      'expiresAt',
      'grantExpiresAt',
      'incident',
      'task',
      'operation',
      'limitations',
    ]) ||
    v.schema !== 'stroq-task-access-preview/1' ||
    !uuid(v.id) ||
    !workspace(v.workspaceId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    !stamp(v.grantExpiresAt) ||
    !incident(v.incident) ||
    !validateTaskLockRow(v.task) ||
    v.task.evidence.status !== 'verified' ||
    !exact(v.operation, ['tool', 'review', 'kind', 'fingerprint', 'requiredCount']) ||
    typeof v.operation.tool !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(v.operation.tool) ||
    !validateTaskAccessReview(
      v.operation.review,
      v.operation.tool,
      v.operation.kind as 'read-target' | 'whole-call',
    ) ||
    !member(v.operation.kind, ['read-target', 'whole-call']) ||
    (v.operation.kind === 'read-target' && v.operation.tool !== 'Read') ||
    !hash(v.operation.fingerprint) ||
    !count(v.operation.requiredCount, 16) ||
    v.operation.requiredCount < 1 ||
    !limits(v.limitations)
  )
    return false;
  const at = Date.parse(v.createdAt),
    end = Date.parse(v.grantExpiresAt);
  return (
    Date.parse(v.expiresAt) > at &&
    Date.parse(v.expiresAt) - at <= 120000 &&
    end > at &&
    end - at <= 300000 &&
    Date.parse(v.expiresAt) <= end &&
    end <= Date.parse(v.task.expiresAt) &&
    v.task.standing === 'present' &&
    v.task.eligibility === 'eligible' &&
    v.task.policyRelation === 'matches-current' &&
    Date.parse(v.task.issuedAt) <= at + 60000 &&
    Date.parse(v.task.expiresAt) > at &&
    Date.parse(v.incident.recordedAt) <= at + 60000 &&
    Date.parse(v.task.issuedAt) <= Date.parse(v.incident.recordedAt) + 60000
  );
}
export function validateTaskAccessReceipt(v: unknown): v is TaskAccessReceipt {
  return (
    exact(v, [
      'schema',
      'id',
      'workspaceId',
      'previewId',
      'incident',
      'taskId',
      'permitSha256',
      'fingerprint',
      'extensionSha256',
      'issuedAt',
      'expiresAt',
      'state',
      'execution',
      'limitations',
    ]) &&
    v.schema === 'stroq-task-access-receipt/1' &&
    uuid(v.id) &&
    uuid(v.previewId) &&
    workspace(v.workspaceId) &&
    incident(v.incident) &&
    isTaskLockId(v.taskId) &&
    hash(v.permitSha256) &&
    hash(v.fingerprint) &&
    hash(v.extensionSha256) &&
    stamp(v.issuedAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.issuedAt &&
    Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= 300000 &&
    member(v.state, ['unused', 'consumed']) &&
    v.execution === 'unverified' &&
    limits(v.limitations)
  );
}
function permission(v: unknown, at: string): v is TaskAccessPermission {
  if (
    !exact(v, ['fingerprint', 'extensionSha256', 'issuedAt', 'expiresAt', 'state']) ||
    !hash(v.fingerprint) ||
    !member(v.state, ['unused', 'consumed', 'expired', 'invalid'])
  )
    return false;
  if (v.state === 'invalid')
    return (
      (v.extensionSha256 === null || hash(v.extensionSha256)) &&
      v.issuedAt === null &&
      v.expiresAt === null
    );
  if (
    !hash(v.extensionSha256) ||
    !stamp(v.issuedAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.issuedAt ||
    Date.parse(v.expiresAt) - Date.parse(v.issuedAt) > 600000
  )
    return false;
  return v.state === 'consumed' || (v.state === 'expired' ? v.expiresAt <= at : v.expiresAt > at);
}
export function validateTaskAccessState(v: unknown): v is TaskAccessState {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'taskId',
      'permitSha256',
      'checkedAt',
      'coverage',
      'permissions',
      'limitations',
    ]) ||
    v.schema !== 'stroq-task-access/1' ||
    !workspace(v.workspaceId) ||
    !isTaskLockId(v.taskId) ||
    !hash(v.permitSha256) ||
    !stamp(v.checkedAt) ||
    !exact(v.coverage, ['complete', 'limited', 'unverified']) ||
    typeof v.coverage.complete !== 'boolean' ||
    typeof v.coverage.limited !== 'boolean' ||
    !count(v.coverage.unverified, 1000000) ||
    !Array.isArray(v.permissions) ||
    v.permissions.length > 64 ||
    !limits(v.limitations)
  )
    return false;
  return (
    v.coverage.complete === (!v.coverage.limited && v.coverage.unverified === 0) &&
    v.coverage.unverified >= v.permissions.filter((p) => p.state === 'invalid').length &&
    v.permissions.every((p) => permission(p, v.checkedAt as string)) &&
    new Set(v.permissions.map((p) => p.fingerprint)).size === v.permissions.length
  );
}
