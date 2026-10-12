import { readTargetText } from '../harden/atomic.js';
import { planJsonEdits, replacesCredential } from '../harden/json-edit.js';
import { linkTarget } from '../harden/plan-support.js';
import { planTextBlock } from '../harden/textblock.js';
import type { BackupPlan, Plan, PlanOptions, PlanRefusal } from '../harden/types.js';
import type { HardenAgent, HardenScope, RecipeTarget } from '../harden/recipes/index.js';
import { outside, outsideLine } from '../ui/layout.js';

/**
 * A plan as it is shown: made from the engine's plan, and from nothing else of the file.
 *
 * A plan holds the raw text of the file before and after (`Plan.before` and `Plan.after`), which can be
 * a token, and the engine says in so many words never to print or serialize a whole plan. So the
 * command builds this object field by field, from the diff the engine masked and the notices it wrote,
 * and everything that came from a file or from the engine passes through the safe-output helpers on the
 * way in. What the text rendering prints and what `--json` prints are both this object.
 */

export type ItemStatus = 'add' | 'present' | 'unknown';

export interface PlanItem {
  readonly text: string;
  readonly status: ItemStatus;
}

/** What the owner has to say yes to, in flags, before the change can be made. */
export interface Needs {
  readonly acknowledgeLink: boolean;
  readonly acknowledgeCredentialLoss: boolean;
  readonly acknowledgeReformat: boolean;
}

export interface PlanRefusalView {
  readonly reason: PlanRefusal;
  readonly detail: string;
  /** The lines to add by hand, for a file the engine will not rewrite; else `null`. */
  readonly snippet: string | null;
}

export interface PlanView {
  readonly recipe: string;
  readonly agent: HardenAgent;
  readonly scope: HardenScope;
  readonly summary: string;
  readonly file: string;
  readonly real: string;
  readonly exists: boolean;
  readonly changed: boolean;
  readonly refused: PlanRefusalView | null;
  readonly items: readonly PlanItem[];
  readonly diff: string;
  readonly diffWithheld: boolean;
  readonly backup: BackupPlan;
  readonly notices: readonly string[];
  readonly limits: readonly string[];
  readonly unverified: string | null;
  readonly needs: Needs;
}

const NOTHING_NEEDED: Needs = {
  acknowledgeLink: false,
  acknowledgeCredentialLoss: false,
  acknowledgeReformat: false,
};

/** Refusals after which the owner can still do the change by hand, with the lines the recipe gives. */
const CAN_BE_DONE_BY_HAND: readonly PlanRefusal[] = ['jsonc', 'lossy-json'];

/** The engine's plan for what the recipe wants. It reads the file, with its real path, and writes nothing. */
export function makePlan(target: RecipeTarget, acknowledgeLink: boolean): Plan {
  const options: PlanOptions = {
    read: readTargetText,
    recipe: target.recipe,
    root: target.root,
    newFileMode: target.newFileMode,
    acknowledgeLink,
  };
  return target.change.kind === 'json'
    ? planJsonEdits(target.file, target.change.edits, options)
    : planTextBlock(target.file, { id: target.change.id, lines: target.change.lines }, options);
}

/** The flags the change cannot be made without. A refused plan or one that changes nothing needs none. */
export function needsOf(plan: Plan): Needs {
  if (plan.refused !== undefined || !plan.changed) return NOTHING_NEEDED;
  return {
    acknowledgeLink: linkTarget(plan.file, plan.real, plan.root) !== null,
    acknowledgeCredentialLoss: plan.kind === 'json' && replacesCredential(plan.edits),
    acknowledgeReformat: plan.kind === 'json' && plan.formatting === 'will-change',
  };
}

/** The values of the rules the file already has: the owner's, which a plan does not add. */
function alreadyThere(plan: Plan): ReadonlySet<string> {
  if (plan.kind === 'text-block')
    return new Set(plan.changed ? [] : plan.edits.flatMap((e) => e.lines));
  const kept = plan.edits.flatMap((edit) =>
    edit.kind === 'json-array-add' && edit.preexisting && typeof edit.value === 'string'
      ? [edit.value]
      : [],
  );
  return new Set(kept);
}

function itemsOf(target: RecipeTarget, plan: Plan): readonly PlanItem[] {
  if (plan.refused !== undefined) {
    return target.items.map((text) => ({ text, status: 'unknown' as const }));
  }
  const there = alreadyThere(plan);
  return target.items.map((text) => ({
    text,
    status: there.has(text) ? ('present' as const) : ('add' as const),
  }));
}

function refusalOf(target: RecipeTarget, plan: Plan): PlanRefusalView | null {
  if (plan.refused === undefined) return null;
  const byHand = CAN_BE_DONE_BY_HAND.includes(plan.refused) && target.change.kind === 'json';
  return {
    reason: plan.refused,
    detail: outsideLine(plan.refusedDetail ?? plan.refused),
    snippet: byHand && target.change.kind === 'json' ? target.change.snippet : null,
  };
}

export function viewOf(target: RecipeTarget, plan: Plan): PlanView {
  return {
    recipe: target.recipe,
    agent: target.agent,
    scope: target.scope,
    summary: target.summary,
    file: outsideLine(target.file),
    real: outsideLine(plan.real),
    exists: plan.existed,
    changed: plan.changed,
    refused: refusalOf(target, plan),
    items: itemsOf(target, plan),
    diff: outside(plan.diff),
    diffWithheld: plan.previewWithheld === true,
    backup: plan.backup,
    notices: plan.notices.map(outsideLine),
    limits: target.limits,
    unverified: target.unverified,
    needs: needsOf(plan),
  };
}
