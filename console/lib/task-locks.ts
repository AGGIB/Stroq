import { closed, count, hash, member, stamp } from './local-guards';

export const TASK_LOCK_LIMITATIONS = [
  'Signed permits describe recorded authority, not a running process or current OS enforcement.',
  'Task brokers retain their launch-time policy; current-file comparison does not prove adoption.',
  'Revocation denies later gated tools; agent termination is unverified.',
  'Journal consistency is not independent authenticity and cannot detect tail truncation.',
  'Path patterns outside the workspace and user home are withheld.',
] as const;
export const TASK_LOCK_ERRORS = [
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'task-unavailable',
  'preview-stale',
  'preview-expired',
  'task-lock-busy',
  'deadline-exceeded',
  'invalid-report',
  'server-stopped',
  'task-lock-failed',
  'write-unconfirmed',
  'unsafe-source',
  'task-page-stale',
  'task-page-expired',
  'task-lookup-limit',
] as const;
export type TaskLockError = (typeof TASK_LOCK_ERRORS)[number];
export interface SafeGlob {
  id: string;
  root: 'workspace' | 'home' | 'external';
  pattern: string | null;
}
export interface TaskLockScope {
  tools: string[];
  shell: 'allowed' | 'denied';
  read: { allow: SafeGlob[]; deny: SafeGlob[] };
  write: { allow: SafeGlob[]; deny: SafeGlob[] };
  net: { mode: 'none' } | { mode: 'hosts'; hosts: string[] };
  mcp: { server: string; tools: '*' | string[] }[];
}
export interface TaskLockEvidence {
  status: 'verified' | 'missing' | 'unavailable' | 'limit' | 'broken';
  journalSha256: string | null;
  counts: null | {
    calls: number;
    allowed: number;
    denied: number;
    asks: number;
    hostReported: number;
    hostFailure: number;
    unconfirmed: number;
  };
  lastGate: null | {
    at: string;
    effect: 'allow' | 'ask' | 'deny';
    kind: 'void' | 'hard' | 'scope' | 'ask' | 'policy' | 'escalated' | 'in-scope';
  };
}
export interface TaskLockRow {
  id: string;
  permitSha256: string;
  profile: string;
  policySha256: string;
  issuedAt: string;
  expiresAt: string;
  declaredMode: 'srt' | 'hook-only' | 'unknown';
  eligibility: 'eligible' | 'expired' | 'not-yet-valid';
  standing: 'present' | 'revoked' | 'ended';
  policyRelation: 'matches-current' | 'differs-current' | 'unavailable';
  scope: TaskLockScope;
  evidence: TaskLockEvidence;
}
export interface TaskLockState {
  schema: 'stroq-task-locks/1';
  workspaceId: string;
  host: 'claude-code';
  checkedAt: string;
  currentPolicySha256: string | null;
  available: boolean;
  reason: null | 'runtime-unavailable' | 'context-unavailable' | 'platform-unsupported';
  coverage: { complete: boolean; limited: boolean; unverified: number; foreign: number };
  tasks: TaskLockRow[];
  limitations: typeof TASK_LOCK_LIMITATIONS;
}
export interface TaskLockPreview {
  schema: 'stroq-task-lock-preview/1';
  id: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  task: TaskLockRow;
  bindingSha256: string;
  canApply: boolean;
  reason: null | 'already-revoked' | 'task-ended' | 'permit-expired';
}
export interface TaskLockReceipt {
  schema: 'stroq-task-lock-receipt/1';
  id: string;
  previewId: string;
  workspaceId: string;
  taskId: string;
  permitSha256: string;
  status: 'revoked';
  checkedAt: string;
  markerSha256: string;
  storeReadback: 'revoked';
  gateDecision: 'deny';
  gateRule: 'task-void:revoked';
  evidence: 'isolated-gate-evaluation';
  hostTermination: 'unverified';
  irreversible: true;
}
export const isTaskLockId = (v: unknown): v is string =>
  typeof v === 'string' && /^task-[a-f0-9]{64}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const name = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const names = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every(name);
/** Labels are relative display data, never executable paths or browser navigation targets. */
export function isTaskLockRelativePattern(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 1024 &&
    !/[\p{Cc}\p{Cf}]/u.test(v) &&
    !/^(?:[\\/]|[A-Za-z]:)/.test(v) &&
    (v === '.' || !v.split(/[\\/]/).some((s) => s === '.' || s === '..'))
  );
}
function glob(v: unknown): v is SafeGlob {
  return (
    closed(v, ['id', 'root', 'pattern']) &&
    hash(v.id) &&
    member(v.root, ['workspace', 'home', 'external']) &&
    (v.root === 'external'
      ? v.pattern === null
      : v.pattern === null || isTaskLockRelativePattern(v.pattern))
  );
}
function paths(v: unknown) {
  return (
    closed(v, ['allow', 'deny']) &&
    Array.isArray(v.allow) &&
    v.allow.length <= 256 &&
    v.allow.every(glob) &&
    Array.isArray(v.deny) &&
    v.deny.length <= 256 &&
    v.deny.every(glob)
  );
}
function host(v: unknown) {
  if (typeof v !== 'string' || v.length > 253) return false;
  const star = v.startsWith('*.');
  const labels = (star ? v.slice(2) : v).split('.');
  return (
    (!star || labels.length >= 2) &&
    labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
  );
}
function scope(v: unknown): v is TaskLockScope {
  return (
    closed(v, ['tools', 'shell', 'read', 'write', 'net', 'mcp']) &&
    names(v.tools, 64) &&
    member(v.shell, ['allowed', 'denied']) &&
    paths(v.read) &&
    paths(v.write) &&
    closed(v.net, ['mode', 'hosts']) &&
    (v.net.mode === 'none'
      ? !Object.hasOwn(v.net, 'hosts')
      : v.net.mode === 'hosts' &&
        Array.isArray(v.net.hosts) &&
        v.net.hosts.length <= 64 &&
        v.net.hosts.every(host)) &&
    Array.isArray(v.mcp) &&
    v.mcp.length <= 32 &&
    v.mcp.every(
      (m) =>
        closed(m, ['server', 'tools']) &&
        name(m.server) &&
        (m.tools === '*' || names(m.tools, 256)),
    )
  );
}
function evidence(v: unknown): v is TaskLockEvidence {
  if (
    !closed(v, ['status', 'journalSha256', 'counts', 'lastGate']) ||
    !member(v.status, ['verified', 'missing', 'unavailable', 'limit', 'broken']) ||
    !(v.journalSha256 === null || hash(v.journalSha256))
  )
    return false;
  if (v.status !== 'verified')
    return (
      v.counts === null &&
      v.lastGate === null &&
      (v.status !== 'missing' || v.journalSha256 === null)
    );
  if (
    !hash(v.journalSha256) ||
    !closed(v.counts, [
      'calls',
      'allowed',
      'denied',
      'asks',
      'hostReported',
      'hostFailure',
      'unconfirmed',
    ]) ||
    !Object.values(v.counts).every((n) => count(n, 1_000_000))
  )
    return false;
  const c = v.counts as TaskLockEvidence['counts'];
  if (
    !c ||
    c.calls !== c.allowed + c.denied + c.asks ||
    c.calls !== c.hostReported + c.hostFailure + c.unconfirmed
  )
    return false;
  return (
    v.lastGate === null ||
    (closed(v.lastGate, ['at', 'effect', 'kind']) &&
      stamp(v.lastGate.at) &&
      member(v.lastGate.effect, ['allow', 'ask', 'deny']) &&
      member(v.lastGate.kind, [
        'void',
        'hard',
        'scope',
        'ask',
        'policy',
        'escalated',
        'in-scope',
      ]) &&
      c.calls > 0)
  );
}
export function validateTaskLockRow(v: unknown): v is TaskLockRow {
  return (
    closed(v, [
      'id',
      'permitSha256',
      'profile',
      'policySha256',
      'issuedAt',
      'expiresAt',
      'declaredMode',
      'eligibility',
      'standing',
      'policyRelation',
      'scope',
      'evidence',
    ]) &&
    isTaskLockId(v.id) &&
    hash(v.permitSha256) &&
    typeof v.profile === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(v.profile) &&
    hash(v.policySha256) &&
    stamp(v.issuedAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.issuedAt &&
    Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= 86_400_000 &&
    member(v.declaredMode, ['srt', 'hook-only', 'unknown']) &&
    member(v.eligibility, ['eligible', 'expired', 'not-yet-valid']) &&
    member(v.standing, ['present', 'revoked', 'ended']) &&
    member(v.policyRelation, ['matches-current', 'differs-current', 'unavailable']) &&
    scope(v.scope) &&
    evidence(v.evidence)
  );
}
const eligibility = (row: TaskLockRow, at: string) =>
  Date.parse(row.expiresAt) <= Date.parse(at)
    ? 'expired'
    : Date.parse(row.issuedAt) > Date.parse(at) + 60_000
      ? 'not-yet-valid'
      : 'eligible';
/** Derive display relations from the same policy and time capture as the report. */
export function taskLockRowMatchesCapture(
  row: TaskLockRow,
  currentPolicySha256: string | null,
  checkedAt: string,
): boolean {
  return (
    row.eligibility === eligibility(row, checkedAt) &&
    row.policyRelation ===
      (currentPolicySha256 === null
        ? 'unavailable'
        : row.policySha256 === currentPolicySha256
          ? 'matches-current'
          : 'differs-current')
  );
}
export function validateTaskLockState(v: unknown): v is TaskLockState {
  if (
    !closed(v, [
      'schema',
      'workspaceId',
      'host',
      'checkedAt',
      'currentPolicySha256',
      'available',
      'reason',
      'coverage',
      'tasks',
      'limitations',
    ]) ||
    v.schema !== 'stroq-task-locks/1' ||
    !workspace(v.workspaceId) ||
    v.host !== 'claude-code' ||
    !stamp(v.checkedAt) ||
    !(v.currentPolicySha256 === null || hash(v.currentPolicySha256)) ||
    typeof v.available !== 'boolean' ||
    !(v.available
      ? v.reason === null
      : member(v.reason, ['runtime-unavailable', 'context-unavailable', 'platform-unsupported'])) ||
    !closed(v.coverage, ['complete', 'limited', 'unverified', 'foreign']) ||
    typeof v.coverage.complete !== 'boolean' ||
    typeof v.coverage.limited !== 'boolean' ||
    !count(v.coverage.unverified, 1_000_000) ||
    !count(v.coverage.foreign, 1_000_000) ||
    !Array.isArray(v.tasks) ||
    v.tasks.length > 64 ||
    !v.tasks.every(validateTaskLockRow) ||
    new Set(v.tasks.map((t) => t.id)).size !== v.tasks.length ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== TASK_LOCK_LIMITATIONS.length ||
    !v.limitations.every((s, i) => s === TASK_LOCK_LIMITATIONS[i])
  )
    return false;
  if (!v.available) return v.tasks.length === 0 && v.coverage.complete === false;
  const at = v.checkedAt,
    policy = v.currentPolicySha256;
  return (
    v.coverage.complete === (!v.coverage.limited && v.coverage.unverified === 0) &&
    v.tasks.every((t) => taskLockRowMatchesCapture(t, policy, at))
  );
}
export function validateTaskLockPreview(v: unknown): v is TaskLockPreview {
  if (
    !closed(v, [
      'schema',
      'id',
      'workspaceId',
      'createdAt',
      'expiresAt',
      'task',
      'bindingSha256',
      'canApply',
      'reason',
    ]) ||
    v.schema !== 'stroq-task-lock-preview/1' ||
    !uuid(v.id) ||
    !workspace(v.workspaceId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) > 120_000 ||
    !validateTaskLockRow(v.task) ||
    !hash(v.bindingSha256) ||
    typeof v.canApply !== 'boolean'
  )
    return false;
  const reason =
    v.task.standing === 'revoked'
      ? 'already-revoked'
      : v.task.standing === 'ended'
        ? 'task-ended'
        : v.task.eligibility === 'expired'
          ? 'permit-expired'
          : null;
  return (
    v.task.eligibility === eligibility(v.task, v.createdAt) &&
    v.canApply === (reason === null) &&
    v.reason === reason
  );
}
export function validateTaskLockReceipt(v: unknown): v is TaskLockReceipt {
  return (
    closed(v, [
      'schema',
      'id',
      'previewId',
      'workspaceId',
      'taskId',
      'permitSha256',
      'status',
      'checkedAt',
      'markerSha256',
      'storeReadback',
      'gateDecision',
      'gateRule',
      'evidence',
      'hostTermination',
      'irreversible',
    ]) &&
    v.schema === 'stroq-task-lock-receipt/1' &&
    uuid(v.id) &&
    uuid(v.previewId) &&
    workspace(v.workspaceId) &&
    isTaskLockId(v.taskId) &&
    hash(v.permitSha256) &&
    v.status === 'revoked' &&
    stamp(v.checkedAt) &&
    v.markerSha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
    v.storeReadback === 'revoked' &&
    v.gateDecision === 'deny' &&
    v.gateRule === 'task-void:revoked' &&
    v.evidence === 'isolated-gate-evaluation' &&
    v.hostTermination === 'unverified' &&
    v.irreversible === true
  );
}
