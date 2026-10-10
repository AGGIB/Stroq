// The vocabulary of `stroq prove`, the live protection check.
//
// Stroq's hook says "deny" and a host is supposed to stop the action. Nothing proved that a host
// does, until this: drive the REAL host on inert probes, then show from evidence that does not come
// from the model that a denied action did not happen. These are the words that check is made of.
import { z } from 'zod';
import { ISO_TIME, isRealTime } from './iso-time.js';
import { isControlId, overallState } from './state-rule.js';

/**
 * Where a host stands. The first two are read off the machine (`installed`: the config is there;
 * `observed`: something ran the hook command after it was installed). The rest are what a live
 * check, or the passing of time, makes of it. `unsupported` comes from the table of hosts
 * (`hosts/capabilities.ts`), whose rows are assumptions until a live run has measured them: the one
 * measured fact in it is the caveat of Codex, and a host that is `unsupported` is one nobody has shown to
 * be drivable, which is not the same as one that cannot be.
 */
export const HOST_STATES = [
  'installed',
  'observed',
  'verified',
  'stale',
  'failed',
  'inconclusive',
  'not-attempted',
  'unsupported',
] as const;
export type HostState = (typeof HOST_STATES)[number];

/** The states a live check itself can end in; the others are never written down. */
export const LIVE_OUTCOMES = ['verified', 'failed', 'inconclusive', 'not-attempted'] as const;
export type LiveOutcome = (typeof LIVE_OUTCOMES)[number];

export type ProbeKind = 'allow' | 'deny' | 'secret-egress';

/** What the policy says about a probe: the effect, and the rule that said it (null: the default). */
export interface Expectation {
  readonly effect: 'allow' | 'deny' | 'ask';
  readonly ruleId: string | null;
}

/** An expectation a probe can be judged against: it is either let through or stopped. */
export interface SettledExpectation {
  readonly effect: 'allow' | 'deny';
  readonly ruleId: string | null;
}

/**
 * One inert action the model is asked to run, and how to tell afterwards whether it happened.
 * `command` is the shell text. It holds the nonce of the request it is part of, and it names every file it
 * touches by its full path inside the project, so that it is inert wherever the host runs its shell.
 */
export interface Probe {
  readonly id: string;
  readonly kind: ProbeKind;
  readonly command: string;
  /** What the DEFAULT policy says. The active policy is asked again, in process, before a run. */
  readonly expected: SettledExpectation;
  /**
   * The file the action leaves, if it runs. Whether the file is meant to be there is not said here: it
   * follows from the decision (an allow leaves it, a deny must not), which is said once, in `expected`
   * and in the expectation a run is judged against, so that the two cannot disagree.
   */
  readonly sentinel: {
    /** Relative to the project directory. */
    readonly file: string;
    /**
     * The text (trimmed) the file holds once the command has run: every probe writes the nonce of its
     * request into its file. An allow, and a control run, is only taken to have left its mark by a file that
     * holds it; for a real deny anything at the path is a trace of the action, and what it holds is not looked at.
     */
    readonly holds?: string;
  };
}

/** What is at a probe's file when it is looked at. */
export interface SentinelState {
  /** Whether anything is there. null: the path could not be looked at, so nothing is known. */
  readonly exists: boolean | null;
  /** The text of a regular file there, when it is small enough to be what a probe wrote; else null. */
  readonly content: string | null;
}

export const PROBE_MARKS = [
  'passed',
  'failed',
  'not-issued',
  'inconclusive',
  'skipped',
  'not-attempted',
] as const;
export type ProbeMark = (typeof PROBE_MARKS)[number];

/**
 * Why a probe got its mark. An open set of short codes, so that a driver or a later version can say
 * more; these are the ones this version says, and the only ones the rest of the code branches on.
 */
export const REASONS = {
  // passed
  blocked: 'blocked',
  ran: 'ran',
  armed: 'armed',
  // failed
  executedDespiteDeny: 'executed-despite-deny',
  hookBypassed: 'hook-bypassed',
  policyMismatch: 'policy-mismatch',
  // not issued
  notIssued: 'not-issued',
  // inconclusive: the run
  billingUnknown: 'billing-unknown',
  cwdMismatch: 'cwd-mismatch',
  limit: 'limit',
  auth: 'auth',
  apiBilling: 'api-billing',
  timeout: 'timeout',
  hostError: 'host-error',
  unparsableStream: 'unparsable-stream',
  // inconclusive: the evidence
  commandAltered: 'command-altered',
  extraActivity: 'extra-activity',
  controlExtraActivity: 'control-extra-activity',
  controlErrored: 'control-errored',
  auditNonceMissing: 'audit-nonce-missing',
  noAuditEntry: 'no-audit-entry',
  effectMissing: 'effect-missing',
  evidenceConflict: 'evidence-conflict',
  sentinelUnreadable: 'sentinel-unreadable',
  auditUnreadable: 'audit-unreadable',
  probeNotArmed: 'probe-not-armed',
  controlInconclusive: 'control-inconclusive',
  denyNotProvenArmed: 'deny-not-proven-armed',
  // skipped
  skippedPolicyAllows: 'skipped-policy-allows',
  skippedPolicyBlocksAllow: 'skipped-policy-blocks-allow',
  // not attempted
  hostNotFound: 'host-not-found',
  budget: 'budget',
  maxRequests: 'max-requests',
  allowNotPassed: 'allow-not-passed',
  unsafeDirectory: 'unsafe-directory',
  cannotClear: 'cannot-clear',
} as const;

/**
 * One thing a host said, in words that are the same for every host. A driver puts the shell tool of its
 * host under the name `Bash` (and gives the command as `input.command`, or as the input itself): a call
 * made with any other name is not taken to be a probe being run.
 */
export interface StreamEvent {
  readonly type: 'init' | 'tool_use' | 'tool_result' | 'text' | 'result' | 'other';
  readonly name?: string;
  readonly input?: unknown;
  readonly isError?: boolean;
  readonly text?: string;
}

/**
 * What came back from one request to a host. `stream` is the host's own account of the run, which is
 * the model's word and counts for little; the evidence that counts is read off the disk afterwards.
 */
export interface HostRun {
  readonly stream: readonly StreamEvent[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderrTail: string;
  /**
   * The host's own words, when it stopped on a usage or rate limit, or when it says it is moving the
   * subscription on to extra usage or an overage. The words of an overage are not looked for in the text of
   * a stream (they are not known to be worded one way), so a driver maps the host's signal for it here.
   */
  readonly limitHit?: string;
  /**
   * How the host says it is paid for, from its first message. Both are needed: a host that says only one of
   * them may be billing a cloud or an API key that the other would have shown. A run goes no further with a
   * host that leaves either out, and none is made of one that says it is billed to anything but a login.
   */
  readonly apiProvider?: string;
  readonly apiKeySource?: string;
  /**
   * The directory the host says it ran in, from its first message, when it says. It has to be the project:
   * the hook judges commands from there (the made-up key is looked for in the project's own `.env`). A
   * host that says another is stopped; one that does not say is not held to anything.
   */
  readonly cwd?: string;
  /** How many lines of the stream the driver could not read. A stream with any is not to be trusted. */
  readonly unparsedLines?: number;
}

/** Everything a driver needs to make one request, and nothing of the user's own setup. */
export interface ProbeContext {
  /** The temporary project directory the host is started in. */
  readonly project: string;
  /** The throwaway STROQ_HOME the hook writes its audit log and sessions to. */
  readonly stroqHome: string;
  /** The throwaway HOME the hook runs with. */
  readonly home: string;
  readonly sessionId: string;
  readonly nonce: string;
  /**
   * `real`: the user's hook command. `noop`: the control run, whose hook exits 0 and writes nothing at all
   * (to stdout or to stderr), so that the host goes on as if no hook were there. It never says "allow": an
   * explicit allow skips the host's own permission step in some hosts, and the control would then run a
   * command the host's own rules had stopped, which is what the control is there to tell apart.
   */
  readonly hookMode: 'real' | 'noop';
  readonly deadlineMs: number;
  /**
   * The environment to start the host with: the caller's, less anything that would bill an API key or
   * another cloud (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`), which `verifyHost` takes out before it hands it
   * over. A driver adds to it what its host needs and nothing of that kind.
   */
  readonly env: Record<string, string>;
}

/**
 * What a real host driver implements. Spending a request is the driver's `run`, and nothing else.
 *
 * THE CONTROL. For each deny that was stopped, `run` is called again with `hookMode: 'noop'` for the same
 * command. The control shows that the host would have run the command had the hook let it, and that is worth
 * something only if it is the same host: the real run and the control run must be started with IDENTICAL
 * settings, permission rules, allowed tools, argv, environment and working directory, but for the hook
 * command (and the session and nonce, which are each request's own). A driver that lets them differ in
 * anything else (a looser permission mode, an allow rule only the control has) makes a control that arms
 * what the real run's host would never have run, and a stop by the host's own rules then looks like a stop
 * by the hook. `test/live/driver-contract.ts` holds the check a driver's own tests run to show it keeps this.
 *
 * THE FIRST MESSAGE. A driver reports, from the first message of the host, how it is paid for (both
 * `apiProvider` and `apiKeySource`) and the directory it runs in (`cwd`). It aborts the host on that message
 * when either billing value is not a subscription login, so that no paid request is made at all; `verifyHost`
 * stops the run after a request that did not say both (or said another directory), but a request already
 * made is already paid for. It also reports as `limitHit` what the host says when it moves a subscription
 * on to extra usage or an overage, in the host's own words: that is billing the owner did not set aside.
 */
export interface HostDriver {
  detect(): Promise<{ available: boolean; version: string | null; note?: string }>;
  run(probe: Probe, ctx: ProbeContext): Promise<HostRun>;
  /**
   * Whether what this driver answers is a real host's. A result is live only when this says `'live'`:
   * a driver that does not say, or says `'stand-in'`, makes a stand-in result, which is about the
   * driver and can never be shown as a real host's. (The safe way round: forgetting to say is a
   * stand-in, and only a driver that has been through a real host is allowed to claim it is one.)
   */
  readonly mode?: 'live' | 'stand-in';
}

export interface ProbeEvidence {
  /** The stream shows the model issued the command: a shell call whose command is the probe's. */
  readonly E1: boolean | null;
  /** The hook's audit log has one entry for the command, and no other, with the decision expected. */
  readonly E2: boolean | null;
  /** The sentinel file is as the decision says: absent for a deny, there with the nonce for an allow. */
  readonly E3: boolean | null;
  /** The host's error text carries Stroq's own words for a deny: the deny came from the hook. */
  readonly E4: boolean | null;
}

export interface ProbeResult {
  readonly id: string;
  readonly kind: ProbeKind;
  readonly mark: ProbeMark;
  readonly reason?: string;
  /** One line a person can read: what was expected and what was found. Printable ASCII. */
  readonly detail?: string;
  readonly evidence: ProbeEvidence;
}

export interface HostResult {
  readonly version: 1;
  readonly agent: string;
  readonly hostVersion: string | null;
  readonly stroqVersion: string;
  readonly policySha256: string;
  /**
   * `Date#toISOString`, of the moment the check began. An install that finished while it ran is then later
   * than the result, and the result is read as made against a hook line that has since been replaced.
   */
  readonly at: string;
  /** `stand-in`: a double of a host answered, so this says nothing about the real one. */
  readonly mode: 'live' | 'stand-in';
  readonly probes: readonly ProbeResult[];
  readonly state: LiveOutcome;
  /**
   * What this result does not show, as short codes: the caveats of the host's row in the table (assumptions
   * until a live run has measured them, but for the one measured caveat of Codex), what the driver said
   * when it looked for the host, and what the run itself could not show.
   */
  readonly caveats: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// The stored form.
//
// `stroq doctor` reads this file and prints from it, so every string in it is plain printable
// ASCII of a bounded length (nothing a terminal would obey), every object is closed (a key the
// schema does not name is a refusal, not something to carry along), and a file that is wrong in
// any place reads as no result at all, never as a part of one.

/** Names of agents: lower case and hyphens, never a path. */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** Probe ids and reason codes: short, lower case, no spaces. */
const CODE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^[\x20-\x7e]{1,80}$/;
const CAVEAT_TEXT = /^[\x20-\x7e]{1,120}$/;
const DETAIL_TEXT = /^[\x20-\x7e]{1,160}$/;
const MAX_PROBES = 16;
const MAX_CAVEATS = 16;

const EvidenceSchema = z.strictObject({
  E1: z.boolean().nullable(),
  E2: z.boolean().nullable(),
  E3: z.boolean().nullable(),
  E4: z.boolean().nullable(),
});

const ProbeResultSchema = z.strictObject({
  id: z.string().regex(CODE),
  kind: z.enum(['allow', 'deny', 'secret-egress']),
  mark: z.enum(PROBE_MARKS),
  reason: z.string().regex(CODE).optional(),
  detail: z.string().regex(DETAIL_TEXT).optional(),
  evidence: EvidenceSchema,
});

export const HostResultSchema = z.strictObject({
  version: z.literal(1),
  agent: z.string().regex(AGENT_NAME),
  hostVersion: z.string().regex(VERSION_TEXT).nullable(),
  stroqVersion: z.string().regex(VERSION_TEXT),
  policySha256: z.string().regex(SHA256),
  at: z.string().regex(ISO_TIME).refine(isRealTime),
  mode: z.enum(['live', 'stand-in']),
  probes: z.array(ProbeResultSchema).max(MAX_PROBES),
  state: z.enum(LIVE_OUTCOMES),
  caveats: z.array(z.string().regex(CAVEAT_TEXT)).max(MAX_CAVEATS),
});

type ParsedShape = z.infer<typeof HostResultSchema>;

/** Builds the result with the keys that are absent left off, which `exactOptionalPropertyTypes` asks for. */
function toHostResult(data: ParsedShape): HostResult {
  return {
    version: 1,
    agent: data.agent,
    hostVersion: data.hostVersion,
    stroqVersion: data.stroqVersion,
    policySha256: data.policySha256,
    at: data.at,
    mode: data.mode,
    probes: data.probes.map((probe) => ({
      id: probe.id,
      kind: probe.kind,
      mark: probe.mark,
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
      ...(probe.detail === undefined ? {} : { detail: probe.detail }),
      evidence: {
        E1: probe.evidence.E1,
        E2: probe.evidence.E2,
        E3: probe.evidence.E3,
        E4: probe.evidence.E4,
      },
    })),
    state: data.state,
    caveats: [...data.caveats],
  };
}

export type ParsedHostResult =
  | { readonly ok: true; readonly result: HostResult }
  | { readonly ok: false; readonly problem: string };

/**
 * A stored result, or why it is not one. The reason names the field that is wrong and never repeats
 * what the file said there: the file is not to be trusted with what a person reads.
 */
export function parseHostResult(raw: unknown): ParsedHostResult {
  const parsed = HostResultSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    return {
      ok: false,
      problem: `does not match the result format (${where === '' ? 'whole file' : where})`,
    };
  }
  const result = toHostResult(parsed.data);
  // A mark is a claim about the evidence stored beside it, and a file that claims a pass over evidence
  // that does not say so was not made by a check.
  if (!result.probes.every(isSupportedByItsEvidence))
    return { ok: false, problem: 'evidence-inconsistent' };
  // The state is what the probes come to. A stored state that says more or less than that was not made
  // by a check, but by an edit, an older Stroq with another rule, or a bug; none of them is a result.
  const marked = result.probes.map((probe) => ({
    id: probe.id,
    kind: probe.kind,
    mark: probe.mark,
    e4: probe.evidence.E4,
  }));
  if (overallState(marked) !== result.state) return { ok: false, problem: 'state-inconsistent' };
  return { ok: true, result };
}

/**
 * Whether the evidence stored with a mark says what the mark claims, as a check that made the mark would
 * have left it: a pass of a real probe is the command issued (E1), the hook's one entry as expected (E2)
 * and the file as the decision says (E3); a pass of a control has no hook to ask, and is the command
 * issued and its file there; a failure is at least a command that was issued. The other marks claim
 * nothing, and their evidence may be all unknown.
 */
function isSupportedByItsEvidence(probe: ProbeResult): boolean {
  const { E1, E2, E3 } = probe.evidence;
  if (probe.mark === 'failed') return E1 === true;
  if (probe.mark !== 'passed') return true;
  return isControlId(probe.id)
    ? E1 === true && E3 === true
    : E1 === true && E2 === true && E3 === true;
}
