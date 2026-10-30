import { closed, member, stamp, text } from './local-guards';
export const AGENT_NAMES = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
} as const;
export type AgentId = keyof typeof AGENT_NAMES;
export interface AgentScopeStatus {
  scope: 'project' | 'user';
  state: 'present' | 'missing' | 'changed' | 'invalid' | 'unknown';
  reason: string;
  events: { event: string; state: 'present' | 'missing' | 'changed' }[];
  approval: 'not-required' | 'required' | 'unknown';
  recordedAt: string | null;
}
export interface AgentStatus {
  id: AgentId;
  hostVersion: null;
  scopes: AgentScopeStatus[];
  observation: {
    scope: 'machine';
    lastHookAt: string | null;
    state: 'recorded' | 'missing' | 'invalid';
  };
  proof: {
    scope: 'machine';
    state:
      'missing' | 'invalid' | 'unsupported' | 'stale' | 'failed' | 'inconclusive' | 'not-attempted';
    checkedAt: string | null;
    hostVersion: string | null;
    freshness: 'not-checked' | 'host-version-unknown' | 'changed' | 'unknown';
    reason: string;
  };
}
export interface AgentStatusState {
  schema: 'stroq-agents/1';
  source: 'local';
  generatedAt: string;
  agents: AgentStatus[];
}
export const AGENT_STATUS_REASONS: Record<string, string> = {
  'matches-current-install': 'Matches this Stroq installation',
  'hooks-missing': 'Stroq hooks are missing',
  'hook-command-changed': 'Hook command differs from this installation',
  'hook-options-changed': 'Hook settings differ from the expected setup',
  'hooks-disabled': 'Agent hooks are disabled',
  'config-invalid': 'Configuration could not be parsed',
  'config-unreadable': 'Configuration could not be read safely',
  'runtime-unavailable': 'The Stroq runtime is unavailable',
  'approval-required': 'Approve hooks in the agent',
  'approval-unknown': 'Hook approval is unverified',
};
const nullableStamp = (v: unknown) => v === null || stamp(v);
function scope(v: unknown): boolean {
  return (
    closed(v, ['scope', 'state', 'reason', 'events', 'approval', 'recordedAt']) &&
    member(v.scope, ['project', 'user']) &&
    member(v.state, ['present', 'missing', 'changed', 'invalid', 'unknown']) &&
    member(v.reason, Object.keys(AGENT_STATUS_REASONS)) &&
    member(v.approval, ['not-required', 'required', 'unknown']) &&
    nullableStamp(v.recordedAt) &&
    Array.isArray(v.events) &&
    v.events.length <= 32 &&
    v.events.every(
      (e) =>
        closed(e, ['event', 'state']) &&
        text(e.event, 100) &&
        member(e.state, ['present', 'missing', 'changed']),
    )
  );
}
export function validateAgentStatus(v: unknown): v is AgentStatusState {
  return (
    closed(v, ['schema', 'source', 'generatedAt', 'agents']) &&
    v.schema === 'stroq-agents/1' &&
    v.source === 'local' &&
    stamp(v.generatedAt) &&
    Array.isArray(v.agents) &&
    v.agents.length === Object.keys(AGENT_NAMES).length &&
    new Set(v.agents.map((a) => a?.id)).size === Object.keys(AGENT_NAMES).length &&
    v.agents.every(
      (a) =>
        closed(a, ['id', 'hostVersion', 'scopes', 'observation', 'proof']) &&
        member(a.id, Object.keys(AGENT_NAMES)) &&
        a.hostVersion === null &&
        Array.isArray(a.scopes) &&
        a.scopes.length === 2 &&
        new Set(a.scopes.map((s) => s?.scope)).size === 2 &&
        a.scopes.every(scope) &&
        closed(a.observation, ['scope', 'lastHookAt', 'state']) &&
        a.observation.scope === 'machine' &&
        nullableStamp(a.observation.lastHookAt) &&
        member(a.observation.state, ['recorded', 'missing', 'invalid']) &&
        closed(a.proof, ['scope', 'state', 'checkedAt', 'hostVersion', 'freshness', 'reason']) &&
        a.proof.scope === 'machine' &&
        member(a.proof.state, [
          'missing',
          'invalid',
          'unsupported',
          'stale',
          'failed',
          'inconclusive',
          'not-attempted',
        ]) &&
        nullableStamp(a.proof.checkedAt) &&
        (a.proof.hostVersion === null || text(a.proof.hostVersion, 100)) &&
        member(a.proof.freshness, ['not-checked', 'host-version-unknown', 'changed', 'unknown']) &&
        member(a.proof.reason, [
          'no-live-proof',
          'no-live-driver',
          'proof-invalid',
          'proof-unreadable',
          'current-context-unavailable',
          'live-check-failed',
          'proof-context-changed',
          'host-version-not-checked',
        ]),
    )
  );
}
