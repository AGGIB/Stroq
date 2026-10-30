import { AGENTS, type AgentName, type ToolCall } from './data';
import type { Decision } from './status';

export type DecisionFilter = Decision | 'all';
export type AgentFilter = AgentName | 'all';

export interface CallFilter {
  readonly decision: DecisionFilter;
  readonly agent: AgentFilter;
  readonly query: string;
}

export const NO_FILTER: CallFilter = { decision: 'all', agent: 'all', query: '' };

const DECISIONS: readonly Decision[] = ['block', 'ask', 'flag', 'allow', 'nj'];
const AGENT_NAMES: readonly AgentName[] = AGENTS.map((a) => a.name);
const MAX_QUERY = 200;

/** For values from the page's own controls: anything unknown means "all". */
export function toDecisionFilter(value: string): DecisionFilter {
  return isDecision(value) ? value : 'all';
}

export function toAgentFilter(value: string): AgentFilter {
  return isAgent(value) ? value : 'all';
}

function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

function isAgent(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

/** Reads the filter from the address bar. Anything unknown falls back to "all". */
export function parseFilter(params: Pick<URLSearchParams, 'get'>): CallFilter {
  const decision = params.get('decision') ?? '';
  const agent = params.get('agent') ?? '';
  const query = (params.get('q') ?? '').slice(0, MAX_QUERY);
  return {
    decision: isDecision(decision) ? decision : 'all',
    agent: isAgent(agent) ? agent : 'all',
    query,
  };
}

/** Writes only the parts that differ from the default, so a clean view has a clean address. */
export function filterToSearch(filter: CallFilter): string {
  const params = new URLSearchParams();
  if (filter.decision !== 'all') params.set('decision', filter.decision);
  if (filter.agent !== 'all') params.set('agent', filter.agent);
  if (filter.query.trim() !== '') params.set('q', filter.query.trim());
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export function filterCalls(calls: readonly ToolCall[], filter: CallFilter): ToolCall[] {
  const needle = filter.query.trim().toLowerCase();
  return calls.filter(
    (call) =>
      (filter.decision === 'all' || call.decision === filter.decision) &&
      (filter.agent === 'all' || call.agent === filter.agent) &&
      (needle === '' ||
        call.raw.toLowerCase().includes(needle) ||
        call.label.toLowerCase().includes(needle)),
  );
}

export interface DayGroup {
  readonly date: string;
  readonly calls: readonly ToolCall[];
}

/** One pass, grouping neighbouring calls that share a date. The arrays are built here, not passed in. */
export function groupByDay(calls: readonly ToolCall[]): DayGroup[] {
  const groups: Array<{ date: string; calls: ToolCall[] }> = [];
  for (const call of calls) {
    const last = groups.at(-1);
    if (last !== undefined && last.date === call.date) last.calls.push(call);
    else groups.push({ date: call.date, calls: [call] });
  }
  return groups;
}
