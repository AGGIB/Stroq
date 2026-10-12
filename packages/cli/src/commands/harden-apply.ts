import { applyPlan, undoFile } from '../harden/index.js';
import type { ApplyOptions } from '../harden/index.js';
import type { BackupPlan, Plan } from '../harden/types.js';
import type { HardenScope, Recipe, RecipeTarget } from '../harden/recipes/index.js';
import { askPerson, notAsked } from './harden-ask.js';
import type { HardenContext } from './harden-deps.js';
import { failureOf } from './harden-errors.js';
import type { HardenFlags } from './harden-flags.js';
import { planVerdict, type Verdict } from './harden-plan.js';
import type { Printer } from './harden-printer.js';
import { commandFor, renderPlan } from './harden-render.js';
import { makePlan, viewOf, type Needs, type PlanView } from './harden-view.js';

/**
 * `stroq harden apply`: shows the plan, asks a person, makes the change, and checks that the file holds it.
 *
 * Nothing is written until a person has said yes. On a terminal they are asked, once the plan has been
 * shown; where there is none (a pipe, a script, CI) `--yes` stands for the answer, and without it nothing
 * is done. The same plan is shown either way. An acknowledgement the plan needs (a link, a credential that
 * will be replaced, a file laid out again) is asked for as a flag and is checked before the question, so
 * that nobody is asked about a change that would be refused after they said yes.
 *
 * When the change has been made it is checked: a fresh plan of the same recipe must find nothing left to
 * do. If it does, something else changed the file in between, and Stroq takes its own change back.
 */

const QUESTION = 'Apply this change?';

/** Why each acknowledgement is asked for, in the words of the refusal that names its flag. */
const WHY: Readonly<Record<keyof Needs, readonly [flag: string, why: string]>> = {
  acknowledgeLink: [
    '--acknowledge-link',
    'the path is a link, and the change lands in the file it leads to',
  ],
  acknowledgeCredentialLoss: [
    '--acknowledge-credential-loss',
    'the change replaces a value that looks like a credential, and no copy of it is kept, so undo cannot put it back',
  ],
  acknowledgeReformat: [
    '--acknowledge-reformat',
    'the change lays the whole file out again, not only the lines it adds',
  ],
};

const BACKUP_LINES: Readonly<Record<BackupPlan, string>> = {
  copy: 'A byte copy of the file as it was is kept; undo puts it back exactly.',
  'none-new-file': 'The file did not exist; undo removes it.',
  'none-credential-text':
    'No copy of the file is kept, because it holds credential-shaped text; undo takes out only what Stroq added.',
  'none-unchecked':
    'No copy of the file is kept, because it is too large to check for credential-shaped text; undo takes out only what Stroq added.',
};

/** The acknowledgements the plan needs and the command line did not give. */
function missingFor(needs: Needs, flags: HardenFlags): readonly (keyof Needs)[] {
  // `Needs` and the flags that answer it have the same three names.
  return (Object.keys(WHY) as (keyof Needs)[]).filter((name) => needs[name] && !flags[name]);
}

function missingVerdict(missing: readonly (keyof Needs)[]): Verdict {
  const flags = missing.map((name) => WHY[name][0]);
  const reasons = missing.map((name) => WHY[name][1]);
  return {
    code: 3,
    outcome: {
      status: 'needs-acknowledgement',
      message: `nothing was written; to go on, add ${flags.join(' and ')}: ${reasons.join('; ')}`,
      details: { missing: flags },
    },
  };
}

/** What stops the apply before anyone is asked: a refusal, nothing to do, or a flag that is missing. */
function stoppedBeforeAsking(
  view: PlanView,
  target: RecipeTarget,
  flags: HardenFlags,
): Verdict | null {
  const verdict = planVerdict(view, target);
  if (verdict.outcome.status === 'refused' || verdict.outcome.status === 'nothing-to-do') {
    return verdict;
  }
  const missing = missingFor(view.needs, flags);
  return missing.length === 0 ? null : missingVerdict(missing);
}

/** Whether the file now holds what the recipe wants: a new plan of it finds nothing left to do. */
function holdsTheChange(target: RecipeTarget): boolean {
  try {
    const again = makePlan(target, true);
    return again.refused === undefined && !again.changed;
  } catch {
    // A file that cannot be read back is not one that holds the change.
    return false;
  }
}

function appliedMessage(view: PlanView, target: RecipeTarget, plan: Plan): string {
  const added = view.items.filter((item) => item.status === 'add').length;
  const kept = view.items.length - added;
  const there = kept === 1 ? 'it is' : 'they are';
  const counts =
    kept === 0 ? `${added} added.` : `${added} added, ${kept} already there and left as ${there}.`;
  return [
    `Applied to ${view.file}: ${counts}`,
    BACKUP_LINES[plan.backup],
    target.words.done,
    ...(target.unverified === null ? [] : [`Not verified: ${target.unverified}`]),
    `To take it back: ${commandFor(view, 'undo')}`,
  ].join('\n');
}

function acknowledgements(flags: HardenFlags): ApplyOptions {
  return {
    acknowledgeLink: flags.acknowledgeLink,
    acknowledgeCredentialLoss: flags.acknowledgeCredentialLoss,
    acknowledgeReformat: flags.acknowledgeReformat,
  };
}

/** The change did not stick: take back what Stroq recorded, and say what was left. */
async function takeBack(ctx: HardenContext, target: RecipeTarget): Promise<Verdict> {
  const why = 'after writing, the file does not hold the change (something else changed it)';
  try {
    await undoFile(ctx.env, target.file, { root: target.root });
    return {
      code: 1,
      outcome: {
        status: 'failed',
        message: `${why}; Stroq took its record back and left the file as it is now`,
      },
    };
  } catch (err) {
    const { message } = failureOf(err).outcome;
    const next = commandFor({ agent: target.agent, scope: target.scope }, 'undo');
    return {
      code: 1,
      outcome: {
        status: 'failed',
        message: `${why}, and Stroq could not take its record back (${message}); look at the file, then run ${next}`,
      },
    };
  }
}

async function perform(
  ctx: HardenContext,
  target: RecipeTarget,
  plan: Plan,
  view: PlanView,
  flags: HardenFlags,
  printer: Printer,
): Promise<number> {
  const result = await applyPlan(plan, ctx.env, acknowledgements(flags));
  if (!holdsTheChange(target)) {
    const { code, outcome } = await takeBack(ctx, target);
    return printer.finish(code, outcome, view);
  }
  const undo = commandFor(view, 'undo');
  return printer.finish(
    0,
    {
      status: 'applied',
      message: appliedMessage(view, target, plan),
      details: { backup: plan.backup, backupId: result.backup?.id ?? null, undo },
    },
    view,
  );
}

/** Applies what `target` asks for: plan, show, ask, make, check. Returns the exit code. */
export async function applyTarget(
  ctx: HardenContext,
  target: RecipeTarget,
  flags: HardenFlags,
  printer: Printer,
): Promise<number> {
  const plan = makePlan(target, flags.acknowledgeLink);
  const view = viewOf(target, plan);
  printer.show(renderPlan(view, target));
  const stopped = stoppedBeforeAsking(view, target, flags);
  if (stopped !== null) return printer.finish(stopped.code, stopped.outcome, view);
  const answer = await askPerson(ctx, flags, QUESTION);
  if (answer !== 'yes') {
    const status = answer === 'no' ? 'declined' : 'refused';
    return printer.finish(1, { status, message: notAsked(answer, 'apply') }, view);
  }
  return perform(ctx, target, plan, view, flags, printer);
}

export function applyCommand(
  ctx: HardenContext,
  recipe: Recipe,
  scope: HardenScope,
  flags: HardenFlags,
  printer: Printer,
): Promise<number> {
  return applyTarget(ctx, recipe.target({ cwd: ctx.cwd, home: ctx.home, scope }), flags, printer);
}
