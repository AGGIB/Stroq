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
 * the agent; the agent cannot run them (`changesStroqState` in actions/self-config).
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
