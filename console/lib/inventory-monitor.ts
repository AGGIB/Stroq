import { validateInventoryItem, type InventoryItem } from './inventory';
import { WORKSPACE_MONITOR_ERRORS } from './workspace-monitor';
import { closed, count, hash, list, member, stamp } from './local-guards';

export const INVENTORY_MONITOR_INTERVAL_MS = 300000 as const;
export const INVENTORY_MONITOR_HISTORY_LIMIT = 16;
export const INVENTORY_MONITOR_CHANGE_LIMIT = 64;
export const INVENTORY_MONITOR_LIMITATIONS = [
  'Checks fixed project and user skill sources and supported MCP JSON configuration every five minutes while this local console runs. A saved opt-in resumes only for the same verified workspace, profile and runtime.',
  'Captures private, unencrypted derived metadata locally, without retaining source files. It never executes skills, project commands or MCP servers, calls a provider, grants trust, accepts review or applies containment.',
  'Retains at most 16 observed versions within 8 MiB per workspace. Unchanged checks update the last observation time; older history may be evicted. Each public version shows at most 64 change rows with explicit omissions.',
  'Partial or failed checks cannot establish removal. Captured history is historical; current review, signal decisions and actions require their own fresh evidence. Loaded instructions, other roots and unsupported client channels remain outside this watch.',
] as const;
export const INVENTORY_MONITOR_ERRORS = [
  ...WORKSPACE_MONITOR_ERRORS,
  'inventory-busy',
  'inventory-unavailable',
  'observation-store-invalid',
  'observation-store-unavailable',
  'observation-store-stale',
  'observation-store-limit',
  'observation-write-unconfirmed',
] as const;
export type InventoryMonitorError = (typeof INVENTORY_MONITOR_ERRORS)[number];
export type InventoryObservedArtifact = Pick<
  InventoryItem,
  'id' | 'kind' | 'name' | 'agent' | 'scope' | 'skillSource' | 'location'
>;
export interface InventoryObservedChange {
  kind: 'added' | 'changed' | 'removed' | 'observed' | 'unverifiable';
  artifact: InventoryObservedArtifact;
  beforeSha256: string | null;
  afterSha256: string | null;
}
export interface InventoryObservationRecord {
  id: string;
  firstObservedAt: string;
  lastObservedAt: string;
  runtimeSha256: string;
  observationSha256: string;
  itemCount: number;
  complete: boolean;
  gaps: number;
  changes: {
    status: 'first' | 'comparable' | 'partial' | 'runtime-changed';
    fromId: string | null;
    total: number;
    rows: InventoryObservedChange[];
    omitted: number;
  };
}
export interface InventoryMonitorAttempt {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  error: InventoryMonitorError | null;
  checkId: string;
  captureId: string | null;
}
export interface InventoryMonitorState {
  schema: 'stroq-inventory-monitor/1';
  workspaceId: string;
  status: 'disabled' | 'enabled' | 'needs-review' | 'in-use' | 'unavailable' | 'stopped';
  reason: InventoryMonitorError | null;
  revision: string | null;
  configuredAt: string | null;
  runtimeSha256: string | null;
  intervalMs: 300000;
  nextCheckAt: string | null;
  lastAttempt: InventoryMonitorAttempt | null;
  latestCheckId: string | null;
  latestCaptureId: string | null;
  history: {
    status: 'missing' | 'ready' | 'unavailable';
    revision: string | null;
    records: InventoryObservationRecord[];
    omitted: number;
  };
}
export interface InventoryMonitorPreview {
  schema: 'stroq-inventory-monitor-preview/1';
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
export interface InventoryMonitorReceipt {
  schema: 'stroq-inventory-monitor-receipt/1';
  previewId: string;
  workspaceId: string;
  action: 'enable' | 'pause';
  completedAt: string;
  revision: string;
  runtimeSha256: string;
  enabled: boolean;
  hostEnforcement: false;
}

const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v);
const nullableStamp = (v: unknown) => v === null || stamp(v);
const nullableId = (v: unknown) => v === null || uuid(v);
const error = (v: unknown) => v === null || member(v, INVENTORY_MONITOR_ERRORS);
export function validateInventoryObservedArtifact(v: unknown): v is InventoryObservedArtifact {
  if (!closed(v, ['id', 'kind', 'name', 'agent', 'scope', 'skillSource', 'location'])) return false;
  return validateInventoryItem({
    ...v,
    fileType: v.kind === 'skill' ? 'skill-tree' : 'mcp-config',
    sha256: 'a'.repeat(64),
    reviewedSha256: null,
    state: 'unreviewed',
    scan: { status: 'not-scanned', findings: 0 },
    ...(v.kind === 'skill'
      ? { capabilities: [] }
      : { mcp: { transport: 'unknown', wrapper: 'unknown', strict: false } }),
  });
}
export function validateInventoryObservedChange(v: unknown): v is InventoryObservedChange {
  if (
    !exact(v, ['kind', 'artifact', 'beforeSha256', 'afterSha256']) ||
    !member(v.kind, ['added', 'changed', 'removed', 'observed', 'unverifiable']) ||
    !validateInventoryObservedArtifact(v.artifact) ||
    !nullableHash(v.beforeSha256) ||
    !nullableHash(v.afterSha256)
  )
    return false;
  if (v.kind === 'added') return v.beforeSha256 === null && hash(v.afterSha256);
  if (v.kind === 'removed') return hash(v.beforeSha256) && v.afterSha256 === null;
  if (v.kind === 'changed') return hash(v.beforeSha256) && hash(v.afterSha256);
  if (v.kind === 'observed') return hash(v.afterSha256);
  return true;
}
export function validateInventoryObservationRecord(v: unknown): v is InventoryObservationRecord {
  if (
    !exact(v, [
      'id',
      'firstObservedAt',
      'lastObservedAt',
      'runtimeSha256',
      'observationSha256',
      'itemCount',
      'complete',
      'gaps',
      'changes',
    ]) ||
    !uuid(v.id) ||
    !stamp(v.firstObservedAt) ||
    !stamp(v.lastObservedAt) ||
    v.lastObservedAt < v.firstObservedAt ||
    !hash(v.runtimeSha256) ||
    !hash(v.observationSha256) ||
    !count(v.itemCount, 512) ||
    typeof v.complete !== 'boolean' ||
    !count(v.gaps, 4096) ||
    (v.complete && v.gaps !== 0) ||
    !exact(v.changes, ['status', 'fromId', 'total', 'rows', 'omitted'])
  )
    return false;
  const c = v.changes;
  if (
    !member(c.status, ['first', 'comparable', 'partial', 'runtime-changed']) ||
    !nullableId(c.fromId) ||
    !count(c.total, 1024) ||
    !count(c.omitted, 1024) ||
    !list(c.rows, INVENTORY_MONITOR_CHANGE_LIMIT, validateInventoryObservedChange) ||
    c.total !== c.rows.length + c.omitted ||
    new Set(c.rows.map((row) => row.artifact.id)).size !== c.rows.length
  )
    return false;
  if (c.status === 'first') return c.fromId === null && c.total === 0;
  if (c.status === 'runtime-changed') return uuid(c.fromId) && c.total === 0;
  return uuid(c.fromId);
}
function attempt(v: unknown): v is InventoryMonitorAttempt {
  if (
    !exact(v, ['status', 'startedAt', 'finishedAt', 'error', 'checkId', 'captureId']) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled', 'skipped']) ||
    !stamp(v.startedAt) ||
    !nullableStamp(v.finishedAt) ||
    !error(v.error) ||
    !uuid(v.checkId) ||
    !nullableId(v.captureId)
  )
    return false;
  if (v.status === 'running')
    return v.finishedAt === null && v.error === null && v.captureId === null;
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  return v.status === 'completed'
    ? uuid(v.captureId) && v.error === null
    : v.captureId === null && v.error !== null;
}
export function validateInventoryMonitorState(v: unknown): v is InventoryMonitorState {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'status',
      'reason',
      'revision',
      'configuredAt',
      'runtimeSha256',
      'intervalMs',
      'nextCheckAt',
      'lastAttempt',
      'latestCheckId',
      'latestCaptureId',
      'history',
    ]) ||
    v.schema !== 'stroq-inventory-monitor/1' ||
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
    v.intervalMs !== INVENTORY_MONITOR_INTERVAL_MS ||
    !nullableStamp(v.nextCheckAt) ||
    !(v.lastAttempt === null || attempt(v.lastAttempt)) ||
    !nullableId(v.latestCheckId) ||
    !nullableId(v.latestCaptureId) ||
    !exact(v.history, ['status', 'revision', 'records', 'omitted'])
  )
    return false;
  if (
    (v.revision === null) !== (v.configuredAt === null) ||
    (v.status === 'enabled' && (!hash(v.revision) || !hash(v.runtimeSha256))) ||
    (v.status !== 'enabled' && v.nextCheckAt !== null) ||
    (v.latestCheckId === null) !== (v.latestCaptureId === null)
  )
    return false;
  const h = v.history;
  if (
    !member(h.status, ['missing', 'ready', 'unavailable']) ||
    !nullableHash(h.revision) ||
    !count(h.omitted, 1000000000) ||
    !list(h.records, INVENTORY_MONITOR_HISTORY_LIMIT, validateInventoryObservationRecord) ||
    new Set(h.records.map((row) => row.id)).size !== h.records.length
  )
    return false;
  if (h.status !== 'ready')
    return (
      h.revision === null && h.records.length === 0 && h.omitted === 0 && v.latestCaptureId === null
    );
  return (
    hash(h.revision) &&
    h.records.length > 0 &&
    v.latestCaptureId === h.records[0]?.id &&
    uuid(v.latestCheckId)
  );
}
export function validateInventoryMonitorPreview(v: unknown): v is InventoryMonitorPreview {
  return (
    exact(v, [
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
    v.schema === 'stroq-inventory-monitor-preview/1' &&
    uuid(v.id) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) > Date.parse(v.createdAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    workspace(v.workspaceId) &&
    member(v.action, ['enable', 'pause']) &&
    nullableHash(v.expectedRevision) &&
    hash(v.runtimeSha256) &&
    v.intervalMs === INVENTORY_MONITOR_INTERVAL_MS &&
    v.hostEnforcement === false
  );
}
export function validateInventoryMonitorReceipt(v: unknown): v is InventoryMonitorReceipt {
  return (
    exact(v, [
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
    v.schema === 'stroq-inventory-monitor-receipt/1' &&
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
