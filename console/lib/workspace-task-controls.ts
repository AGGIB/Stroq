import { closed, count, hash, member, stamp } from './local-guards';

export const WORKSPACE_TASK_SOURCE_ID =
  'source-8f641aeae255bfea9c88207ea743e9f725240d6b0f87579dec92a5f3780b3079';
export const WORKSPACE_TASK_ERRORS = [
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'tasks-busy',
  'history-unavailable',
  'stale-capture',
  'stale-source',
  'preview-stale',
  'unsupported-task-config',
  'no-automatic-tasks',
  'recovery-unavailable',
  'recovery-required',
  'recovery-full',
  'unsafe-source',
  'write-unconfirmed',
  'deadline-exceeded',
  'cancelled',
  'server-stopped',
  'capture-unavailable',
  'invalid-report',
  'task-controls-unavailable',
] as const;
export type WorkspaceTaskError = (typeof WORKSPACE_TASK_ERRORS)[number];
export const WORKSPACE_TASK_ERROR_MESSAGES: Record<WorkspaceTaskError, string> = {
  'runtime-unavailable': 'The local engine is unavailable. Reconnect and try again.',
  'context-unavailable': 'The workspace could not be verified. Reconnect and try again.',
  'platform-unsupported': 'This operation is unavailable on this platform.',
  'tasks-busy': 'Another configuration operation is in progress. Try again after it finishes.',
  'history-unavailable': 'Recovery storage could not be verified. Check local storage first.',
  'stale-capture': 'The saved capture no longer matches. Capture the workspace again.',
  'stale-source': 'The task file changed. Capture the workspace and preview again.',
  'preview-stale': 'This preview is no longer valid. Preview the change again.',
  'unsupported-task-config': 'This task configuration cannot be safely edited automatically.',
  'no-automatic-tasks': 'No supported automatic task triggers were found in this file.',
  'recovery-unavailable': 'The exact recovery record or backup could not be verified.',
  'recovery-required': 'Recheck the previous change before starting another.',
  'recovery-full': 'Recovery storage is full. No file was changed.',
  'unsafe-source': 'The task file or its parent folders could not be safely verified.',
  'write-unconfirmed': 'The file change could not be confirmed. Recheck the recovery record.',
  'deadline-exceeded': 'The operation timed out. Recheck any pending change.',
  cancelled: 'The operation was interrupted. Recheck any pending change.',
  'server-stopped': 'The local server stopped. Reconnect and recheck the recovery record.',
  'capture-unavailable':
    'A fresh static capture is unavailable. The file result is shown separately.',
  'invalid-report': 'The local response could not be verified.',
  'task-controls-unavailable': 'Task controls are unavailable. Reconnect and try again.',
};

export interface WorkspaceTaskChanges {
  folderOpen: number;
  worktreeCreated: number;
}
export interface WorkspaceTaskBinding {
  runId: string;
  captureSha256: string;
  sourceId: typeof WORKSPACE_TASK_SOURCE_ID;
  sourceSha256: string;
  sourceMode: number;
  captureComplete: boolean;
}
export type WorkspaceTaskVerification =
  | {
      status: 'recorded';
      runId: string;
      captureSha256: string;
      capturedAt: string;
      complete: boolean;
      sourceMatches: boolean;
    }
  | { status: 'unavailable'; runId: string | null; error: WorkspaceTaskError };
export interface WorkspaceTaskRecord {
  id: string;
  revision: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  status: 'prepared' | 'manual' | 'restoring' | 'restored' | 'unchanged' | 'uncertain';
  binding: WorkspaceTaskBinding;
  originalSha256: string;
  manualSha256: string;
  mode: number;
  changes: WorkspaceTaskChanges;
  fileState: 'manual-version' | 'original-version' | 'changed' | 'missing' | 'unverifiable';
  recoveryAvailable: boolean;
  canRestore: boolean;
  verification: WorkspaceTaskVerification | null;
  hostEnforcement: false;
}
export interface WorkspaceTaskPreview {
  schema: 'stroq-workspace-task-preview/1';
  id: string;
  workspaceId: string;
  operation: 'make-manual' | 'restore';
  recordId: string;
  recordRevision: string | null;
  createdAt: string;
  expiresAt: string;
  binding: WorkspaceTaskBinding;
  beforeSha256: string;
  afterSha256: string;
  changes: WorkspaceTaskChanges;
  sourceMode: number;
  manualTasksPreserved: true;
  formattingPreserved: true;
  completeFileBackup: true;
  hostEnforcement: false;
}
export interface WorkspaceTaskState {
  schema: 'stroq-workspace-task-controls/1';
  workspaceId: string;
  generatedAt: string;
  available: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  error: WorkspaceTaskError | null;
  records: WorkspaceTaskRecord[];
}
export interface WorkspaceTaskReceipt {
  schema: 'stroq-workspace-task-receipt/1';
  workspaceId: string;
  operation: 'make-manual' | 'restore' | 'recheck';
  checkedAt: string;
  writeConfirmed: boolean;
  record: WorkspaceTaskRecord;
}

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export function validateWorkspaceTaskChanges(v: unknown): v is WorkspaceTaskChanges {
  return (
    exact(v, ['folderOpen', 'worktreeCreated']) &&
    count(v.folderOpen, 256) &&
    count(v.worktreeCreated, 256) &&
    v.folderOpen + v.worktreeCreated > 0 &&
    v.folderOpen + v.worktreeCreated <= 256
  );
}
export function validateWorkspaceTaskBinding(v: unknown): v is WorkspaceTaskBinding {
  return (
    exact(v, [
      'runId',
      'captureSha256',
      'sourceId',
      'sourceSha256',
      'sourceMode',
      'captureComplete',
    ]) &&
    uuid(v.runId) &&
    hash(v.captureSha256) &&
    v.sourceId === WORKSPACE_TASK_SOURCE_ID &&
    hash(v.sourceSha256) &&
    count(v.sourceMode, 511) &&
    typeof v.captureComplete === 'boolean'
  );
}
export function validateWorkspaceTaskVerification(v: unknown): v is WorkspaceTaskVerification {
  if (exact(v, ['status', 'runId', 'error']))
    return (
      v.status === 'unavailable' &&
      (v.runId === null || uuid(v.runId)) &&
      member(v.error, WORKSPACE_TASK_ERRORS)
    );
  return (
    exact(v, ['status', 'runId', 'captureSha256', 'capturedAt', 'complete', 'sourceMatches']) &&
    v.status === 'recorded' &&
    uuid(v.runId) &&
    hash(v.captureSha256) &&
    stamp(v.capturedAt) &&
    typeof v.complete === 'boolean' &&
    typeof v.sourceMatches === 'boolean'
  );
}
export function validateWorkspaceTaskRecord(v: unknown): v is WorkspaceTaskRecord {
  return (
    exact(v, [
      'id',
      'revision',
      'workspaceId',
      'createdAt',
      'updatedAt',
      'status',
      'binding',
      'originalSha256',
      'manualSha256',
      'mode',
      'changes',
      'fileState',
      'recoveryAvailable',
      'canRestore',
      'verification',
      'hostEnforcement',
    ]) &&
    uuid(v.id) &&
    hash(v.revision) &&
    workspace(v.workspaceId) &&
    stamp(v.createdAt) &&
    stamp(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    member(v.status, ['prepared', 'manual', 'restoring', 'restored', 'unchanged', 'uncertain']) &&
    validateWorkspaceTaskBinding(v.binding) &&
    hash(v.originalSha256) &&
    hash(v.manualSha256) &&
    v.originalSha256 !== v.manualSha256 &&
    v.originalSha256 === v.binding.sourceSha256 &&
    v.mode === v.binding.sourceMode &&
    validateWorkspaceTaskChanges(v.changes) &&
    member(v.fileState, [
      'manual-version',
      'original-version',
      'changed',
      'missing',
      'unverifiable',
    ]) &&
    typeof v.recoveryAvailable === 'boolean' &&
    typeof v.canRestore === 'boolean' &&
    (!v.canRestore ||
      (v.status === 'manual' && v.fileState === 'manual-version' && v.recoveryAvailable)) &&
    (v.verification === null ||
      (validateWorkspaceTaskVerification(v.verification) &&
        (v.verification.status === 'unavailable' ||
          (v.verification.capturedAt >= v.createdAt &&
            v.verification.capturedAt <= v.updatedAt)))) &&
    v.hostEnforcement === false
  );
}
export function validateWorkspaceTaskPreview(v: unknown): v is WorkspaceTaskPreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'workspaceId',
      'operation',
      'recordId',
      'recordRevision',
      'createdAt',
      'expiresAt',
      'binding',
      'beforeSha256',
      'afterSha256',
      'changes',
      'sourceMode',
      'manualTasksPreserved',
      'formattingPreserved',
      'completeFileBackup',
      'hostEnforcement',
    ]) ||
    v.schema !== 'stroq-workspace-task-preview/1' ||
    !uuid(v.id) ||
    !workspace(v.workspaceId) ||
    !uuid(v.recordId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) !== 120000 ||
    !validateWorkspaceTaskBinding(v.binding) ||
    !hash(v.beforeSha256) ||
    !hash(v.afterSha256) ||
    v.beforeSha256 === v.afterSha256 ||
    !validateWorkspaceTaskChanges(v.changes) ||
    v.sourceMode !== v.binding.sourceMode ||
    v.manualTasksPreserved !== true ||
    v.formattingPreserved !== true ||
    v.completeFileBackup !== true ||
    v.hostEnforcement !== false
  )
    return false;
  return v.operation === 'make-manual'
    ? v.recordRevision === null && v.beforeSha256 === v.binding.sourceSha256
    : v.operation === 'restore' &&
        hash(v.recordRevision) &&
        v.afterSha256 === v.binding.sourceSha256;
}
export function validateWorkspaceTaskState(v: unknown): v is WorkspaceTaskState {
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
    v.schema === 'stroq-workspace-task-controls/1' &&
    workspace(v.workspaceId) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    (v.available
      ? v.error === null && v.history !== 'unavailable'
      : member(v.error, WORKSPACE_TASK_ERRORS) && v.history === 'unavailable') &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateWorkspaceTaskRecord) &&
    v.records.every(
      (r) => r.workspaceId === v.workspaceId && r.updatedAt <= (v.generatedAt as string),
    ) &&
    new Set(v.records.map((r) => r.id)).size === v.records.length &&
    (v.history !== 'missing' || v.records.length === 0)
  );
}
export function validateWorkspaceTaskReceipt(v: unknown): v is WorkspaceTaskReceipt {
  if (
    !exact(v, ['schema', 'workspaceId', 'operation', 'checkedAt', 'writeConfirmed', 'record']) ||
    v.schema !== 'stroq-workspace-task-receipt/1' ||
    !workspace(v.workspaceId) ||
    !stamp(v.checkedAt) ||
    typeof v.writeConfirmed !== 'boolean' ||
    !validateWorkspaceTaskRecord(v.record) ||
    v.record.workspaceId !== v.workspaceId ||
    v.record.updatedAt > v.checkedAt
  )
    return false;
  if (v.operation === 'recheck')
    return !v.writeConfirmed || member(v.record.status, ['manual', 'restored']);
  return (
    v.writeConfirmed &&
    (v.operation === 'make-manual'
      ? v.record.status === 'manual'
      : v.operation === 'restore' && v.record.status === 'restored')
  );
}
