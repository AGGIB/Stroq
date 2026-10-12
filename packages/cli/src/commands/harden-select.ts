import { INIT_AGENTS, isInitAgent } from './init.js';
import { RECIPES, claudeReadDeny, findRecipe, recipeForAgent } from '../harden/recipes/index.js';
import type { HardenScope, Recipe } from '../harden/recipes/index.js';

/**
 * What a `stroq harden` command line asks for, decided before anything is read: the subcommand, the
 * options that subcommand may have, and the recipe and scope. A refusal is a value with the exit code
 * it earns, so that the command only prints it.
 *
 * Exit code 2 is for a command line that is wrong (a word or an option that does not exist, two
 * options that contradict each other). Exit code 1 is for one that is well formed and cannot be done
 * (an agent that exists and has no recipe, a scope the recipe does not work in).
 */

export type Subcommand = 'plan' | 'apply' | 'undo' | 'status';

const SUBCOMMANDS: readonly Subcommand[] = ['plan', 'apply', 'undo', 'status'];

export type Refusal = { readonly ok: false; readonly code: 1 | 2; readonly message: string };

const usage = (message: string): Refusal => ({ ok: false, code: 2, message });
const cannot = (message: string): Refusal => ({ ok: false, code: 1, message });

export function chooseSubcommand(
  words: readonly string[],
): { readonly ok: true; readonly subcommand: Subcommand } | Refusal {
  const [word, ...rest] = words;
  if (word === undefined) return { ok: true, subcommand: 'plan' };
  const subcommand = SUBCOMMANDS.find((known) => known === word);
  if (subcommand === undefined) {
    return usage(`unknown subcommand "${word}" (plan, apply, undo or status)`);
  }
  if (rest.length > 0) return usage('only one subcommand at a time (plan, apply, undo or status)');
  return { ok: true, subcommand };
}

const CHOOSES = ['agent', 'scope', 'recipe'] as const;

/**
 * The options each subcommand may be given. `plan` never writes, so `--yes` is not one of its options:
 * a script that types `stroq harden --yes` thinking it applies is told so, and not left believing it.
 */
const ALLOWED: Readonly<Record<Subcommand, readonly string[]>> = {
  plan: [...CHOOSES, 'json', 'acknowledge-link'],
  apply: [
    ...CHOOSES,
    'json',
    'yes',
    'acknowledge-link',
    'acknowledge-credential-loss',
    'acknowledge-reformat',
  ],
  undo: [...CHOOSES, 'yes'],
  status: ['json'],
};

export const allowedOptions = (subcommand: Subcommand): readonly string[] => ALLOWED[subcommand];

/** The names among `given` (option names without the dashes) that `subcommand` does not have. */
export const optionsNotAllowed = (
  subcommand: Subcommand,
  given: readonly string[],
): readonly string[] => given.filter((name) => !ALLOWED[subcommand].includes(name));

export interface Choice {
  readonly agent?: string | undefined;
  readonly recipe?: string | undefined;
  readonly scope?: string | undefined;
}

export type Chosen =
  { readonly ok: true; readonly recipe: Recipe; readonly scope: HardenScope } | Refusal;

const names = (): string => RECIPES.map((recipe) => recipe.name).join(', ');

function recipeNamed(choice: Choice): Recipe | Refusal {
  if (choice.recipe !== undefined) {
    const found = findRecipe(choice.recipe);
    if (found === undefined) {
      return usage(`unknown recipe "${choice.recipe}" (${names()})`);
    }
    if (choice.agent !== undefined && choice.agent !== found.agent) {
      return usage(`recipe ${found.name} is for ${found.agent}, not for ${choice.agent}`);
    }
    return found;
  }
  if (choice.agent === undefined) return claudeReadDeny;
  const forAgent = recipeForAgent(choice.agent);
  if (forAgent !== undefined) return forAgent;
  if (!isInitAgent(choice.agent)) {
    return usage(`unknown agent "${choice.agent}" (${INIT_AGENTS.join(', ')})`);
  }
  return cannot(`stroq harden has no recipe for ${choice.agent} yet (recipes: ${names()})`);
}

const isRefusal = (value: Recipe | Refusal): value is Refusal => 'ok' in value;

/** The recipe and the scope a command line asks for, or why it cannot have them. */
export function chooseRecipe(choice: Choice): Chosen {
  if (choice.scope !== undefined && choice.scope !== 'user' && choice.scope !== 'project') {
    return usage('--scope is user or project');
  }
  const recipe = recipeNamed(choice);
  if (isRefusal(recipe)) return recipe;
  const scope: HardenScope = choice.scope ?? recipe.defaultScope;
  if (!recipe.scopes.includes(scope)) {
    return cannot(
      `${recipe.name} works on the ${recipe.scopes.join(' and ')} only; use --scope ${recipe.scopes[0]}`,
    );
  }
  return { ok: true, recipe, scope };
}
