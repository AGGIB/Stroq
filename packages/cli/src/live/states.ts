// Which of the eight states `stroq doctor` shows for a host.
//
// There are two halves to the rule, and they are kept apart. What the machine shows (a hook entry in
// the host's config, a call to the hook command after it was installed) can raise a host as far as
// "observed", which says that something ran the command and nothing about whether the host obeys it.
// Only a stored live check can say more, and only while Stroq, the policy and the host are the ones it
// was run against. A check that could not tell stays one that could not tell: it is never turned into
// a pass, and never into a failure.
//
// The one place the rule leans is on the side of caution: a failure is lifted by a later check and by
// nothing else. A new version of anything is a reason to look again and not a reason to look away.
import type { AgentHookStatus } from '../commands/doctor.js';
import type { HostCapability } from '../hosts/capabilities.js';
import type { HostResult, HostState } from './types.js';

/**
 * What the report of a host's hook install says. `installed` and `changed` are what
 * `AgentHookStatus` carries today; the rest are the other ways the doctor knows an installed hook is
 * not working (a path that is gone, an approval that is missing, a file that shadows it, a command that
 * cannot start), for a caller that has read them off the scopes.
 */
export interface InstallStatus extends Pick<AgentHookStatus, 'installed' | 'changed'> {
  readonly vanished?: boolean | undefined;
  readonly unapproved?: boolean | undefined;
  readonly shadowed?: boolean | undefined;
  readonly unstartable?: boolean | undefined;
}

export interface DisplayStateInput {
  /** The agent's entry in the capability table; undefined for an agent that is not in it. */
  readonly capabilities: HostCapability | undefined;
  readonly installed: InstallStatus;
  /** When the hook command was last run on this machine for the agent (the hook stamp). */
  readonly stampAt: Date | null;
  /** When `stroq init` recorded the install. */
  readonly installRecordedAt: Date | null;
  readonly stored: HostResult | null;
  /** Today's Stroq, policy and host, which a stored check is held against. */
  readonly stroqVersion: string;
  readonly policySha256: string;
  readonly hostVersion: string | null;
}

export interface DisplayedState {
  readonly state: HostState;
  /** One line of plain characters, for `doctor` to print after the state. */
  readonly reason: string;
}

const shown = (state: HostState, reason: string): DisplayedState => ({ state, reason });

/** Why an installed-or-not hook is not a working one, or null when nothing is known to be wrong. */
function installProblem(status: InstallStatus): string | null {
  if (!status.installed) return 'the hook is not installed';
  if (status.changed) return 'the hook entry changed since stroq init';
  if (status.vanished === true) return 'the hook command points at a path that no longer exists';
  if (status.unapproved === true) return 'the host has not approved the hook';
  if (status.shadowed === true) return 'another file shadows the hook';
  if (status.unstartable === true) return 'the hook command cannot start';
  return null;
}

const day = (result: HostResult): string => result.at.slice(0, 10);

const hostChange = (then: string | null, now: string | null): string =>
  then === null
    ? 'the host version was not known then'
    : now === null
      ? 'the host version is not known now'
      : `the host went from ${then} to ${now}`;

/** What differs between the machine today and the one a result was made on; empty when nothing does. */
function whatChanged(result: HostResult, today: DisplayStateInput): string[] {
  return [
    ...(result.stroqVersion === today.stroqVersion
      ? []
      : [`Stroq ${result.stroqVersion} is now ${today.stroqVersion}`]),
    ...(result.policySha256 === today.policySha256 ? [] : ['the policy changed']),
    ...(result.hostVersion === today.hostVersion
      ? []
      : [hostChange(result.hostVersion, today.hostVersion)]),
  ];
}

const MAX_LISTED = 4;

/** At most a few of the distinct items, in the order they came, as one line. */
const listed = (items: readonly string[]): string =>
  [...new Set(items)].slice(0, MAX_LISTED).join(', ');

/** The probes that failed, and why. */
const failures = (result: HostResult): string =>
  listed(
    result.probes
      .filter((probe) => probe.mark === 'failed')
      .map((probe) => `${probe.id} ${probe.reason ?? probe.mark}`),
  );

/** Why the probes that did not pass did not. */
const doubts = (result: HostResult): string =>
  listed(
    result.probes
      .filter((probe) => probe.mark !== 'passed')
      .map((probe) => probe.reason ?? probe.mark),
  );

/** `: x` after a line, or nothing when there is no x. */
const because = (why: string): string => (why === '' ? '' : `: ${why}`);

function fromResult(result: HostResult, today: DisplayStateInput): DisplayedState {
  const changes = whatChanged(result, today);
  switch (result.state) {
    case 'verified':
      return changes.length === 0
        ? shown(
            'verified',
            `checked ${day(result)} against ${result.hostVersion ?? 'the host'}: a denied action was stopped`,
          )
        : shown(
            'stale',
            `checked ${day(result)}, but ${changes.join('; ')}; run stroq prove again`,
          );
    case 'failed': {
      const later =
        changes.length === 0
          ? ''
          : '; Stroq, the policy or the host changed since: run stroq prove again';
      return shown(
        'failed',
        `the live check of ${day(result)} failed${because(failures(result))}${later}`,
      );
    }
    case 'inconclusive':
      return shown(
        'inconclusive',
        `the live check of ${day(result)} could not tell${because(doubts(result))}`,
      );
    case 'not-attempted':
      return shown(
        'not-attempted',
        `the live check of ${day(result)} did not run${because(doubts(result))}`,
      );
  }
}

export function displayState(input: DisplayStateInput): DisplayedState {
  const capabilities = input.capabilities;
  if (capabilities === undefined)
    return shown('unsupported', 'no live check is defined for this agent');
  if (!capabilities.headless)
    return shown('unsupported', capabilities.reason ?? 'no headless mode');

  // A stand-in answers the questions it was built to answer, and is about the stand-in. It is not
  // a check of the host, so nothing it says is shown as one.
  const result = input.stored !== null && input.stored.mode === 'live' ? input.stored : null;
  const problem = installProblem(input.installed);

  if (problem !== null) {
    if (result?.state === 'failed') return fromResult(result, input);
    if (result?.state === 'verified')
      return shown('stale', `checked ${day(result)}, but ${problem}; run stroq prove again`);
    return shown('not-attempted', problem);
  }
  if (result !== null) return fromResult(result, input);

  // Only a call after the install says anything about the line that is there now. With no record of
  // when it was installed there is nothing to compare a call with.
  const called =
    input.stampAt !== null &&
    input.installRecordedAt !== null &&
    input.stampAt.getTime() > input.installRecordedAt.getTime();
  return called
    ? shown(
        'observed',
        'something ran the hook command after it was installed; not checked against the host',
      )
    : shown('installed', 'the hook is installed; no call has been seen since the install');
}
