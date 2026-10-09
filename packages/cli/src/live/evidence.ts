// What a run proves, and what it does not.
//
// A host is asked to run an inert command. The model's stream says it did; that is the model's own
// account and counts for little. What counts is read afterwards, from places the model does not write:
//
//   E1  the stream has a tool call with this request's nonce in it: the command was issued;
//   E2  the hook's own audit log, for this session, has an entry with the nonce in its summary and the
//       decision (effect and rule) the policy was seen to give in process: the hook judged it;
//   E3  the file on the disk is as the decision says: absent for a deny, there with the nonce for an
//       allow: the host did what the hook said;
//   E4  the words the host gave back for the call carry Stroq's own deny wording: the stop came from
//       the hook, and not from the host's own permission rules.
//
// These are pure functions of what was read. They hold the rules by which a probe passes, fails, or
// proves nothing, and the one rule above the others: a pass is never given on less than all three of
// E1, E2 and E3, on a run that ended as a run ends. Anything short of that is inconclusive, and a
// command that was never issued is "not issued", which is not a pass either.
import type { AuditEntry } from '@stroq/core';
import { authTextOf, limitTextOf } from './limit-text.js';
import {
  REASONS,
  type HostRun,
  type Probe,
  type ProbeEvidence,
  type ProbeMark,
  type SentinelState,
  type SettledExpectation,
  type StreamEvent,
} from './types.js';

/**
 * How every adapter starts the reason it gives for a deny: `Stroq blocked this action (<rule>): …`.
 * (`evidence.test.ts` takes the words from the Claude Code adapter itself, so that a change there
 * shows up here.)
 */
export const DENY_WORDING = 'Stroq blocked this action';

/** A detail is one line a person reads: the longest of them. */
const MAX_DETAIL_CHARS = 160;

/**
 * What a host reports as the way it is paid for, when it is a login and no key. Anything else is a key
 * that bills an account other than the subscription, and this check never spends that.
 */
const SUBSCRIPTION_KEY_SOURCES: ReadonlySet<string> = new Set(['none', 'oauth']);

/** Text from outside made into one line of plain characters, for a field that is printed. */
export function plainText(text: string, max: number = MAX_DETAIL_CHARS): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// The run.

export interface RunProblem {
  readonly reason: string;
  readonly detail: string;
}

const problem = (reason: string, detail: string): RunProblem => ({
  reason,
  detail: plainText(detail),
});

/**
 * Whether the run itself went wrong, apart from what it did: it ran into a limit, nobody was logged
 * in, it was billed to somewhere it must not be, it was cut off, it ended with an error, or what it
 * wrote cannot be read. Such a run proves nothing either way, so it is never a pass and never a
 * failure: a run that was cut off is one whose disk is still changing, and a stream that cannot be
 * read is one in which the model's part is not known.
 *
 * Only the host's own error words are read for a limit or a login (stderr, and a final result marked
 * as an error). What the model said and what a command printed are not the host's word.
 */
export function runProblem(run: HostRun): RunProblem | null {
  if (run.limitHit !== undefined) return problem(REASONS.limit, `the host said: ${run.limitHit}`);
  if (run.apiProvider !== undefined && run.apiProvider !== 'firstParty')
    return problem(REASONS.apiBilling, `the host is not first party (${run.apiProvider})`);
  if (
    run.apiKeySource !== undefined &&
    !SUBSCRIPTION_KEY_SOURCES.has(run.apiKeySource.trim().toLowerCase())
  )
    return problem(REASONS.apiBilling, `the host used an API key (${run.apiKeySource})`);
  const errors = run.stream.filter((e) => e.type === 'result' && e.isError === true);
  const words = [run.stderrTail, ...errors.map((e) => e.text ?? '')];
  for (const text of words) {
    const limit = limitTextOf(text);
    if (limit !== null) return problem(REASONS.limit, `the host said: ${limit}`);
  }
  for (const text of words) {
    const auth = authTextOf(text);
    if (auth !== null) return problem(REASONS.auth, `the host said: ${auth}`);
  }
  if (run.timedOut) return problem(REASONS.timeout, 'the host did not answer in time');
  if (run.exitCode !== 0)
    return problem(
      REASONS.hostError,
      run.exitCode === null
        ? 'the host did not run to the end'
        : `the host exited with code ${run.exitCode}`,
    );
  if (errors.length > 0) return problem(REASONS.hostError, 'the host ended with an error');
  if (!run.stream.some((e) => e.type === 'result'))
    return problem(REASONS.unparsableStream, 'no final result could be read from the stream');
  return null;
}

// ---------------------------------------------------------------------------------------------
// The four pieces of evidence.

export type AuditFinding =
  | { readonly state: 'absent' }
  | { readonly state: 'agrees' }
  | {
      readonly state: 'differs';
      readonly saw: { readonly effect: string; readonly ruleId: string | null };
    };

export interface EvidenceInput {
  readonly probe: Pick<Probe, 'sentinel'>;
  readonly nonce: string;
  /** The session of this request. Entries of any other are not evidence of it. */
  readonly sessionId: string;
  readonly run: HostRun;
  /** The audit entries read from the throwaway home, of this session or of all. */
  readonly audit: readonly AuditEntry[];
  readonly sentinel: SentinelState;
  /** What the active policy said, in process, about this command. */
  readonly expectation: SettledExpectation;
}

export interface Evidence {
  readonly E1: boolean;
  readonly E2: boolean;
  readonly E3: boolean | null;
  readonly E4: boolean | null;
  readonly audit: AuditFinding;
  /**
   * The probe's action left its mark. What the sentinel says, whichever way the decision went: for a
   * deny it is the failure to look for, for an allow it is the thing that was asked for.
   */
  readonly effectSeen: boolean | null;
}

function mentions(value: unknown, nonce: string): boolean {
  if (typeof value === 'string') return value.includes(nonce);
  try {
    return JSON.stringify(value)?.includes(nonce) === true;
  } catch {
    return false;
  }
}

/** True when the model issued a call with the nonce in it. Its words and the results of calls do not count. */
const issued = (stream: readonly StreamEvent[], nonce: string): boolean =>
  stream.some((event) => event.type === 'tool_use' && mentions(event.input, nonce));

const describeDecision = (effect: string, ruleId: string | null): string =>
  `${effect} (${ruleId ?? 'no rule'})`;

/**
 * What the hook's audit log says of this request. The first entry for the command is the one that
 * counts: a second try (the model is asked not to) can meet a session the first has tainted, and a
 * different rule, and the first time the hook saw the command is the cleanest.
 */
function auditFinding(input: EvidenceInput): AuditFinding {
  const entry = input.audit.find(
    (e) => e.sessionId === input.sessionId && e.phase === 'pre' && e.summary.includes(input.nonce),
  );
  if (entry === undefined) return { state: 'absent' };
  const saw = {
    effect: entry.decision?.effect ?? 'none',
    ruleId: entry.decision?.ruleId ?? null,
  };
  return saw.effect === input.expectation.effect && saw.ruleId === input.expectation.ruleId
    ? { state: 'agrees' }
    : { state: 'differs', saw };
}

function effectOf(probe: Pick<Probe, 'sentinel'>, sentinel: SentinelState): boolean | null {
  if (sentinel.exists === null) return null;
  if (!sentinel.exists) return false;
  const holds = probe.sentinel.holds;
  return holds === undefined || (sentinel.content !== null && sentinel.content.trim() === holds);
}

/** True when the host passed on the hook's own words for the call (a host's own refusal is worded otherwise). */
function denyWordsSeen(
  stream: readonly StreamEvent[],
  expectation: SettledExpectation,
): boolean | null {
  if (expectation.effect !== 'deny') return null;
  const needle = `${DENY_WORDING} (${expectation.ruleId})`;
  return stream.some(
    (event) =>
      event.type === 'tool_result' && event.text !== undefined && event.text.includes(needle),
  );
}

export function gatherEvidence(input: EvidenceInput): Evidence {
  const audit = auditFinding(input);
  const effectSeen = effectOf(input.probe, input.sentinel);
  return {
    E1: issued(input.run.stream, input.nonce),
    E2: audit.state === 'agrees',
    E3: input.probe.sentinel.mustExist || effectSeen === null ? effectSeen : !effectSeen,
    E4: denyWordsSeen(input.run.stream, input.expectation),
    audit,
    effectSeen,
  };
}

// ---------------------------------------------------------------------------------------------
// The marks.

export interface ProbeOutcome {
  readonly mark: ProbeMark;
  readonly reason: string;
  /** One line of plain characters on what was expected and what was found. */
  readonly detail?: string;
  readonly evidence: ProbeEvidence;
}

const outcome = (
  mark: ProbeMark,
  reason: string,
  evidence: ProbeEvidence,
  detail?: string,
): ProbeOutcome => ({
  mark,
  reason,
  ...(detail === undefined ? {} : { detail: plainText(detail) }),
  evidence,
});

const evidenceOf = (facts: Evidence): ProbeEvidence => ({
  E1: facts.E1,
  E2: facts.E2,
  E3: facts.E3,
  E4: facts.E4,
});

const wasUnreadable = (run: HostRun): boolean => (run.unparsedLines ?? 0) > 0;

/**
 * The mark of one probe:
 *
 * - a run that went wrong is inconclusive, whatever else it shows;
 * - a command the stream does not show is "not issued" only when nothing else shows it either; if the
 *   audit or the disk do, the evidence disagrees with itself and nothing is concluded;
 * - a command that was issued is passed only when the hook judged it as expected (E2) and the disk is
 *   as that decision says (E3); fails when the hook did not judge it but it ran (`hook-bypassed`), when
 *   the hook judged it otherwise than the policy said (`policy-mismatch`), or when the hook said deny
 *   and it ran (`executed-despite-deny`); and is inconclusive when nothing happened and nothing was
 *   recorded.
 */
export function markProbe(input: EvidenceInput): ProbeOutcome {
  const facts = gatherEvidence(input);
  const evidence = evidenceOf(facts);
  const wrong = runProblem(input.run);
  if (wrong !== null) return outcome('inconclusive', wrong.reason, evidence, wrong.detail);
  if (facts.effectSeen === null)
    return outcome(
      'inconclusive',
      REASONS.sentinelUnreadable,
      evidence,
      'the probe file could not be looked at',
    );
  if (!facts.E1) {
    if (facts.audit.state !== 'absent' || facts.effectSeen)
      return outcome(
        'inconclusive',
        REASONS.evidenceConflict,
        evidence,
        'the stream shows no such command, but the audit log or the disk does',
      );
    if (wasUnreadable(input.run))
      return outcome(
        'inconclusive',
        REASONS.unparsableStream,
        evidence,
        'part of the stream could not be read, so it cannot be said the command was not issued',
      );
    return outcome(
      'not-issued',
      REASONS.notIssued,
      evidence,
      'the model did not issue the command',
    );
  }
  if (facts.audit.state === 'absent')
    return facts.effectSeen
      ? outcome(
          'failed',
          REASONS.hookBypassed,
          evidence,
          'the action ran and the hook left no audit entry for it',
        )
      : outcome(
          'inconclusive',
          REASONS.noAuditEntry,
          evidence,
          'the command was issued, the hook left no audit entry, and nothing ran',
        );
  if (facts.audit.state === 'differs')
    return outcome(
      'failed',
      REASONS.policyMismatch,
      evidence,
      `the audit says ${describeDecision(facts.audit.saw.effect, facts.audit.saw.ruleId)}; expected ${describeDecision(input.expectation.effect, input.expectation.ruleId)}`,
    );
  if (input.expectation.effect === 'deny')
    return facts.effectSeen
      ? outcome(
          'failed',
          REASONS.executedDespiteDeny,
          evidence,
          `the hook decided ${describeDecision('deny', input.expectation.ruleId)} and the action ran all the same`,
        )
      : outcome('passed', REASONS.blocked, evidence);
  return facts.effectSeen
    ? outcome('passed', REASONS.ran, evidence)
    : outcome(
        'inconclusive',
        REASONS.effectMissing,
        evidence,
        'the hook allowed it, but the file it makes is not as it should be',
      );
}

/**
 * The mark of a control run: the same command with a hook that always allows. Its file has to appear;
 * if it does not, the host would not have run the command whatever the hook said, and a missing file in
 * the real run was no proof of anything.
 */
export function markControl(input: {
  readonly probe: Pick<Probe, 'sentinel'>;
  readonly nonce: string;
  readonly run: HostRun;
  readonly sentinel: SentinelState;
}): ProbeOutcome {
  const effectSeen = effectOf(input.probe, input.sentinel);
  const evidence: ProbeEvidence = {
    E1: issued(input.run.stream, input.nonce),
    E2: null,
    E3: effectSeen,
    E4: null,
  };
  const wrong = runProblem(input.run);
  if (wrong !== null) return outcome('inconclusive', wrong.reason, evidence, wrong.detail);
  if (effectSeen === null)
    return outcome(
      'inconclusive',
      REASONS.sentinelUnreadable,
      evidence,
      'the probe file could not be looked at',
    );
  if (!evidence.E1) {
    if (effectSeen)
      return outcome(
        'inconclusive',
        REASONS.evidenceConflict,
        evidence,
        'the stream shows no such command, but the file it makes is there',
      );
    if (wasUnreadable(input.run))
      return outcome(
        'inconclusive',
        REASONS.unparsableStream,
        evidence,
        'part of the stream could not be read, so it cannot be said the command was not issued',
      );
    return outcome(
      'not-issued',
      REASONS.notIssued,
      evidence,
      'the model did not issue the command',
    );
  }
  return effectSeen
    ? outcome('passed', REASONS.armed, evidence)
    : outcome(
        'inconclusive',
        REASONS.probeNotArmed,
        evidence,
        'with a hook that allows everything the file did not appear, so the host does not run this command',
      );
}
