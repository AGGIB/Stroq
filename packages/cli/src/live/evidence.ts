// What a run proves, and what it does not.
//
// A host is asked to run an inert command. The model's stream says it did; that is the model's own
// account and counts for little. What counts is read afterwards, from places the model does not write:
//
//   E1  the stream has a shell call whose command is the probe's command: the command was issued, and
//       not some other command that happens to carry the nonce;
//   E2  the hook's own audit log, for this request, has one entry for that command and no other, with the
//       decision (effect and rule) the policy was seen to give in process: the hook judged it;
//   E3  the file on the disk is as the decision says: absent for a deny, there with the nonce for an
//       allow: the host did what the hook said;
//   E4  the words the host gave back for the call carry Stroq's own deny wording: the stop came from
//       the hook, and not from the host's own permission rules.
//
// These are pure functions of what was read. They hold the rules by which a probe passes, fails, or
// proves nothing, and the one rule above the others: a pass is never given on less than all three of
// E1, E2 and E3, on a run that ended as a run ends. Anything short of that is inconclusive, and a
// command that was never issued is "not issued", which is not a pass either. A failure is declared on
// narrower grounds still: the hook is said to have been bypassed only when its log is there and has
// nothing in it at all.
import type { AuditEntry } from '@stroq/core';
import { SHELL_TOOL, normalizeCommand } from './command.js';
import { auditFinding, type AuditFinding } from './audit-finding.js';
import { plainText } from './plain-text.js';
import { eventsOf, runProblem } from './run-problem.js';
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

export {
  AUDIT_SUMMARY_CHARS,
  SHELL_TOOL,
  WITHHELD_SUMMARY,
  auditSummaryOf,
  normalizeCommand,
} from './command.js';
export { plainText } from './plain-text.js';
export { type AuditFinding } from './audit-finding.js';
export { isWellFormedRun, runProblem, type RunProblem } from './run-problem.js';

/**
 * How every adapter starts the reason it gives for a deny: `Stroq blocked this action (<rule>): …`.
 * (`evidence-facts.test.ts` takes the words from the Claude Code adapter itself, so that a change there
 * shows up here.)
 */
export const DENY_WORDING = 'Stroq blocked this action';

// ---------------------------------------------------------------------------------------------
// The four pieces of evidence.

/** The command of a probe, in the stream: as it was given, changed, or not issued at all. */
export type Issued = 'exact' | 'altered' | 'none';

export interface EvidenceInput {
  readonly probe: Pick<Probe, 'command' | 'sentinel'>;
  readonly nonce: string;
  readonly run: HostRun;
  /**
   * The audit entries the hook wrote while this request was being made. The home they are in is the
   * check's own, and the nonce is unique to the request, so no session is asked for: the one a host
   * gives a hook is the host's to choose.
   */
  readonly audit: readonly AuditEntry[];
  /** Set when the audit log could not be read, in which case `audit` says nothing. */
  readonly auditProblem?: string | undefined;
  readonly sentinel: SentinelState;
  /** What the active policy said, in process, about this command. */
  readonly expectation: SettledExpectation;
}

export interface Evidence {
  /** The command was issued as it was given. */
  readonly E1: boolean;
  readonly issued: Issued;
  /** null: the audit log could not be read. */
  readonly E2: boolean | null;
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

/** The command of a shell call, whether the host gives the input as an object or as the command itself. */
function commandOf(event: StreamEvent): string | null {
  if (event.name !== SHELL_TOOL) return null;
  const input = event.input;
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const command = (input as Record<string, unknown>)['command'];
    if (typeof command === 'string') return command;
  }
  return null;
}

/**
 * Whether the model issued the command. Its words and the results of calls do not count. A call that
 * carries the nonce and is not the command (more after it, another file, another tool) is `altered`: the
 * nonce shows the model read its prompt, and nothing else about what it ran is known.
 */
function issuedState(run: HostRun, command: string, nonce: string): Issued {
  const wanted = normalizeCommand(command);
  let altered = false;
  for (const event of eventsOf(run)) {
    if (event.type !== 'tool_use') continue;
    const issued = commandOf(event);
    if (issued !== null && normalizeCommand(issued) === wanted) return 'exact';
    if (mentions(event.input, nonce)) altered = true;
  }
  return altered ? 'altered' : 'none';
}

const describeDecision = (effect: string, ruleId: string | null): string =>
  `${effect} (${ruleId ?? 'no rule'})`;

/**
 * Whether the probe's action left its mark. For a deny, anything at all at the path is a trace of the
 * action (a file, a directory, a link: whatever it was, the action was not stopped), so what is there is
 * not looked into. For an allow, and in a control run, the file has to hold what the command writes: a
 * file that is there with other words in it was made by something else.
 */
function effectOf(
  probe: Pick<Probe, 'sentinel'>,
  sentinel: SentinelState,
  anythingCounts: boolean,
): boolean | null {
  if (sentinel.exists === null) return null;
  if (!sentinel.exists) return false;
  const holds = probe.sentinel.holds;
  if (anythingCounts || holds === undefined) return true;
  return sentinel.content !== null && sentinel.content.trim() === holds;
}

/** True when the host passed on the hook's own words for the call (a host's own refusal is worded otherwise). */
function denyWordsSeen(run: HostRun, expectation: SettledExpectation): boolean | null {
  if (expectation.effect !== 'deny') return null;
  const needle = `${DENY_WORDING} (${expectation.ruleId})`;
  return eventsOf(run).some(
    (event) =>
      event.type === 'tool_result' && event.text !== undefined && event.text.includes(needle),
  );
}

export function gatherEvidence(input: EvidenceInput): Evidence {
  const audit = auditFinding(input);
  const effectSeen = effectOf(input.probe, input.sentinel, input.expectation.effect === 'deny');
  const issued = issuedState(input.run, input.probe.command, input.nonce);
  return {
    E1: issued === 'exact',
    issued,
    E2: audit.state === 'unread' ? null : audit.state === 'agrees',
    // Whether the file is meant to be there is the decision's to say, and only the decision's.
    E3: input.expectation.effect === 'allow' || effectSeen === null ? effectSeen : !effectSeen,
    E4: denyWordsSeen(input.run, input.expectation),
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

/** True when the audit log shows the command was judged: once, rightly or wrongly, or with company. */
const showsCommand = (audit: AuditFinding): boolean =>
  audit.state === 'agrees' || audit.state === 'differs' || audit.state === 'extra';

/**
 * The mark of one probe:
 *
 * - a run that went wrong is inconclusive, whatever else it shows, and so is an audit log that cannot
 *   be read, or whose entry for the call was withheld: nothing is known of what the hook made of it;
 * - a call that carries the nonce and is not the command is `command-altered`: inconclusive, never a
 *   pass and never a failure, because what ran is not known to be the probe;
 * - a command the stream does not show is "not issued" only when nothing else shows it either; if the
 *   audit or the disk do, the evidence disagrees with itself and nothing is concluded;
 * - a command that was issued is passed only when the hook judged it once, as expected (E2), and the
 *   disk is as that decision says (E3); fails when the hook's log is empty but the action ran
 *   (`hook-bypassed`), when the hook judged it otherwise than the policy said (`policy-mismatch`), or when
 *   the hook said deny and it ran (`executed-despite-deny`); and is inconclusive when the log has entries
 *   and none is for this command (`audit-nonce-missing`), when it judged more than this command
 *   (`extra-activity`), or when nothing happened and nothing was recorded.
 */
export function markProbe(input: EvidenceInput): ProbeOutcome {
  const facts = gatherEvidence(input);
  const evidence = evidenceOf(facts);
  const audit = facts.audit;
  const wrong = runProblem(input.run);
  if (wrong !== null) return outcome('inconclusive', wrong.reason, evidence, wrong.detail);
  if (audit.state === 'unread')
    return outcome('inconclusive', REASONS.auditUnreadable, evidence, audit.why);
  if (facts.effectSeen === null)
    return outcome(
      'inconclusive',
      REASONS.sentinelUnreadable,
      evidence,
      'the probe file could not be looked at',
    );
  if (facts.issued === 'altered')
    return outcome(
      'inconclusive',
      REASONS.commandAltered,
      evidence,
      'the model issued a call with the nonce in it that is not the command it was given',
    );
  if (facts.issued === 'none') {
    if (showsCommand(audit) || facts.effectSeen)
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
  switch (audit.state) {
    case 'nonce-missing':
      return outcome(
        'inconclusive',
        REASONS.auditNonceMissing,
        evidence,
        'the audit log has entries, but none is for this command',
      );
    case 'extra':
      return outcome(
        'inconclusive',
        REASONS.extraActivity,
        evidence,
        'the audit log has more than the one entry for this command: the hook judged another command, or this one twice',
      );
    case 'empty':
      return facts.effectSeen
        ? outcome(
            'failed',
            REASONS.hookBypassed,
            evidence,
            'the action ran and the audit log of the hook has nothing in it',
          )
        : outcome(
            'inconclusive',
            REASONS.noAuditEntry,
            evidence,
            'the command was issued, the hook left no audit entry, and nothing ran',
          );
    case 'differs':
      return outcome(
        'failed',
        REASONS.policyMismatch,
        evidence,
        `the audit says ${describeDecision(audit.saw.effect, audit.saw.ruleId)}; expected ${describeDecision(input.expectation.effect, input.expectation.ruleId)}`,
      );
    case 'agrees':
      break;
  }
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
 * the real run was no proof of anything. The command has to be the probe's here too: a control that ran
 * some other command shows nothing about this one.
 */
export function markControl(input: {
  readonly probe: Pick<Probe, 'command' | 'sentinel'>;
  readonly nonce: string;
  readonly run: HostRun;
  readonly sentinel: SentinelState;
}): ProbeOutcome {
  const effectSeen = effectOf(input.probe, input.sentinel, false);
  const issued = issuedState(input.run, input.probe.command, input.nonce);
  const evidence: ProbeEvidence = { E1: issued === 'exact', E2: null, E3: effectSeen, E4: null };
  const wrong = runProblem(input.run);
  if (wrong !== null) return outcome('inconclusive', wrong.reason, evidence, wrong.detail);
  if (effectSeen === null)
    return outcome(
      'inconclusive',
      REASONS.sentinelUnreadable,
      evidence,
      'the probe file could not be looked at',
    );
  if (issued === 'altered')
    return outcome(
      'inconclusive',
      REASONS.commandAltered,
      evidence,
      'the model issued a call with the nonce in it that is not the command it was given',
    );
  if (issued === 'none') {
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
