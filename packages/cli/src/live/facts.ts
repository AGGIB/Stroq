// What one request shows, read off the places the model does not write.
//
// E1 the stream has a shell call whose command is the probe's command: the command was issued, and not
//    some other command that happens to carry the nonce;
// E2 the hook's own audit log, for this request, has one entry for that command and no other, with the
//    decision (effect and rule) the policy was seen to give in process: the hook judged it;
// E3 the file on the disk is as the decision says: absent for a deny, there with the nonce for an allow:
//    the host did what the hook said;
// E4 the words the host gave back for the call carry Stroq's own deny wording: the stop came from the
//    hook, and not from the host's own permission rules.
//
// These are pure functions of what was read. What is made of them, which mark a probe gets, is `marks.ts`.
import type { AuditEntry } from '@stroq/core';
import { auditFinding, type AuditFinding } from './audit-finding.js';
import { SHELL_TOOL, normalizeCommand } from './command.js';
import { eventsOf } from './run-problem.js';
import type { HostRun, Probe, SentinelState, SettledExpectation, StreamEvent } from './types.js';

/**
 * How every adapter starts the reason it gives for a deny: `Stroq blocked this action (<rule>): …`.
 * (`evidence-facts.test.ts` takes the words from the Claude Code adapter itself, so that a change there
 * shows up here.)
 */
export const DENY_WORDING = 'Stroq blocked this action';

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

/** What the stream and the disk show of a request, with or without a hook to ask. */
export interface CallFacts {
  /** The command was issued as it was given. */
  readonly E1: boolean;
  readonly issued: Issued;
  /** How many calls the stream holds, by any tool. The command is one of them or it is not issued. */
  readonly calls: number;
  /**
   * The probe's action left its mark. What the sentinel says, whichever way the decision went: for a
   * deny it is the failure to look for, for an allow it is the thing that was asked for.
   */
  readonly effectSeen: boolean | null;
}

export interface Evidence extends CallFacts {
  /** null: the audit log could not be read. */
  readonly E2: boolean | null;
  readonly E3: boolean | null;
  readonly E4: boolean | null;
  readonly audit: AuditFinding;
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

/** Every call the stream holds, by whatever tool. */
export const callsOf = (run: HostRun): readonly StreamEvent[] =>
  eventsOf(run).filter((event) => event.type === 'tool_use');

/**
 * Whether the model issued the command. Its words and the results of calls do not count. A call that
 * carries the nonce and is not the command (more after it, another file, another tool) is `altered`: the
 * nonce shows the model read its prompt, and nothing else about what it ran is known.
 */
function issuedState(calls: readonly StreamEvent[], command: string, nonce: string): Issued {
  const wanted = normalizeCommand(command);
  let altered = false;
  for (const call of calls) {
    const issued = commandOf(call);
    if (issued !== null && normalizeCommand(issued) === wanted) return 'exact';
    if (mentions(call.input, nonce)) altered = true;
  }
  return altered ? 'altered' : 'none';
}

/**
 * Whether the probe's action left its mark. For a deny, anything at all at the path is a trace of the
 * action (a file, a directory, a link: whatever it was, the action was not stopped), so what is there is
 * not looked into. For an allow, and in a control run, the file has to hold what the command writes: a
 * file that is there with other words in it was made by something else.
 */
export function effectOf(
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

/** What the stream and the disk show of a request; the part of the evidence a control run has too. */
export function gatherCallFacts(input: {
  readonly probe: Pick<Probe, 'command' | 'sentinel'>;
  readonly nonce: string;
  readonly run: HostRun;
  readonly sentinel: SentinelState;
  readonly anythingCounts: boolean;
}): CallFacts {
  const calls = callsOf(input.run);
  const issued = issuedState(calls, input.probe.command, input.nonce);
  return {
    E1: issued === 'exact',
    issued,
    calls: calls.length,
    effectSeen: effectOf(input.probe, input.sentinel, input.anythingCounts),
  };
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
  const facts = gatherCallFacts({
    ...input,
    anythingCounts: input.expectation.effect === 'deny',
  });
  return {
    ...facts,
    E2: audit.state === 'unread' ? null : audit.state === 'agrees',
    // Whether the file is meant to be there is the decision's to say, and only the decision's.
    E3:
      input.expectation.effect === 'allow' || facts.effectSeen === null
        ? facts.effectSeen
        : !facts.effectSeen,
    E4: denyWordsSeen(input.run, input.expectation),
    audit,
  };
}
