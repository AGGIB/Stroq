import { closed, hash, member, stamp } from './local-guards';
import { WORKSPACE_REVIEW_ERRORS } from './workspace-review';

export const WORKSPACE_MONITOR_LIMITATIONS = [
  'Runs bounded static workspace checks every five minutes while this local console is running. Closing the console stops checks; a saved opt-in resumes only for the same workspace and verified runtime.',
  'Project commands, hooks, dependencies and MCP servers are not started. No content is sent to a model, and checks do not grant trust or establish native host blocking.',
  'Stores the opt-in and the existing bounded history of source fingerprints and execution-surface signals locally. At most 32 attempts within 8 MiB are retained; older reports can be evicted.',
  'Checks do not accept a new reviewed baseline. Runtime or workspace identity changes require a fresh review. A check already accepted before pause may finish.',
] as const;
export const WORKSPACE_MONITOR_ERRORS = [
  ...WORKSPACE_REVIEW_ERRORS,
  'monitor-store-invalid',
  'monitor-store-unavailable',
  'monitor-store-stale',
  'monitor-store-limit',
  'monitor-store-write-unconfirmed',
  'monitor-in-use',
] as const;
export type WorkspaceMonitorError = (typeof WORKSPACE_MONITOR_ERRORS)[number];
export interface WorkspaceMonitorAttempt {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  runId: string | null;
  error: WorkspaceMonitorError | null;
}
export interface WorkspaceMonitorState {
  schema: 'stroq-workspace-monitor/1';
  workspaceId: string;
  status: 'disabled' | 'enabled' | 'needs-review' | 'in-use' | 'unavailable' | 'stopped';
  reason: WorkspaceMonitorError | null;
  revision: string | null;
  configuredAt: string | null;
  runtimeSha256: string | null;
  intervalMs: 300000;
  nextCheckAt: string | null;
  activeRunId: string | null;
  lastAttempt: WorkspaceMonitorAttempt | null;
}
export interface WorkspaceMonitorPreview {
  schema: 'stroq-workspace-monitor-preview/1';
  id: string;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  action: 'enable' | 'pause';
  expectedRevision: string | null;
  runtimeSha256: string;
  intervalMs: 300000;
  hostEnforcement: false;
}
export interface WorkspaceMonitorReceipt {
  schema: 'stroq-workspace-monitor-receipt/1';
  previewId: string;
  workspaceId: string;
  action: 'enable' | 'pause';
  completedAt: string;
  revision: string;
  runtimeSha256: string;
  enabled: boolean;
  hostEnforcement: false;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown): v is string =>
  typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v);
const nullableStamp = (v: unknown) => v === null || stamp(v);
const error = (v: unknown) => v === null || member(v, WORKSPACE_MONITOR_ERRORS);
function attempt(v: unknown): v is WorkspaceMonitorAttempt {
  if (
    !closed(v, ['status', 'startedAt', 'finishedAt', 'runId', 'error']) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled', 'skipped']) ||
    !stamp(v.startedAt) ||
    !nullableStamp(v.finishedAt) ||
    !(v.runId === null || uuid(v.runId)) ||
    !error(v.error)
  )
    return false;
  if (v.status === 'running') return v.finishedAt === null && v.error === null;
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  return v.status === 'completed' ? uuid(v.runId) && v.error === null : v.error !== null;
}
export function validateWorkspaceMonitorState(v: unknown): v is WorkspaceMonitorState {
  if (
    !closed(v, [
      'schema',
      'workspaceId',
      'status',
      'reason',
      'revision',
      'configuredAt',
      'runtimeSha256',
      'intervalMs',
      'nextCheckAt',
      'activeRunId',
      'lastAttempt',
    ]) ||
    v.schema !== 'stroq-workspace-monitor/1' ||
    !workspace(v.workspaceId) ||
    !member(v.status, [
      'disabled',
      'enabled',
      'needs-review',
      'in-use',
      'unavailable',
      'stopped',
    ]) ||
    !error(v.reason) ||
    !nullableHash(v.revision) ||
    !nullableStamp(v.configuredAt) ||
    !nullableHash(v.runtimeSha256) ||
    v.intervalMs !== 300000 ||
    !nullableStamp(v.nextCheckAt) ||
    !(v.activeRunId === null || uuid(v.activeRunId)) ||
    !(v.lastAttempt === null || attempt(v.lastAttempt))
  )
    return false;
  if ((v.revision === null) !== (v.configuredAt === null)) return false;
  if (v.status === 'enabled' && (!hash(v.revision) || !hash(v.runtimeSha256))) return false;
  if (v.status !== 'enabled' && v.nextCheckAt !== null) return false;
  if (
    v.activeRunId !== null &&
    (!v.lastAttempt || v.lastAttempt.status !== 'running' || v.lastAttempt.runId !== v.activeRunId)
  )
    return false;
  return true;
}
export function validateWorkspaceMonitorPreview(v: unknown): v is WorkspaceMonitorPreview {
  return (
    closed(v, [
      'schema',
      'id',
      'createdAt',
      'expiresAt',
      'workspaceId',
      'action',
      'expectedRevision',
      'runtimeSha256',
      'intervalMs',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-workspace-monitor-preview/1' &&
    uuid(v.id) &&
    workspace(v.workspaceId) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) > Date.parse(v.createdAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    member(v.action, ['enable', 'pause']) &&
    nullableHash(v.expectedRevision) &&
    hash(v.runtimeSha256) &&
    v.intervalMs === 300000 &&
    v.hostEnforcement === false
  );
}
export function validateWorkspaceMonitorReceipt(v: unknown): v is WorkspaceMonitorReceipt {
  return (
    closed(v, [
      'schema',
      'previewId',
      'workspaceId',
      'action',
      'completedAt',
      'revision',
      'runtimeSha256',
      'enabled',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-workspace-monitor-receipt/1' &&
    uuid(v.previewId) &&
    workspace(v.workspaceId) &&
    member(v.action, ['enable', 'pause']) &&
    stamp(v.completedAt) &&
    hash(v.revision) &&
    hash(v.runtimeSha256) &&
    v.enabled === (v.action === 'enable') &&
    v.hostEnforcement === false
  );
}
