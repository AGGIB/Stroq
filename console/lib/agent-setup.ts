import { closed, count, hash, member, stamp, text } from './local-guards';
export const SETUP_AGENTS = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
} as const;
export type SetupAgent = keyof typeof SETUP_AGENTS;
export type SetupScope = 'project' | 'user';
export type SetupScopeImpact = 'workspace' | 'all-workspaces';
export const SETUP_BACKUP_ROOT = '~/.stroq/backups/console-setup/';
export const SETUP_EVENTS: Record<SetupAgent, readonly string[]> = {
  'claude-code': ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  cursor: [
    'preToolUse',
    'beforeShellExecution',
    'afterShellExecution',
    'beforeMCPExecution',
    'afterMCPExecution',
    'beforeReadFile',
    'afterFileEdit',
  ],
  codex: ['PreToolUse', 'PostToolUse'],
};
export function setupSelection(agentId?: string, scope: SetupScope = 'project') {
  return {
    agent:
      agentId && Object.hasOwn(SETUP_AGENTS, agentId) ? (agentId as SetupAgent) : 'claude-code',
    scope,
  } satisfies { agent: SetupAgent; scope: SetupScope };
}
export function setupTarget(agent: SetupAgent, scope: SetupScope, impact: SetupScopeImpact) {
  const relative = agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;
  return `${impact === 'all-workspaces' ? '~' : 'Workspace'}/${relative}`;
}
export interface SetupState {
  schema: 'stroq-agent-setup/2';
  workspaceId: string;
  available: boolean;
  reason?: string;
  context: { workspace: string; userScope: 'This user' };
  engineVersion: string | null;
  agents: { id: SetupAgent; scopes: SetupScope[]; available: boolean; reason?: string }[];
}
export interface SetupPreview {
  schema: 'stroq-agent-setup-preview/2';
  id: string;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
  scopeImpact: SetupScopeImpact;
  context: string;
  target: string;
  operation: 'create' | 'update' | 'unchanged';
  sourceSha256: string | null;
  candidateSha256: string;
  hookEvents: {
    event: string;
    matcher: string | null;
    blocking: boolean;
    failClosed: boolean | null;
    timeoutSeconds: number | null;
  }[];
  addedHooks: number;
  preservedHooks: number;
  replacedHooks: number;
  remainingLookalikes: number;
  needs: { acknowledgeSharedScope: boolean; acknowledgeRetainedCopy: boolean };
  backup: {
    required: boolean;
    label: typeof SETUP_BACKUP_ROOT;
    configExisted: boolean;
    recordExisted: boolean;
  };
  evidence: 'configuration';
  verified: false;
  requiresRestart: true;
  needsApproval: boolean;
  nextSteps: string[];
}
export interface SetupResult {
  schema: 'stroq-agent-setup-result/2';
  status: 'configured' | 'review-required' | 'unchanged';
  previewId: string;
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
  scopeImpact: SetupScopeImpact;
  target: string;
  context: string;
  operation: 'create' | 'update' | 'unchanged';
  configuredAt: string;
  sourceSha256: string | null;
  candidateSha256: string;
  addedHooks: number;
  preservedHooks: number;
  replacedHooks: number;
  remainingLookalikes: number;
  currentExactHooks: number;
  backupId: string | null;
  backup: {
    complete: boolean;
    label: string | null;
    configExisted: boolean;
    recordExisted: boolean;
  };
  evidence: 'configuration';
  verified: false;
  requiresRestart: true;
  needsApproval: boolean;
  nextSteps: string[];
}
export const SETUP_REASONS: Record<string, string> = {
  'custom-home-unsupported': 'Hook setup requires the default Stroq data directory for this user.',
  'platform-unsupported': 'Browser-based hook setup is not supported on this operating system.',
  'runtime-path-unsupported':
    'The engine runtime path cannot be represented safely in hook configuration.',
  'engine-unavailable': 'Build the local engine and restart the server.',
  'context-unavailable': 'The local workspace or user directory could not be verified.',
};
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const agent = (v: unknown): v is SetupAgent => member(v, Object.keys(SETUP_AGENTS));
const scope = (v: unknown): v is SetupScope => member(v, ['project', 'user']);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
function availability(v: Record<string, unknown>) {
  return (
    typeof v.available === 'boolean' &&
    (v.available
      ? !Object.hasOwn(v, 'reason')
      : typeof v.reason === 'string' && Object.hasOwn(SETUP_REASONS, v.reason))
  );
}
function selection(v: Record<string, unknown>): boolean {
  return (
    workspace(v.workspaceId) &&
    agent(v.agent) &&
    scope(v.scope) &&
    member(v.scopeImpact, ['workspace', 'all-workspaces']) &&
    (v.scope !== 'user' || v.scopeImpact === 'all-workspaces') &&
    text(v.context, 120) &&
    v.target === setupTarget(v.agent, v.scope, v.scopeImpact as SetupScopeImpact)
  );
}
function evidence(v: Record<string, unknown>): boolean {
  return (
    v.evidence === 'configuration' &&
    v.verified === false &&
    v.requiresRestart === true &&
    v.needsApproval === (v.agent === 'codex') &&
    Array.isArray(v.nextSteps) &&
    v.nextSteps.length <= 16 &&
    v.nextSteps.every((line) => text(line, 600))
  );
}
function counters(v: Record<string, unknown>): boolean {
  return (
    count(v.addedHooks, 32) &&
    count(v.preservedHooks, 4096) &&
    count(v.replacedHooks, 4096) &&
    count(v.remainingLookalikes, 4096) &&
    (v.remainingLookalikes as number) <= (v.preservedHooks as number) &&
    (v.addedHooks as number) <= SETUP_EVENTS[v.agent as SetupAgent].length &&
    (v.operation !== 'create' ||
      (v.addedHooks === SETUP_EVENTS[v.agent as SetupAgent].length &&
        v.preservedHooks === 0 &&
        v.replacedHooks === 0 &&
        v.remainingLookalikes === 0))
  );
}
function operation(v: Record<string, unknown>): boolean {
  return (
    hash(v.candidateSha256) &&
    member(v.operation, ['create', 'update', 'unchanged']) &&
    (v.operation === 'create' ? v.sourceSha256 === null : hash(v.sourceSha256)) &&
    (v.operation === 'unchanged'
      ? v.sourceSha256 === v.candidateSha256 && v.addedHooks === 0 && v.replacedHooks === 0
      : v.sourceSha256 !== v.candidateSha256)
  );
}
export function validateSetupState(v: unknown): v is SetupState {
  return (
    closed(v, [
      'schema',
      'workspaceId',
      'available',
      'reason',
      'context',
      'engineVersion',
      'agents',
    ]) &&
    v.schema === 'stroq-agent-setup/2' &&
    workspace(v.workspaceId) &&
    availability(v) &&
    exact(v.context, ['workspace', 'userScope']) &&
    text(v.context.workspace, 120) &&
    v.context.userScope === 'This user' &&
    (v.engineVersion === null || text(v.engineVersion, 80)) &&
    (!v.available || v.engineVersion !== null) &&
    Array.isArray(v.agents) &&
    v.agents.length === Object.keys(SETUP_AGENTS).length &&
    v.agents.every(
      (entry, i) =>
        closed(entry, ['id', 'scopes', 'available', 'reason']) &&
        entry.id === Object.keys(SETUP_AGENTS)[i] &&
        availability(entry) &&
        entry.available === v.available &&
        entry.reason === v.reason &&
        Array.isArray(entry.scopes) &&
        entry.scopes.length === 2 &&
        entry.scopes[0] === 'project' &&
        entry.scopes[1] === 'user',
    )
  );
}
export function validateSetupPreview(v: unknown): v is SetupPreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'createdAt',
      'expiresAt',
      'workspaceId',
      'agent',
      'scope',
      'scopeImpact',
      'context',
      'target',
      'operation',
      'sourceSha256',
      'candidateSha256',
      'hookEvents',
      'addedHooks',
      'preservedHooks',
      'replacedHooks',
      'remainingLookalikes',
      'needs',
      'backup',
      'evidence',
      'verified',
      'requiresRestart',
      'needsApproval',
      'nextSteps',
    ]) ||
    v.schema !== 'stroq-agent-setup-preview/2' ||
    !uuid(v.id) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) > 300_000 ||
    !selection(v) ||
    !counters(v) ||
    !operation(v) ||
    !evidence(v) ||
    !exact(v.backup, ['required', 'label', 'configExisted', 'recordExisted']) ||
    v.backup.label !== SETUP_BACKUP_ROOT ||
    v.backup.configExisted !== (v.sourceSha256 !== null) ||
    typeof v.backup.recordExisted !== 'boolean' ||
    !exact(v.needs, ['acknowledgeSharedScope', 'acknowledgeRetainedCopy']) ||
    !Array.isArray(v.hookEvents) ||
    v.hookEvents.length !== SETUP_EVENTS[v.agent as SetupAgent].length ||
    !v.hookEvents.every(
      (hook, i) =>
        exact(hook, ['event', 'matcher', 'blocking', 'failClosed', 'timeoutSeconds']) &&
        hook.event === SETUP_EVENTS[v.agent as SetupAgent][i] &&
        (hook.matcher === null || text(hook.matcher, 250)) &&
        typeof hook.blocking === 'boolean' &&
        (hook.failClosed === null || typeof hook.failClosed === 'boolean') &&
        (hook.timeoutSeconds === null || count(hook.timeoutSeconds, 1000)),
    )
  )
    return false;
  const changed = v.operation !== 'unchanged';
  const retained = changed && (v.backup.configExisted || v.backup.recordExisted);
  return (
    v.backup.required === retained &&
    v.needs.acknowledgeRetainedCopy === retained &&
    v.needs.acknowledgeSharedScope === (changed && v.scopeImpact === 'all-workspaces')
  );
}
export function validateSetupResult(v: unknown): v is SetupResult {
  if (
    !exact(v, [
      'schema',
      'status',
      'previewId',
      'workspaceId',
      'agent',
      'scope',
      'scopeImpact',
      'target',
      'context',
      'operation',
      'configuredAt',
      'sourceSha256',
      'candidateSha256',
      'addedHooks',
      'preservedHooks',
      'replacedHooks',
      'remainingLookalikes',
      'currentExactHooks',
      'backupId',
      'backup',
      'evidence',
      'verified',
      'requiresRestart',
      'needsApproval',
      'nextSteps',
    ]) ||
    v.schema !== 'stroq-agent-setup-result/2' ||
    !uuid(v.previewId) ||
    !selection(v) ||
    !counters(v) ||
    !operation(v) ||
    !evidence(v) ||
    !stamp(v.configuredAt) ||
    v.currentExactHooks !== SETUP_EVENTS[v.agent as SetupAgent].length ||
    v.status !==
      ((v.remainingLookalikes as number) > 0
        ? 'review-required'
        : v.operation === 'unchanged'
          ? 'unchanged'
          : 'configured') ||
    !exact(v.backup, ['complete', 'label', 'configExisted', 'recordExisted']) ||
    v.backup.configExisted !== (v.sourceSha256 !== null) ||
    typeof v.backup.recordExisted !== 'boolean'
  )
    return false;
  return v.operation === 'unchanged'
    ? v.backupId === null && v.backup.complete === false && v.backup.label === null
    : v.backupId === v.previewId &&
        v.backup.complete === true &&
        v.backup.label === `${SETUP_BACKUP_ROOT}${v.previewId}.manifest.json`;
}
