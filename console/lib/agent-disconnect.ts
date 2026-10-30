import { SETUP_AGENTS, type SetupAgent, type SetupScope } from './agent-setup';
import { closed, count, hash, member, stamp } from './local-guards';

export const DISCONNECT_BACKUP_ROOT = '~/.stroq/backups/console-disconnect/';
export const DISCONNECT_LIMITATIONS = [
  'Only exact hook registrations for the current Stroq runtime in the selected file are removed; other commands and sources remain unchanged.',
  'Removal affects new agent sessions. It does not stop a running agent or server, revoke access, remove native file filters or change policy.',
  'A private full copy of these settings, including other entries, is retained locally without automatic expiry. At most 32 recovery records are accepted.',
] as const;
export const DISCONNECT_REASONS = [
  'custom-home-unsupported',
  'platform-unsupported',
  'context-unavailable',
  'engine-unavailable',
  'runtime-path-unsupported',
] as const;
export type DisconnectScopeImpact = 'workspace' | 'all-workspaces';
const EVENTS: Record<SetupAgent, readonly string[]> = {
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
export interface AgentDisconnectState {
  schema: 'stroq-agent-disconnect/1';
  workspaceId: string;
  available: boolean;
  reason: (typeof DISCONNECT_REASONS)[number] | null;
  hostEnforcement: false;
}
export interface AgentDisconnectPreview {
  schema: 'stroq-agent-disconnect-preview/1';
  previewId: string;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
  scopeImpact: DisconnectScopeImpact;
  target: string;
  operation: 'remove-hooks' | 'unchanged';
  sourceSha256: string | null;
  candidateSha256: string | null;
  removedHooks: number;
  preservedHooks: number;
  remainingLookalikes: number;
  events: { event: string; removed: number }[];
  needs: {
    acknowledgeWeakenProtection: boolean;
    acknowledgeRetainedCopy: boolean;
    acknowledgeSharedScope: boolean;
  };
  backup: { required: boolean; label: typeof DISCONNECT_BACKUP_ROOT };
  evidence: 'configuration';
  hostEnforcement: false;
  requiresNewSession: true;
  limitations: string[];
}
export interface AgentDisconnectReceipt {
  schema: 'stroq-agent-disconnect-receipt/1';
  status: 'removed';
  receiptId: string;
  previewId: string;
  completedAt: string;
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
  scopeImpact: DisconnectScopeImpact;
  target: string;
  sourceSha256: string;
  candidateSha256: string;
  removedHooks: number;
  preservedHooks: number;
  remainingLookalikes: number;
  backupId: string;
  currentExactHooks: 0;
  evidence: 'configuration';
  hostEnforcement: false;
  requiresNewSession: true;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const agent = (v: unknown): v is SetupAgent => member(v, Object.keys(SETUP_AGENTS));
const scope = (v: unknown): v is SetupScope => member(v, ['project', 'user']);
const impact = (v: unknown): v is DisconnectScopeImpact =>
  member(v, ['workspace', 'all-workspaces']);
const nullableHash = (v: unknown) => v === null || hash(v);
export function disconnectTarget(
  selectedAgent: SetupAgent,
  selectedScope: SetupScope,
  scopeImpact: DisconnectScopeImpact,
): string {
  const relative =
    selectedAgent === 'claude-code' ? '.claude/settings.json' : `.${selectedAgent}/hooks.json`;
  return `${scopeImpact === 'all-workspaces' ? '~' : 'Workspace'}/${relative}`;
}
function selection(v: Record<string, unknown>): boolean {
  return (
    workspace(v.workspaceId) &&
    agent(v.agent) &&
    scope(v.scope) &&
    impact(v.scopeImpact) &&
    (v.scope !== 'user' || v.scopeImpact === 'all-workspaces') &&
    v.target === disconnectTarget(v.agent, v.scope, v.scopeImpact)
  );
}
function evidence(v: Record<string, unknown>): boolean {
  return (
    v.evidence === 'configuration' && v.hostEnforcement === false && v.requiresNewSession === true
  );
}
export function validateAgentDisconnectState(v: unknown): v is AgentDisconnectState {
  return (
    exact(v, ['schema', 'workspaceId', 'available', 'reason', 'hostEnforcement']) &&
    v.schema === 'stroq-agent-disconnect/1' &&
    workspace(v.workspaceId) &&
    typeof v.available === 'boolean' &&
    (v.reason === null || member(v.reason, DISCONNECT_REASONS)) &&
    v.available === (v.reason === null) &&
    v.hostEnforcement === false
  );
}
export function validateAgentDisconnectPreview(v: unknown): v is AgentDisconnectPreview {
  if (
    !exact(v, [
      'schema',
      'previewId',
      'createdAt',
      'expiresAt',
      'workspaceId',
      'agent',
      'scope',
      'scopeImpact',
      'target',
      'operation',
      'sourceSha256',
      'candidateSha256',
      'removedHooks',
      'preservedHooks',
      'remainingLookalikes',
      'events',
      'needs',
      'backup',
      'evidence',
      'hostEnforcement',
      'requiresNewSession',
      'limitations',
    ]) ||
    v.schema !== 'stroq-agent-disconnect-preview/1' ||
    !uuid(v.previewId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) > 300_000 ||
    !selection(v) ||
    !member(v.operation, ['remove-hooks', 'unchanged']) ||
    !nullableHash(v.sourceSha256) ||
    !nullableHash(v.candidateSha256) ||
    !count(v.removedHooks, 4096) ||
    !count(v.preservedHooks, 4096) ||
    !count(v.remainingLookalikes, 4096) ||
    !Array.isArray(v.events) ||
    v.events.length > 32 ||
    !v.events.every(
      (row) =>
        exact(row, ['event', 'removed']) &&
        typeof row.event === 'string' &&
        member(row.event, EVENTS[v.agent as SetupAgent]) &&
        count(row.removed, 4096) &&
        row.removed > 0,
    ) ||
    new Set(v.events.map((row) => row.event)).size !== v.events.length ||
    v.events.reduce((sum, row) => sum + row.removed, 0) !== v.removedHooks ||
    !exact(v.needs, [
      'acknowledgeWeakenProtection',
      'acknowledgeRetainedCopy',
      'acknowledgeSharedScope',
    ]) ||
    !exact(v.backup, ['required', 'label']) ||
    v.backup.label !== DISCONNECT_BACKUP_ROOT ||
    !evidence(v) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== DISCONNECT_LIMITATIONS.length ||
    !v.limitations.every((line, i) => line === DISCONNECT_LIMITATIONS[i])
  )
    return false;
  const changes = v.operation === 'remove-hooks';
  return (
    v.needs.acknowledgeWeakenProtection === changes &&
    v.needs.acknowledgeRetainedCopy === changes &&
    v.needs.acknowledgeSharedScope === (changes && v.scopeImpact === 'all-workspaces') &&
    v.backup.required === changes &&
    (changes
      ? v.removedHooks > 0 &&
        hash(v.sourceSha256) &&
        hash(v.candidateSha256) &&
        v.sourceSha256 !== v.candidateSha256
      : v.removedHooks === 0 && v.sourceSha256 === v.candidateSha256)
  );
}
export function validateAgentDisconnectReceipt(v: unknown): v is AgentDisconnectReceipt {
  return (
    exact(v, [
      'schema',
      'status',
      'receiptId',
      'previewId',
      'completedAt',
      'workspaceId',
      'agent',
      'scope',
      'scopeImpact',
      'target',
      'sourceSha256',
      'candidateSha256',
      'removedHooks',
      'preservedHooks',
      'remainingLookalikes',
      'backupId',
      'currentExactHooks',
      'evidence',
      'hostEnforcement',
      'requiresNewSession',
    ]) &&
    v.schema === 'stroq-agent-disconnect-receipt/1' &&
    v.status === 'removed' &&
    uuid(v.receiptId) &&
    uuid(v.previewId) &&
    uuid(v.backupId) &&
    v.backupId === v.receiptId &&
    stamp(v.completedAt) &&
    selection(v) &&
    hash(v.sourceSha256) &&
    hash(v.candidateSha256) &&
    v.sourceSha256 !== v.candidateSha256 &&
    count(v.removedHooks, 4096) &&
    v.removedHooks > 0 &&
    count(v.preservedHooks, 4096) &&
    count(v.remainingLookalikes, 4096) &&
    v.currentExactHooks === 0 &&
    evidence(v)
  );
}
