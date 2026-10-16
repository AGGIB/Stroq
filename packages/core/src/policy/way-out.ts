import { ageLabel } from '../provenance/describe.js';
import type { ActionClass, Decision, Taint } from '../types.js';
import { neutralizeControls } from '../util/controls.js';
import type { Policy } from './policy-types.js';

/** Characters a POSIX shell reads as text; anything else makes the word need quoting. */
const SAFE_WORD = /^[\w@%+=:,./-]+$/;
const shellQuote = (word: string): string =>
  SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * A deny or ask that the session's taint caused, with the way out of a false positive
 * written into its reason: what tainted the session, and the exact commands that
 * clear it — with the real session id, not `<id>`. Without them a false positive took
 * a trip through `stroq why` to find the id, and the reason named no source at all.
 *
 * Only decisions the taint had a part in get it: a rule whose `taint` is `suspect`,
 * or one that fires on `origin.suspect`. The commands are the user's to run, outside
 * the agent; the agent cannot run them (`stroqStateSignals` in actions/stroq-state).
 * `trust` is offered for a file read only, the one kind of source it waives.
 */
export function withWayOut(
  decision: Decision,
  policy: Policy,
  taint: Taint | null,
  sessionId: string,
  now: Date,
): Decision {
  if (decision.effect === 'allow' || decision.ruleId === null) return decision;
  const rule = policy.rules.find((r) => r.id === decision.ruleId);
  if (rule === undefined) return decision;
  const byTaint = rule.when.taint === 'suspect' && taint !== null;
  const byOrigin = rule.when.classes.includes('origin.suspect' satisfies ActionClass);
  if (!byTaint && !byOrigin) return decision;
  const source = byTaint ? taint.sources.at(-1) : undefined;
  const path = source?.source === undefined ? '' : neutralizeControls(source.source);
  const what =
    source === undefined
      ? ''
      : ` Tainted by ${source.tool}${path === '' ? '' : ` ${path}`} ${ageLabel(source.at, now)} ago.`;
  const trust =
    source?.tool === 'Read' && path !== ''
      ? `; to stop that file tainting it again: stroq trust ${shellQuote(path)}`
      : '';
  return {
    ...decision,
    reason: `${decision.reason.replace(/\.$/, '')}.${what} If that was a false positive, clear it yourself, outside the agent: stroq untaint --session ${shellQuote(sessionId)}${trust}`,
  };
}

/**
 * A decision that rests only on provenance being incomplete, with that said in its reason.
 *
 * Without it the reason is the policy rule's own ("copied from content the agent read"),
 * which is not what Stroq knows: it has no record that this was read, only a session that
 * lost some. So the reason says that, and the exact command that starts the session over
 * with its real id, for the same reason `withWayOut` names one.
 *
 * Applied only when the rule that decided fires on `origin.untrusted`: a call denied or
 * asked for another reason keeps that reason, whatever else is true of the session.
 */
export function withIncompleteNote(
  decision: Decision,
  policy: Policy,
  sessionId: string,
): Decision {
  if (decision.effect === 'allow' || decision.ruleId === null) return decision;
  const rule = policy.rules.find((r) => r.id === decision.ruleId);
  if (rule === undefined || !rule.when.classes.includes('origin.untrusted' satisfies ActionClass))
    return decision;
  return {
    ...decision,
    reason: `${decision.reason.replace(/\.$/, '')}. Stroq's provenance for this session is incomplete (some of what it read is no longer on record), so it cannot rule out that this came from content the agent read. If that is a false alarm, clear it yourself, outside the agent: stroq untaint --session ${shellQuote(sessionId)}`,
  };
}
