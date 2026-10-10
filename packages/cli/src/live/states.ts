// Which of the eight states `stroq doctor` shows for a host.
//
// There are two halves to the rule, and they are kept apart. What the machine shows (a hook entry in
// the host's config, a call to the hook command after it was installed) can raise a host as far as
// "observed", which says that something ran the command and nothing about whether the host obeys it.
// Only a stored live check can say more, and only while Stroq, the policy, the host and the hook line are
// the ones it was run against. A check that could not tell stays one that could not tell: it is never
// turned into a pass, and never into a failure.
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

/** A reason is one line of a person's screen: no longer than this. */
const MAX_REASON_CHARS = 400;

const shown = (state: HostState, reason: string): DisplayedState => ({
  state,
  reason: reason.slice(0, MAX_REASON_CHARS),
});

/** What is wrong with an installed-or-not hook, and what to do about it. */
interface InstallProblem {
  readonly problem: string;
  readonly fix: string;
}

const RUN_INIT = 'run stroq init';
const SEE_DOCTOR = 'see stroq doctor for what to do';

/**
 * Why an installed-or-not hook is not a working one, or null when nothing is known to be wrong. The fix
 * is for the hook: a check run again against a hook that does not work finds nothing new, so it is never
 * "run stroq prove again".
 */
function installProblem(status: InstallStatus): InstallProblem | null {
  if (!status.installed) return { problem: 'the hook is not installed', fix: RUN_INIT };
  if (status.changed) return { problem: 'the hook entry changed since stroq init', fix: RUN_INIT };
  if (status.vanished === true)
    return {
      problem: 'the hook command points at a path that no longer exists',
      fix: RUN_INIT,
    };
  if (status.unapproved === true)
    return {
      problem: 'the host has not approved the hook',
      fix: 'start the host and approve the hook',
    };
  if (status.shadowed === true)
    return { problem: 'another file shadows the hook', fix: SEE_DOCTOR };
  if (status.unstartable === true)
    return { problem: 'the hook command cannot start', fix: SEE_DOCTOR };
  return null;
}

const day = (result: HostResult): string => result.at.slice(0, 10);

/**
 * Whether the host today is the host of the check. Two versions that are both not known are not the same
 * version: a host that was updated since is exactly what a check cannot tell if it never knew which host
 * it checked. A check with no host at all (the MCP proxy) has none to know, and so is the same.
 */
const sameHost = (then: string | null, now: string | null, hostFree: boolean): boolean =>
  then === now && (then !== null || hostFree);

const hostChange = (then: string | null, now: string | null): string =>
  then === null && now === null
    ? 'the version of the host is not known, so the check cannot be tied to the host as it is now'
    : then === null
      ? 'the host version was not known then'
      : now === null
        ? 'the host version is not known now'
        : `the host went from ${then} to ${now}`;

/**
 * Whether `stroq init` was run after the check. It writes the hook line again, and the line the check
 * ran with may not be the one that is there now.
 */
const installedAgain = (result: HostResult, recordedAt: Date | null): boolean =>
  recordedAt !== null && recordedAt.getTime() > Date.parse(result.at);

/** What differs between the machine today and the one a result was made on; empty when nothing does. */
function whatChanged(result: HostResult, today: DisplayStateInput): string[] {
  return [
    ...(result.stroqVersion === today.stroqVersion
      ? []
      : [`Stroq ${result.stroqVersion} is now ${today.stroqVersion}`]),
    ...(result.policySha256 === today.policySha256 ? [] : ['the policy changed']),
    ...(sameHost(result.hostVersion, today.hostVersion, today.capabilities?.hostFree === true)
      ? []
      : [hostChange(result.hostVersion, today.hostVersion)]),
    ...(installedAgain(result, today.installRecordedAt)
      ? ['the hook was installed again after the check']
      : []),
  ];
}

const MAX_LISTED = 4;
const MAX_CAVEATS_SHOWN = 3;
const MAX_CAVEAT_CHARS = 40;

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

/**
 * What the result does not show, as the result says it (`hook-trust-bypassed` for a check driven with a
 * host's trust check switched off, and so on). A few, each cut short; the rest are counted. Without it a
 * check with a caveat would read as a check without one.
 */
function caveatsOf(result: HostResult): string {
  const all = [...new Set(result.caveats)];
  if (all.length === 0) return '';
  const cut = (caveat: string): string =>
    caveat.length > MAX_CAVEAT_CHARS ? `${caveat.slice(0, MAX_CAVEAT_CHARS)}...` : caveat;
  const some = all.slice(0, MAX_CAVEATS_SHOWN).map(cut).join(', ');
  const more = all.length > MAX_CAVEATS_SHOWN ? ` (+${all.length - MAX_CAVEATS_SHOWN} more)` : '';
  return `; caveats: ${some}${more}`;
}

function fromResult(
  result: HostResult,
  today: DisplayStateInput,
  broken: InstallProblem | null,
): DisplayedState {
  const changes = whatChanged(result, today);
  // What to do next. With a hook that does not work it is the hook, and only then is it another check.
  const next = broken === null ? 'run stroq prove again' : broken.fix;
  const caveats = caveatsOf(result);
  switch (result.state) {
    case 'verified':
      return changes.length === 0
        ? shown(
            'verified',
            `checked ${day(result)} against ${result.hostVersion ?? 'the host'}: a denied action was stopped${caveats}`,
          )
        : shown('stale', `checked ${day(result)}, but ${changes.join('; ')}${caveats}; ${next}`);
    case 'failed': {
      const later =
        changes.length === 0
          ? ''
          : `; Stroq, the policy, the host or the hook changed since: ${next}`;
      return shown(
        'failed',
        `the live check of ${day(result)} failed${because(failures(result))}${caveats}${later}`,
      );
    }
    case 'inconclusive':
      return shown(
        'inconclusive',
        `the live check of ${day(result)} could not tell${because(doubts(result))}${caveats}`,
      );
    case 'not-attempted':
      return shown(
        'not-attempted',
        `the live check of ${day(result)} did not run${because(doubts(result))}${caveats}`,
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
  const broken = installProblem(input.installed);

  if (broken !== null) {
    if (result?.state === 'failed') return fromResult(result, input, broken);
    if (result?.state === 'verified')
      return shown(
        'stale',
        `checked ${day(result)}, but ${broken.problem}${caveatsOf(result)}; ${broken.fix}`,
      );
    return shown('not-attempted', `${broken.problem}; ${broken.fix}`);
  }
  if (result !== null) return fromResult(result, input, null);

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
