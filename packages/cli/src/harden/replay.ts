import { deepEqual } from './json-doc.js';
import { replayJsonPlan } from './json-edit.js';
import { replayTextBlockPlan } from './textblock.js';
import { HardenError, type JsonValue, type Plan } from './types.js';

/**
 * Checking that a plan is what it says it is.
 *
 * A plan is plain data: it can be written to a file, read back, passed between processes, and
 * made by anything. What it carries (the text after, the diff a person looked at, the record of
 * what undo should take out) is only worth trusting if it is what a planner would have made of
 * the text before and the edits. So the planner is run again, on the plan's own text and edits,
 * with nothing read and nothing written, and the plan is accepted only if the answer is the same.
 */

/** Recorded edits as plain JSON, so that two lists of them can be compared by value. */
const asJson = (edits: Plan['edits']): JsonValue => JSON.parse(JSON.stringify(edits)) as JsonValue;

/**
 * Throws a `HardenError` unless `plan` is exactly what its edits make of its text; returns whether
 * writing it would lay the file out again. The caller has already dealt with a plan that was
 * refused or changes nothing.
 *
 * - `lossy-json`: the text cannot be written back without losing something, whatever the plan says.
 * - `plan-inconsistent`: anything else that does not add up.
 */
export function verifyPlan(plan: Plan): { readonly reformats: boolean } {
  const truth = plan.kind === 'json' ? replayJsonPlan(plan) : replayTextBlockPlan(plan);
  if (truth === null) {
    throw new HardenError(
      'plan-inconsistent',
      'this plan does not hold the one edit that a plan for a block of lines holds',
    );
  }
  if (truth.refused === 'lossy-json') {
    throw new HardenError(
      'lossy-json',
      `this plan cannot be applied: ${truth.refusedDetail ?? 'the file would lose something'}`,
    );
  }
  if (truth.refused !== undefined) {
    throw new HardenError(
      'plan-inconsistent',
      `the text in this plan cannot be edited the way its edits say: ${truth.refusedDetail ?? truth.refused}`,
    );
  }
  const same =
    truth.after === plan.after &&
    truth.changed === plan.changed &&
    truth.diff === plan.diff &&
    deepEqual(asJson(truth.edits), asJson(plan.edits));
  if (!same) {
    throw new HardenError(
      'plan-inconsistent',
      'the text after, the diff or the edits of this plan are not what its edits make of its text before; make a new plan',
    );
  }
  return { reformats: truth.kind === 'json' && truth.formatting === 'will-change' };
}
