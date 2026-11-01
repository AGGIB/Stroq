import type { Plan } from '../harden/types.js';
import type { HardenScope, Recipe, RecipeTarget } from '../harden/recipes/index.js';
import type { HardenContext } from './harden-deps.js';
import { makePlan, viewOf, type PlanView } from './harden-view.js';

/**
 * What a credential-file recipe would change, worked out and not written. The local console reads
 * the plan through `prepare`; the command that printed it (`stroq harden`) was removed in 0.30.
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
