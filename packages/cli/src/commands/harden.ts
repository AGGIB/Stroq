import { parseArgs } from 'node:util';
import { applyCommand } from './harden-apply.js';
import { failureOf } from './harden-errors.js';
import { contextOf, type HardenContext, type HardenDeps } from './harden-deps.js';
import type { HardenFlags } from './harden-flags.js';
import { planCommand } from './harden-plan.js';
import { statusCommand } from './harden-status.js';
import { undoCommand } from './harden-undo.js';
import { makePrinter, type Printer } from './harden-printer.js';
import {
  chooseRecipe,
  chooseSubcommand,
  optionsNotAllowed,
  type Subcommand,
} from './harden-select.js';
import type { HardenScope, Recipe } from '../harden/recipes/index.js';

/**
 * `stroq harden`: make the host's own protection of credential files stronger, show exactly what that
 * changes, and make it so that it can be undone.
 *
 *   stroq harden [plan] [--agent <id>] [--scope user|project] [--recipe <name>] [--json]
 *   stroq harden apply [the same] [--yes] [--acknowledge-link] [--acknowledge-credential-loss]
 *   stroq harden undo [--agent <id>] [--scope user|project] [--yes]
 *   stroq harden status [--json]
 *
 * `plan` is the default and writes nothing. `apply` and `undo` are a person's to run: on a terminal they
 * show what they will do and ask, and anywhere else they need `--yes`; there is no other way to make them
 * go on without a person, and the state gate refuses an agent that tries (`stroq-state.ts` in core).
 *
 * Exit codes: 0 done, or nothing to do; 1 refused or failed (the message says why); 2 the command line is
 * wrong; 3 the change needs an acknowledgement flag that was not given.
 */

const USAGE_ERROR = 2;

function usageError(message: string): number {
  process.stderr.write(`stroq harden: ${message}\nRun "stroq harden --help" to see its options.\n`);
  return USAGE_ERROR;
}

export async function runHarden(args: readonly string[], deps: HardenDeps = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      agent: { type: 'string' },
      scope: { type: 'string' },
      recipe: { type: 'string' },
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      'acknowledge-link': { type: 'boolean' },
      'acknowledge-credential-loss': { type: 'boolean' },
      'acknowledge-reformat': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const chosen = chooseSubcommand(positionals);
  if (!chosen.ok) return usageError(chosen.message);
  const given = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  const stray = optionsNotAllowed(chosen.subcommand, given);
  if (stray.length > 0) {
    return usageError(`--${stray[0]} is not an option of "${chosen.subcommand}"`);
  }
  const flags: HardenFlags = {
    json: values.json === true,
    yes: values.yes === true,
    acknowledgeLink: values['acknowledge-link'] === true,
    acknowledgeCredentialLoss: values['acknowledge-credential-loss'] === true,
    acknowledgeReformat: values['acknowledge-reformat'] === true,
  };
  if (chosen.subcommand === 'apply' && flags.json && !flags.yes) {
    return usageError('--json does not ask a question, so apply needs --yes with it');
  }
  const selection = chooseRecipe(values);
  if (!selection.ok) {
    return selection.code === USAGE_ERROR
      ? usageError(selection.message)
      : refused(chosen.subcommand, flags, selection.message);
  }
  return dispatch(chosen.subcommand, contextOf(deps), selection.recipe, selection.scope, flags);
}

/** A command line that is well formed and cannot be done, answered in the form the command prints in. */
function refused(subcommand: Subcommand, flags: HardenFlags, message: string): number {
  return makePrinter(flags.json, subcommand).finish(1, { status: 'refused', message });
}

async function dispatch(
  subcommand: Subcommand,
  ctx: HardenContext,
  recipe: Recipe,
  scope: HardenScope,
  flags: HardenFlags,
): Promise<number> {
  const printer: Printer = makePrinter(flags.json, subcommand);
  try {
    if (subcommand === 'apply') return await applyCommand(ctx, recipe, scope, flags, printer);
    if (subcommand === 'undo') return await undoCommand(ctx, recipe, scope, flags, printer);
    if (subcommand === 'status') return statusCommand(ctx, printer);
    return planCommand(ctx, recipe, scope, flags, printer);
  } catch (err) {
    const { code, outcome } = failureOf(err);
    return printer.finish(code, outcome);
  }
}
