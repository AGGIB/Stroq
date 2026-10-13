// What the hook's own audit log says of one request.
//
// The hook writes an entry for every call it judges, to a log in a home that belongs to this check, and
// that log is evidence the model does not write. It is read for one thing: whether the hook judged THIS
// command, once, and nothing besides it, and whether its decision was the one the policy was seen to give.
import type { AuditEntry } from '@stroq/core';
import { SHELL_TOOL, WITHHELD_SUMMARY, auditSummaryOf } from './command.js';
import type { SettledExpectation } from './types.js';

/**
 * What the hook's audit log says of this request.
 *
 * - `unread`: the log could not be read, or the entry for the call is the placeholder the hook writes
 *   when it cannot check a call for secrets; nothing can be said of what the hook made of the command;
 * - `empty`: the log is there and has nothing in it, so the hook never ran;
 * - `nonce-missing`: the log has entries and none of them is a judgement of this command;
 * - `extra`: this command was judged, and something else was too (another command, or this one twice);
 * - `agrees` / `differs`: the one entry for the command, and whether its decision is the one expected.
 */
export type AuditFinding =
  | { readonly state: 'unread'; readonly why: string }
  | { readonly state: 'empty' }
  | { readonly state: 'nonce-missing' }
  | { readonly state: 'extra' }
  | { readonly state: 'agrees' }
  | {
      readonly state: 'differs';
      readonly saw: { readonly effect: string; readonly ruleId: string | null };
    };

export interface AuditQuestion {
  readonly probe: { readonly command: string };
  /** The entries the hook wrote while the request was being made. */
  readonly audit: readonly AuditEntry[];
  /** Set when the log could not be read, in which case `audit` says nothing. */
  readonly auditProblem?: string | undefined;
  readonly expectation: SettledExpectation;
}

const isEntry = (value: unknown): value is AuditEntry =>
  typeof value === 'object' && value !== null;

/**
 * What the hook's audit log says of this request: one entry that is the hook's judgement of the command,
 * and nothing besides it. The entry's summary is the command as the log keeps it (`auditSummaryOf`), so
 * that the entry is the command and not merely something that mentions the nonce. More than the one entry
 * is not read as the hook having been right once: a command judged twice meets a session the first try has
 * tainted, and a hook asked about another command as well was asked about more than this probe.
 */
export function auditFinding(input: AuditQuestion): AuditFinding {
  if (input.auditProblem !== undefined) return { state: 'unread', why: input.auditProblem };
  const entries = input.audit.filter(isEntry);
  if (entries.length === 0) return { state: 'empty' };
  const wanted = auditSummaryOf(input.probe.command);
  const judged = entries.filter((e) => e.phase === 'pre');
  const ours = judged.filter((e) => e.tool === SHELL_TOOL && e.summary === wanted);
  if (ours.length === 0)
    return judged.some((e) => e.summary === WITHHELD_SUMMARY)
      ? { state: 'unread', why: 'the hook withheld the text of an entry' }
      : { state: 'nonce-missing' };
  const entry = ours[0];
  if (entry === undefined || ours.length > 1 || judged.length > 1) return { state: 'extra' };
  const saw = {
    effect: entry.decision?.effect ?? 'none',
    ruleId: entry.decision?.ruleId ?? null,
  };
  return saw.effect === input.expectation.effect && saw.ruleId === input.expectation.ruleId
    ? { state: 'agrees' }
    : { state: 'differs', saw };
}
