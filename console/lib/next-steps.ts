import type { AgentId } from './agent-status';
import type { ProtectionVerdict } from './agent-summary';
import type { WeekView } from './week-view';

/**
 * The few things to do next, on the home screen: each a real command to run in a terminal (the
 * console only reads) or a page to open. The order is what matters most: hooks that will not work,
 * then an agent that is not connected, then one that has not been asked yet, then what was denied,
 * asked or flagged this week. With nothing to fix, two checks worth running.
 */

export interface NextStep {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  /** A command to copy, where the step is one. */
  readonly command?: string;
  /** A page of the console, where the step is there. */
  readonly href?: string;
}

export const MAX_NEXT_STEPS = 3;

const CLI = 'npx @stroq/cli';

/** Agents whose blocking `stroq prove` can check on this machine. */
const PROVABLE: ReadonlySet<AgentId> = new Set(['claude-code']);

const list = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;

export function nextSteps(verdict: ProtectionVerdict, week: WeekView | null): NextStep[] {
  const steps: NextStep[] = [];
  const of = (kind: string) => verdict.agents.filter((agent) => agent.state.kind === kind);
  const attention = of('attention');
  if (attention.length > 0)
    steps.push({
      key: 'fix',
      title: `Fix the hooks of ${list(attention.map((a) => a.name))}`,
      detail: 'They are in the settings but will not work as they are. Agents & coverage says why.',
      href: '/agents/',
    });
  const notConnected = of('not-connected');
  const first = notConnected[0];
  if (first !== undefined)
    steps.push({
      key: 'connect',
      title: `Connect ${first.name}`,
      detail:
        notConnected.length > 1
          ? `Nothing it does is judged until it asks Stroq. ${list(notConnected.slice(1).map((a) => a.name))} too.`
          : 'Nothing it does is judged until it asks Stroq.',
      command: `${CLI} init --agent ${first.id}`,
    });
  const unseen = of('connected-unseen');
  const provable = unseen.find((agent) => PROVABLE.has(agent.id));
  if (provable !== undefined)
    steps.push({
      key: 'prove',
      title: `Check that ${provable.name} is really blocked`,
      detail:
        'Its hooks are in place and have not been called yet. This runs three harmless commands and checks which ran.',
      command: `${CLI} prove`,
    });
  else if (unseen[0] !== undefined)
    steps.push({
      key: 'test',
      title: `Test ${unseen[0].name} once`,
      detail:
        'Its hooks are in place and have not been called yet. Test in agent shows they answer.',
      href: '/agents/',
    });
  const needsLook = week === null ? 0 : week.totals.deny + week.totals.ask + week.totals.suspect;
  if (needsLook > 0)
    steps.push({
      key: 'review',
      title: `See the ${needsLook.toLocaleString('en-US')} that ${needsLook === 1 ? 'needs' : 'need'} a look`,
      detail:
        'Denied, asked you or flagged this week: Live lists each under Needs a look, with its rule.',
      href: '/live/',
    });
  // With nothing recorded yet (Stroq was just installed), the sessions before it are the week to see.
  const recorded =
    week === null
      ? 0
      : week.totals.allow + week.totals.ask + week.totals.deny + week.totals.suspect;
  if (recorded === 0 && steps.length < MAX_NEXT_STEPS)
    steps.push({
      key: 'look-back',
      title: 'See what your past sessions did',
      detail:
        'Replays your agents’ sessions of the last 30 days on this machine against your policy: what would have been denied or asked about. Nothing runs and nothing is sent.',
      command: `${CLI} replay --all`,
    });
  if (steps.length < MAX_NEXT_STEPS)
    steps.push({
      key: 'sent',
      title: 'See where your keys went',
      detail: 'Reads your agent sessions on this machine and lists each key and where it was sent.',
      command: `${CLI} sent`,
    });
  if (steps.length < MAX_NEXT_STEPS)
    steps.push({
      key: 'attack',
      title: 'See what Stroq stops',
      detail: 'Runs made-up attacks against your policy. Nothing is sent and nothing runs.',
      command: `${CLI} attack`,
    });
  return steps.slice(0, MAX_NEXT_STEPS);
}
