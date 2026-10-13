import type { Plan } from '../harden/types.js';
import type { HardenScope, Recipe, RecipeTarget } from '../harden/recipes/index.js';
import type { HardenFlags } from './harden-flags.js';
import type { HardenContext } from './harden-deps.js';
import { makePlan, viewOf, type PlanView } from './harden-view.js';
import { commandFor, flagsFor, renderPlan } from './harden-render.js';
import type { Outcome, Printer } from './harden-printer.js';

/**
 * `stroq harden` / `stroq harden plan`: what the recipe would change, shown, and nothing written. The
 * part that works the plan out is shared with `apply`, which shows the same plan before it asks.
 */

export interface Prepared {
  readonly target: RecipeTarget;
  readonly plan: Plan;
  readonly view: PlanView;
}

/** Reads the file the recipe names (with its real path, after the path has been judged) and plans. */
export function prepare(
  ctx: HardenContext,
  recipe: Recipe,
  scope: HardenScope,
  acknowledgeLink: boolean,
): Prepared {
  const target = recipe.target({
    cwd: ctx.cwd,
    home: ctx.home,
    scope,
    claudeConfigDir: ctx.claudeConfigDir,
  });
  const plan = makePlan(target, acknowledgeLink);
  return { target, plan, view: viewOf(target, plan) };
}

export interface Verdict {
  readonly code: number;
  readonly outcome: Outcome;
}

const ACKNOWLEDGE_LINK = '--acknowledge-link';

/** What the plan comes to when nothing is to be done about it: refused, nothing to change, or the plan. */
export function planVerdict(view: PlanView, target: RecipeTarget): Verdict {
  if (view.refused !== null) {
    const message = `nothing was written: ${view.refused.detail}`;
    return { code: 1, outcome: { status: 'refused', message } };
  }
  if (!view.changed) {
    return { code: 0, outcome: { status: 'nothing-to-do', message: target.words.alreadyDone } };
  }
  if (view.diffWithheld) {
    return {
      code: 3,
      outcome: {
        status: 'needs-acknowledgement',
        message: `nothing was written, and the change is not shown: the path is a link; add ${ACKNOWLEDGE_LINK} to see it`,
        details: { missing: [ACKNOWLEDGE_LINK] },
      },
    };
  }
  const command = commandFor(view, 'apply', flagsFor(view.needs));
  return {
    code: 0,
    outcome: { status: 'planned', message: `Nothing was written. To apply it: ${command}` },
  };
}

export function planCommand(
  ctx: HardenContext,
  recipe: Recipe,
  scope: HardenScope,
  flags: HardenFlags,
  printer: Printer,
): number {
  const { target, view } = prepare(ctx, recipe, scope, flags.acknowledgeLink);
  printer.show(renderPlan(view, target));
  const { code, outcome } = planVerdict(view, target);
  return printer.finish(code, outcome, view);
}
