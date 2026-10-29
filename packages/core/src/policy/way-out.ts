import { ageLabel } from '../provenance/describe.js';
import type { ActionClass, Decision, Taint } from '../types.js';
import { neutralizeControls } from '../util/controls.js';
import { shellQuote } from '../util/shell-quote.js';
import type { Policy } from './policy-types.js';

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
 *
 * A tainted session is not sent to `stroq untaint`: it clears the taint and every flagged
 * record along with the note, which is far more than one unrecorded package is worth. There
 * the user is left with approving the call.
 *
 * `why` says what the doubt is: records that were lost (the default), or a command that is
 * longer than Stroq reads, whose unread part it cannot match against what the session read.
 */
/** What Stroq cannot rule out about a call, and so asks about. */
export type DoubtCause =
  'lost-records' | 'unscanned-result' | 'flagged-own-text' | 'unread-command' | 'doubtful-name';

const DOUBT_SENTENCE: Readonly<Record<DoubtCause, string>> = {
  'lost-records':
    "Stroq's provenance for this session is incomplete (some of what it read is no longer on record), so it cannot rule out that this came from content the agent read.",
  'unscanned-result':
    'A tool result in this session could not be scanned (the hook that reads it did not finish), so Stroq cannot rule out that it holds instructions for this call.',
  'flagged-own-text':
    'Earlier in this session Stroq flagged text in your files or in a command output, and this call reads secrets and sends something out, so it cannot rule out that the flagged text asked for it.',
  'unread-command':
    'This command is longer than Stroq reads, so it cannot rule out that the part it did not read names something the agent read.',
  'doubtful-name':
    'The package name in this command uses a shell expansion, a glob or a quote, so Stroq cannot tell which package it is.',
};

/** The causes that are about the session, which clearing it ends. */
const CLEARED_BY_UNTAINT: ReadonlySet<DoubtCause> = new Set([
  'lost-records',
  'unscanned-result',
  'flagged-own-text',
]);

export function withIncompleteNote(
  decision: Decision,
  policy: Policy,
  sessionId: string,
  tainted: boolean,
  why: DoubtCause = 'lost-records',
): Decision {
  if (decision.effect === 'allow' || decision.ruleId === null) return decision;
  const rule = policy.rules.find((r) => r.id === decision.ruleId);
  if (rule === undefined || !rule.when.classes.includes('origin.untrusted' satisfies ActionClass))
    return decision;
  // The rule's own reason says the action was copied; after a flag on the own text nothing was, so
  // that question is put in its own words only.
  const incomplete =
    why === 'flagged-own-text'
      ? `${DOUBT_SENTENCE[why].replace(/\.$/, '')}; confirm.`
      : `${decision.reason.replace(/\.$/, '')}. ${DOUBT_SENTENCE[why]}`;
  // `stroq untaint` wipes the whole trace of the session: it is the way out of a doubt about the
  // session, and not of one about this one call, for which approving it is the right size.
  const wayOut =
    tainted || !CLEARED_BY_UNTAINT.has(why)
      ? 'If this is the call you wanted, approve it.'
      : `If that is a false alarm, clear it yourself, outside the agent: stroq untaint --session ${shellQuote(sessionId)}`;
  return { ...decision, reason: `${incomplete} ${wayOut}` };
}
