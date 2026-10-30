import {
  AGENT_NAMES,
  AGENT_STATUS_REASONS,
  type AgentStatus,
  type AgentStatusState,
} from './agent-status';

/**
 * One state per agent, in plain words, from the facts the agent status already carries: whether
 * Stroq's hooks are in its settings, whether something is wrong with them, and whether Stroq has been
 * asked about an action on this machine. "Connected" means the hooks are in place; it is never said to
 * mean protected, and an in-agent check is a separate fact shown on the Agents page.
 */

export type AgentStateKind =
  'not-connected' | 'attention' | 'unknown' | 'connected-unseen' | 'connected-seen';

export interface AgentStateWords {
  readonly kind: AgentStateKind;
  readonly label: string;
  readonly tone: 'green' | 'orange' | 'muted';
  readonly line: string;
}

/** Reasons that mean the hooks are present but will not do their job as installed. */
const PROBLEM_REASONS = new Set([
  'hooks-disabled',
  'approval-required',
  'runtime-unavailable',
  'config-invalid',
  'config-unreadable',
  'hook-command-changed',
  'hook-options-changed',
]);

export function ago(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function agentState(
  agent: AgentStatus,
  scope: 'project' | 'user' | null = null,
  now: number = Date.now(),
): AgentStateWords {
  const scopes = scope === null ? agent.scopes : agent.scopes.filter((s) => s.scope === scope);
  const broken = scopes.find(
    (s) =>
      s.state === 'invalid' ||
      s.state === 'changed' ||
      (s.state === 'present' && PROBLEM_REASONS.has(s.reason)),
  );
  if (broken)
    return {
      kind: 'attention',
      label: 'Needs attention',
      tone: 'orange',
      // The button is called Review setup once hooks are present, and Configure before that.
      line: `${AGENT_STATUS_REASONS[broken.reason] ?? 'The hooks are not as Stroq installed them'}. ${
        broken.state === 'present' ? 'Open Review setup' : 'Use Configure'
      } to fix it.`,
    };
  const present = scopes.filter((s) => s.state === 'present');
  if (present.length === 0) {
    if (scopes.length > 0 && scopes.every((s) => s.state === 'unknown'))
      return {
        kind: 'unknown',
        label: 'Unknown',
        tone: 'muted',
        line: 'Stroq could not read this agent’s settings, so it cannot say whether the hooks are there.',
      };
    return {
      kind: 'not-connected',
      label: 'Not connected',
      tone: 'muted',
      line: 'Stroq’s hooks are not in this agent’s settings, so nothing it does is judged. Use Configure to connect it.',
    };
  }
  const approval = present.some((s) => s.approval === 'unknown')
    ? ' Hook approval in the agent is unverified.'
    : '';
  if (agent.observation.state === 'recorded' && agent.observation.lastHookAt !== null)
    return {
      kind: 'connected-seen',
      label: 'Connected',
      tone: 'green',
      line: `Hooks are in place. Stroq was last asked about an action ${ago(agent.observation.lastHookAt, now)}.${approval}`,
    };
  return {
    kind: 'connected-unseen',
    label: 'Not seen yet',
    tone: 'orange',
    line: `Hooks are in place, but Stroq has not been asked about an action yet. Run the agent once, or use Test hook.${approval}`,
  };
}

export interface ProtectionVerdict {
  readonly tone: 'green' | 'orange' | 'red';
  readonly title: string;
  readonly detail: string;
  readonly agents: readonly {
    readonly id: AgentStatus['id'];
    readonly name: string;
    readonly state: AgentStateWords;
  }[];
}

const list = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The one answer the home screen leads with: is Stroq being asked, and if not, why. */
export function protectionVerdict(
  status: AgentStatusState,
  now: number = Date.now(),
): ProtectionVerdict {
  const agents = status.agents.map((agent) => ({
    id: agent.id,
    name: AGENT_NAMES[agent.id],
    state: agentState(agent, null, now),
  }));
  const named = (kind: AgentStateKind) =>
    agents.filter((a) => a.state.kind === kind).map((a) => a.name);
  const attention = named('attention');
  const seen = named('connected-seen');
  const unseen = named('connected-unseen');
  const notConnected = named('not-connected').concat(named('unknown'));
  if (seen.length === 0 && (attention.length > 0 || unseen.length === 0)) {
    // Nothing is asking Stroq. Say that first, then what to fix.
    const parts = [
      attention.length > 0
        ? `${list(attention)} ${attention.length === 1 ? 'has' : 'have'} hooks that will not work as they are; fix ${attention.length === 1 ? 'it' : 'them'} first.`
        : null,
      unseen.length > 0
        ? `${list(unseen)} ${unseen.length === 1 ? 'is' : 'are'} connected but not seen yet.`
        : null,
      notConnected.length > 0
        ? `${list(notConnected)} ${notConnected.length === 1 ? 'is' : 'are'} not connected.`
        : null,
    ].filter((part): part is string => part !== null);
    return {
      tone: attention.length > 0 ? 'orange' : 'red',
      title:
        attention.length > 0 ? 'No agent is asking Stroq yet' : 'No agent is connected to Stroq',
      detail:
        attention.length > 0
          ? parts.join(' ')
          : 'Until one is, nothing an agent does on this machine is judged. Connect the agent you use most.',
      agents,
    };
  }
  if (attention.length > 0)
    return {
      tone: 'orange',
      title: `${list(attention)} ${attention.length === 1 ? 'needs' : 'need'} attention`,
      detail: `Stroq is being asked by ${list(seen)}. The reason is on the row below.`,
      agents,
    };
  if (seen.length === 0)
    return {
      tone: 'orange',
      title: `${list(unseen)} ${unseen.length === 1 ? 'is' : 'are'} connected, but not seen yet`,
      detail:
        'Stroq has not been asked about an action from them yet. Run the agent once, or use Test hook on Agents.',
      agents,
    };
  const others = unseen.concat(notConnected);
  return {
    tone: 'green',
    title: `Stroq is being asked by ${list(seen)}`,
    detail:
      others.length === 0
        ? 'Every supported agent here has its hooks in place. Decisions are recorded in the journal; see Live.'
        : `${list(others)} ${others.length === 1 ? 'is' : 'are'} not being judged yet.`,
    agents,
  };
}
