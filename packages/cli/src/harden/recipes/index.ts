import { claudeReadDeny } from './claude-read-deny.js';
import { cursorIgnore } from './cursor-ignore.js';
import type { Recipe } from './types.js';

export * from './types.js';
export { claudeReadDeny, cursorIgnore };

/** Every recipe `stroq harden` has, in the order they are listed. Only these: no sandbox recipe yet. */
export const RECIPES: readonly Recipe[] = [claudeReadDeny, cursorIgnore];

/**
 * By linear search and strict equality, not by indexing an object: a name taken from a command line
 * must not be answered by a property every object has (`constructor`).
 */
export const findRecipe = (name: string): Recipe | undefined =>
  RECIPES.find((recipe) => recipe.name === name);

export const recipeForAgent = (agent: string): Recipe | undefined =>
  RECIPES.find((recipe) => recipe.agent === agent);
