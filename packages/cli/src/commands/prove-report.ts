// What `stroq prove` found, as a value: the words (`prove-text.ts`), the JSON and the exit code are all made
// from this, so that they cannot disagree.
//
// Two rules are kept here and nowhere else. A result that a double of the host gave is never the host's:
// its state is "not attempted", whatever its probes came to, and its exit code is 3. And only a live
// check that verified exits 0, and only a live check that failed exits 1; everything else, which is every
// way of not knowing, exits 3.
import { isControlId } from '../live/state-rule.js';
import { REASONS, type HostResult, type HostState, type ProbeResult } from '../live/types.js';

export interface ProveReport {
  readonly version: 1;
  readonly agent: string;
  readonly hostVersion: string | null;
  readonly state: HostState;
  /** Whose answers these are: a real host's, a double's, or null when no check was run. */
  readonly mode: 'live' | 'stand-in' | null;
  readonly probes: readonly ProbeResult[];
  readonly requestsMade: number;
  readonly caveats: readonly string[];
  readonly advice: readonly string[];
}

/** Exit codes: the verdict, and 2 (usage) which the command gives before there is a report. */
export const EXIT_VERIFIED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_VERIFIED = 3;

/** Marks that no request was made for. */
const NO_REQUEST: ReadonlySet<string> = new Set(['skipped', 'not-attempted']);

/** How many requests a run made: one for each probe that was not skipped or left unattempted. */
export const requestsMadeBy = (probes: readonly { readonly mark: string }[]): number =>
  probes.filter((probe) => !NO_REQUEST.has(probe.mark)).length;

const STAND_IN_CAVEAT =
  'stand-in: a double of the host answered, so nothing is known of the real one';

// ---------------------------------------------------------------------------------------------
// Advice: what to do next, in at most three lines.

const MAX_ADVICE_LINES = 3;

/** What to do about the reason a probe did not pass, most blocking first (the first that is found is said). */
const ADVICE_BY_REASON: ReadonlyArray<readonly [reason: string, line: string]> = [
  [
    REASONS.hostNotIsolated,
    'Another hook or managed configuration blocks isolation. A user-level Stroq install writes ~/.codex/hooks.json: back it up and temporarily move it aside yourself, then restore it after the check. Managed settings need an unmanaged host.',
  ],
  [
    REASONS.loginUnconfirmed,
    'Run codex login with your ChatGPT subscription and verify codex login status prints only Logged in using ChatGPT.',
  ],
  [
    REASONS.modelUnavailable,
    'The fixed Codex model is unavailable on this account. Check the model access in Codex; this driver cannot prove protection with a different model yet.',
  ],
  [
    REASONS.hostNotFound,
    'Install the agent CLI and make sure its executable is on your PATH, then run stroq prove again.',
  ],
  [REASONS.auth, 'Log in to the agent CLI with your subscription, then run stroq prove again.'],
  [
    REASONS.limit,
    'Your plan hit a usage limit or moved on to paid usage. Wait for it to reset, then run stroq prove again.',
  ],
  [
    REASONS.apiBilling,
    'The host said it is paid for by an API key or a cloud account. Stroq never spends that on this check: use your subscription login, then run stroq prove again.',
  ],
  [
    REASONS.billingUnknown,
    'The host did not confirm how it is paid for. Update the agent CLI and check your subscription login, then run stroq prove again.',
  ],
  [
    REASONS.budget,
    'The budget for live checks is spent (STROQ_LIVE_LEDGER names the file that counts it).',
  ],
  [REASONS.timeout, 'The host did not answer in time. Run stroq prove again.'],
  [
    REASONS.hostError,
    'The host failed. Check the installed agent CLI and your subscription login, then run stroq prove again.',
  ],
  [
    REASONS.unparsableStream,
    'The output of the host could not be read, which an update of the agent CLI can cause. Run stroq prove again, and report it if it keeps happening.',
  ],
  [
    REASONS.cwdMismatch,
    'The host ran in another directory than the check made for it. Run stroq prove again.',
  ],
  [
    REASONS.notIssued,
    'The model did not issue the command it was given. That says nothing either way: run stroq prove again.',
  ],
  [
    REASONS.probeNotArmed,
    'The host did not run the command even with the hook out of the way, so its stop proves nothing. Run stroq prove again.',
  ],
  [
    REASONS.maxRequests,
    'The limit on requests stopped the run. Raise it with --max-requests (6 at most).',
  ],
];

const GENERIC_ADVICE = 'Nothing was proven either way. Run stroq prove again.';

const VERIFIED_ADVICE = [
  'Run it again after you update the host or change your policy: stroq doctor marks the proof stale then.',
];

const FAILED_ADVICE = [
  'Do not rely on the hook with this host until this is fixed.',
  'Run stroq doctor, put the hook in again with stroq init, and run stroq prove again.',
  'If it fails again, report it with the output of stroq prove --json.',
];

/**
 * The model refuses the secret-egress command on its own ("it looks like credential exfiltration": measured on
 * Claude Code 2.1.271), answers BLOCKED and issues nothing. That is the model and not the hook, and the probe is
 * the optional last one, so it is no reason to run the check again.
 */
const DECLINED_ADVICE =
  'The model itself declined the secret-egress command, which looks like credential exfiltration to it. That probe is optional: no action is needed when the other probes verify the host.';

const STAND_IN_ADVICE = [
  'A double of the host answered, so nothing is known of the real host itself. Run stroq prove against the real host.',
];

/** The secret-egress probe, when the model would not issue its command. */
const wasDeclined = (probe: ProbeResult): boolean =>
  probe.kind === 'secret-egress' && !isControlId(probe.id) && probe.mark === 'not-issued';

const reasonsOf = (probes: readonly ProbeResult[]): ReadonlySet<string> =>
  new Set(
    probes
      .filter((probe) => probe.mark !== 'passed' && !wasDeclined(probe))
      .flatMap((probe) => (probe.reason === undefined ? [] : [probe.reason])),
  );

/** What to do next, in at most three lines, from what the check found. */
export function adviceFor(report: Pick<ProveReport, 'state' | 'mode' | 'probes'>): string[] {
  if (report.mode === 'stand-in') return [...STAND_IN_ADVICE];
  if (report.state === 'failed') return [...FAILED_ADVICE];
  const declined = report.probes.some(wasDeclined) ? [DECLINED_ADVICE] : [];
  if (report.state === 'verified') return [...VERIFIED_ADVICE, ...declined];
  const reasons = reasonsOf(report.probes);
  const found = ADVICE_BY_REASON.find(([reason]) => reasons.has(reason));
  return [found === undefined ? GENERIC_ADVICE : found[1], ...declined].slice(0, MAX_ADVICE_LINES);
}

// ---------------------------------------------------------------------------------------------

/** The report of a check that was run. */
export function reportOf(result: HostResult): ProveReport {
  const standIn = result.mode !== 'live';
  const base = {
    version: 1 as const,
    agent: result.agent,
    hostVersion: result.hostVersion,
    state: standIn ? ('not-attempted' as const) : result.state,
    mode: result.mode,
    probes: [...result.probes],
    requestsMade: requestsMadeBy(result.probes),
    caveats: standIn ? [STAND_IN_CAVEAT, ...result.caveats] : [...result.caveats],
  };
  return { ...base, advice: adviceFor(base) };
}

/** The report of a check that was not run: no host, no driver, not on this system, not agreed to. */
export function notRunReport(
  agent: string,
  state: HostState,
  hostVersion: string | null,
  why: string,
  advice: readonly string[] = [],
): ProveReport {
  const base = {
    version: 1 as const,
    agent,
    hostVersion,
    state,
    mode: null,
    probes: [] as ProbeResult[],
    requestsMade: 0,
    caveats: [why],
  };
  return {
    ...base,
    advice: (advice.length === 0 ? [GENERIC_ADVICE] : [...advice]).slice(0, MAX_ADVICE_LINES),
  };
}

const adviceFor1 = (reason: string): string[] => {
  const found = ADVICE_BY_REASON.find(([each]) => each === reason);
  return found === undefined ? [] : [found[1]];
};

/** An agent there is no driver for: the table's reason, if it gives one, and what can be checked. */
export function unsupportedReport(
  agent: string,
  reason: string | undefined,
  supported: readonly string[],
): ProveReport {
  return notRunReport(
    agent,
    'unsupported',
    null,
    `there is no live check for ${agent} yet${reason === undefined ? '' : ` (${reason})`}`,
    [`Only ${supported.join(', ')} can be checked today.`],
  );
}

export const windowsReport = (agent: string): ProveReport =>
  notRunReport(agent, 'unsupported', null, 'the live check does not run on Windows yet', [
    'Run it on macOS or Linux; Windows is not covered yet.',
  ]);

/** The host is not there: what the driver said, and how to get it. */
export const hostNotFoundReport = (agent: string, note: string | undefined): ProveReport =>
  notRunReport(
    agent,
    'not-attempted',
    null,
    note ?? 'the host was not found',
    adviceFor1(REASONS.hostNotFound),
  );

export const declinedReport = (agent: string, hostVersion: string | null): ProveReport =>
  notRunReport(agent, 'not-attempted', hostVersion, 'you did not agree to the requests', [
    'Nothing was done.',
  ]);

export const dryRunReport = (agent: string, hostVersion: string | null): ProveReport =>
  notRunReport(agent, 'not-attempted', hostVersion, 'dry run: no request was made', [
    'Run stroq prove --yes to make the check.',
  ]);

/** 0 for a live check that verified, 1 for one that failed, 3 for every other way of not knowing. */
export function exitCodeOf(report: ProveReport): number {
  if (report.mode !== 'live') return EXIT_NOT_VERIFIED;
  if (report.state === 'verified') return EXIT_VERIFIED;
  return report.state === 'failed' ? EXIT_FAILED : EXIT_NOT_VERIFIED;
}
