import { closed, count, hash, member, stamp } from './local-guards';

export const CREDENTIAL_FILTER_TARGETS = {
  'claude-project': {
    recipe: 'claude-read-deny',
    agent: 'claude-code',
    scope: 'project',
    target: '.claude/settings.local.json',
    required: 13,
  },
  'claude-user': {
    recipe: 'claude-read-deny',
    agent: 'claude-code',
    scope: 'user',
    target: '~/.claude/settings.json',
    required: 13,
  },
  'cursor-project': {
    recipe: 'cursor-ignore',
    agent: 'cursor',
    scope: 'project',
    target: '.cursorignore',
    required: 2,
  },
} as const;
export type CredentialFilterTarget = keyof typeof CREDENTIAL_FILTER_TARGETS;
export type CredentialFilterAction = 'apply-filter' | 'undo-filter';
export type CredentialFilterLocation = 'workspace' | 'user' | 'main-checkout';
export type CredentialFilterContext = 'workspace' | 'repository' | 'all-workspaces';
export type CredentialFilterBackup =
  'copy' | 'none-new-file' | 'none-credential-text' | 'none-unchecked' | 'surgical' | 'none';
export const CREDENTIAL_FILTER_LIMITATIONS = [
  'Configured rules do not prove that a running agent loaded them or blocked a read.',
  'Claude rules cover native file tools and recognized shell readers, not arbitrary subprocess readers.',
  'Cursor ignore rules cover native context; terminal and MCP tools remain outside this filter.',
  'Cursor already ignores common secret files by default. Missing Stroq rules do not establish exposure.',
  'The .env.* pattern also matches .env.example. Claude rules include home credential paths.',
  'Start a fresh client session and verify its loaded settings after changing these files.',
] as const;
export const CREDENTIAL_FILTER_RETENTION =
  'Whole-file copies may contain private settings or embedded credentials. Copies are private but unencrypted; the engine retains the first plus newest four per file on a best-effort basis, with no automatic expiry, including after undo. Credential-shaped source text is not copied; undo then removes managed entries surgically. Detection can miss embedded secrets.';
export const CREDENTIAL_FILTER_REASONS = {
  'credential-filter-unavailable':
    'File filters could not be inspected. Recheck before making changes.',
  'credential-filter-conflict':
    'The source conflicts with the fixed filter recipe. Review it in the agent settings.',
  'credential-filter-mixed-history':
    'This file has other managed changes. Undo here would affect more than these filters.',
  'credential-filter-unsupported-source':
    'This configuration layout is not supported. Open the correct workspace or use the agent settings.',
  'credential-filter-context-unavailable': 'The workspace or user context could not be verified.',
  'credential-filter-engine-unavailable':
    'The local filter engine is unavailable. Rebuild and restart the local server.',
  'credential-filter-platform-unsupported':
    'This configuration control is unavailable on this operating system.',
  'credential-filter-source-invalid':
    'The settings could not be parsed without losing information. No changes are offered.',
  'credential-filter-source-limit': 'The settings exceed the bounded file-filter reader.',
  'credential-filter-source-unsafe':
    'The source path or file identity could not be verified safely.',
  'credential-filter-storage-unavailable':
    'Managed ownership and recovery history could not be verified.',
  'credential-filter-edited-block':
    'The existing Stroq block has custom edits. Review that block before applying a fixed recipe.',
  'credential-filter-busy': 'Another filter operation is running. Recheck after it finishes.',
  'credential-filter-preview-missing':
    'This preview is no longer available. Prepare a fresh preview.',
  'credential-filter-preview-expired': 'This preview expired. Prepare a fresh preview.',
  'credential-filter-preview-stale':
    'The source or recovery context changed. Recheck and prepare a new preview.',
  'credential-filter-recovery-required':
    'The change could not be fully confirmed. Recheck the settings and recovery history.',
} as const;
export type CredentialFilterReason = keyof typeof CREDENTIAL_FILTER_REASONS;
export interface CredentialFilterRow {
  id: CredentialFilterTarget;
  recipe: 'claude-read-deny' | 'cursor-ignore';
  agent: 'claude-code' | 'cursor';
  scope: 'project' | 'user';
  target: '.claude/settings.local.json' | '~/.claude/settings.json' | '.cursorignore';
  location: CredentialFilterLocation;
  context: CredentialFilterContext;
  status: 'configured' | 'partial' | 'absent' | 'unavailable';
  exists: boolean;
  sourceSha256: string | null;
  bytes: number;
  required: number;
  present: number;
  managed: number | null;
  unmanaged: number | null;
  applications: number | null;
  undoAvailable: boolean;
  reason: CredentialFilterReason | null;
}
export interface CredentialFiltersState {
  schema: 'stroq-credential-filters/1';
  source: 'local';
  workspaceId: string;
  generatedAt: string;
  available: boolean;
  reason: CredentialFilterReason | null;
  targets: CredentialFilterRow[];
  limitations: readonly string[];
}
export interface CredentialFilterPreview {
  schema: 'stroq-credential-filter-preview/1';
  id: string;
  expiresAt: string;
  workspaceId: string;
  target: CredentialFilterTarget;
  action: CredentialFilterAction;
  location: CredentialFilterLocation;
  context: CredentialFilterContext;
  operation:
    | 'create'
    | 'update'
    | 'unchanged'
    | 'restore-copy'
    | 'remove-managed'
    | 'remove-created-file'
    | 'clear-history';
  sourceSha256: string | null;
  candidateSha256: string | null;
  bytes: number;
  required: number;
  present: number;
  added: number;
  removed: number;
  kept: number;
  applications: number;
  backup: CredentialFilterBackup;
  reformatted: boolean;
  needs: {
    acknowledgeReformat: boolean;
    acknowledgeLink: boolean;
    acknowledgeCredentialLoss: boolean;
    acknowledgeSharedScope: boolean;
  };
  evidence: 'configuration';
  hostEnforcement: false;
  limitations: readonly string[];
  retention: string;
}
export interface CredentialFilterReceipt {
  schema: 'stroq-credential-filter-receipt/1';
  status: 'configured' | 'undone' | 'unchanged';
  action: CredentialFilterAction;
  target: CredentialFilterTarget;
  workspaceId: string;
  previewId: string;
  candidateSha256: string | null;
  completedAt: string;
  applications: number;
  backup: CredentialFilterBackup;
  evidence: 'configuration';
  hostEnforcement: false;
  requiresClientRestart: true;
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const targetId = (v: unknown): v is CredentialFilterTarget =>
  typeof v === 'string' && Object.hasOwn(CREDENTIAL_FILTER_TARGETS, v);
const workspaceId = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const shaOrNull = (v: unknown) => v === null || hash(v);
const nullableCount = (v: unknown, max = 1000) => v === null || count(v, max);
const reason = (v: unknown) =>
  v === null || (typeof v === 'string' && Object.hasOwn(CREDENTIAL_FILTER_REASONS, v));
const limitations = (v: unknown) =>
  Array.isArray(v) &&
  v.length === CREDENTIAL_FILTER_LIMITATIONS.length &&
  v.every((s, i) => s === CREDENTIAL_FILTER_LIMITATIONS[i]);
const backup = (v: unknown) =>
  member(v, [
    'copy',
    'none-new-file',
    'none-credential-text',
    'none-unchecked',
    'surgical',
    'none',
  ]);
function sourceScope(v: Record<string, unknown>, id: CredentialFilterTarget) {
  if (id === 'claude-user') return v.location === 'user' && v.context === 'all-workspaces';
  if (id === 'cursor-project') return v.location === 'workspace' && v.context === 'workspace';
  return (
    (v.location === 'workspace' && v.context === 'workspace') ||
    (member(v.location, ['workspace', 'main-checkout']) && v.context === 'repository')
  );
}
function row(v: unknown): v is CredentialFilterRow {
  if (
    !exact(v, [
      'id',
      'recipe',
      'agent',
      'scope',
      'target',
      'location',
      'context',
      'status',
      'exists',
      'sourceSha256',
      'bytes',
      'required',
      'present',
      'managed',
      'unmanaged',
      'applications',
      'undoAvailable',
      'reason',
    ]) ||
    !targetId(v.id)
  )
    return false;
  const fixed = CREDENTIAL_FILTER_TARGETS[v.id];
  if (
    !Object.entries(fixed).every(([k, value]) => v[k] === value) ||
    !sourceScope(v, v.id) ||
    !member(v.status, ['configured', 'partial', 'absent', 'unavailable']) ||
    typeof v.exists !== 'boolean' ||
    !shaOrNull(v.sourceSha256) ||
    !count(v.bytes, 16 * 1024 * 1024) ||
    !count(v.present, fixed.required) ||
    !nullableCount(v.managed, fixed.required) ||
    !nullableCount(v.unmanaged, fixed.required) ||
    !nullableCount(v.applications) ||
    typeof v.undoAvailable !== 'boolean' ||
    !reason(v.reason)
  )
    return false;
  if (v.exists !== (v.sourceSha256 !== null) || (!v.exists && v.bytes !== 0)) return false;
  if (
    (v.status === 'configured' && v.present !== fixed.required) ||
    (v.status === 'partial' && (v.present === 0 || v.present === fixed.required)) ||
    (v.status === 'absent' && v.present !== 0) ||
    (v.status === 'unavailable' && v.reason === null)
  )
    return false;
  const ownershipKnown = v.managed !== null && v.unmanaged !== null && v.applications !== null;
  if (!ownershipKnown)
    return (
      v.managed === null &&
      v.unmanaged === null &&
      v.applications === null &&
      !v.undoAvailable &&
      v.reason !== null
    );
  if (
    (v.managed as number) + (v.unmanaged as number) !== v.present ||
    (v.applications === 0 && v.managed !== 0)
  )
    return false;
  return (
    !v.undoAvailable ||
    ((v.applications as number) > 0 && v.reason === null && v.status !== 'unavailable')
  );
}
export function validateCredentialFilters(v: unknown): v is CredentialFiltersState {
  return (
    exact(v, [
      'schema',
      'source',
      'workspaceId',
      'generatedAt',
      'available',
      'reason',
      'targets',
      'limitations',
    ]) &&
    v.schema === 'stroq-credential-filters/1' &&
    v.source === 'local' &&
    workspaceId(v.workspaceId) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    reason(v.reason) &&
    (v.available || v.reason !== null) &&
    limitations(v.limitations) &&
    Array.isArray(v.targets) &&
    v.targets.length === 3 &&
    v.targets.every(row) &&
    new Set(v.targets.map((t) => t.id)).size === 3
  );
}
export function validateCredentialFilterPreview(v: unknown): v is CredentialFilterPreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'expiresAt',
      'workspaceId',
      'target',
      'action',
      'location',
      'context',
      'operation',
      'sourceSha256',
      'candidateSha256',
      'bytes',
      'required',
      'present',
      'added',
      'removed',
      'kept',
      'applications',
      'backup',
      'reformatted',
      'needs',
      'evidence',
      'hostEnforcement',
      'limitations',
      'retention',
    ]) ||
    v.schema !== 'stroq-credential-filter-preview/1' ||
    !uuid(v.id) ||
    !stamp(v.expiresAt) ||
    !workspaceId(v.workspaceId) ||
    !targetId(v.target) ||
    !member(v.action, ['apply-filter', 'undo-filter']) ||
    !sourceScope(v, v.target)
  )
    return false;
  const required = CREDENTIAL_FILTER_TARGETS[v.target].required;
  if (
    v.required !== required ||
    !count(v.present, required) ||
    !count(v.added, required) ||
    !count(v.removed, required) ||
    !count(v.kept) ||
    !count(v.applications, 1000) ||
    !shaOrNull(v.sourceSha256) ||
    !shaOrNull(v.candidateSha256) ||
    !count(v.bytes, 16 * 1024 * 1024) ||
    !backup(v.backup) ||
    typeof v.reformatted !== 'boolean' ||
    !exact(v.needs, [
      'acknowledgeReformat',
      'acknowledgeLink',
      'acknowledgeCredentialLoss',
      'acknowledgeSharedScope',
    ]) ||
    !Object.values(v.needs).every((n) => typeof n === 'boolean') ||
    v.evidence !== 'configuration' ||
    v.hostEnforcement !== false ||
    !limitations(v.limitations) ||
    v.retention !== CREDENTIAL_FILTER_RETENTION
  )
    return false;
  if (
    v.reformatted !== v.needs.acknowledgeReformat ||
    v.needs.acknowledgeSharedScope !== (v.context !== 'workspace')
  )
    return false;
  if (v.action === 'apply-filter')
    return (
      member(v.operation, ['create', 'update', 'unchanged']) &&
      v.removed === 0 &&
      v.present + v.added <= required &&
      hash(v.candidateSha256) &&
      (v.operation !== 'create' || (v.sourceSha256 === null && v.backup === 'none-new-file')) &&
      (v.operation !== 'unchanged' || (v.added === 0 && v.sourceSha256 === v.candidateSha256))
    );
  return (
    member(v.operation, [
      'restore-copy',
      'remove-managed',
      'remove-created-file',
      'clear-history',
    ]) &&
    v.added === 0 &&
    v.removed <= v.present &&
    v.applications > 0 &&
    (v.operation !== 'remove-created-file' ||
      (v.candidateSha256 === null && v.backup === 'none-new-file')) &&
    (v.operation !== 'restore-copy' || (hash(v.candidateSha256) && v.backup === 'copy'))
  );
}
export function validateCredentialFilterReceipt(v: unknown): v is CredentialFilterReceipt {
  return (
    exact(v, [
      'schema',
      'status',
      'action',
      'target',
      'workspaceId',
      'previewId',
      'candidateSha256',
      'completedAt',
      'applications',
      'backup',
      'evidence',
      'hostEnforcement',
      'requiresClientRestart',
    ]) &&
    v.schema === 'stroq-credential-filter-receipt/1' &&
    member(v.status, ['configured', 'undone', 'unchanged']) &&
    member(v.action, ['apply-filter', 'undo-filter']) &&
    (v.status === 'unchanged' ||
      (v.status === 'configured' ? v.action === 'apply-filter' : v.action === 'undo-filter')) &&
    targetId(v.target) &&
    workspaceId(v.workspaceId) &&
    uuid(v.previewId) &&
    shaOrNull(v.candidateSha256) &&
    stamp(v.completedAt) &&
    count(v.applications, 1000) &&
    backup(v.backup) &&
    v.evidence === 'configuration' &&
    v.hostEnforcement === false &&
    v.requiresClientRestart === true
  );
}
