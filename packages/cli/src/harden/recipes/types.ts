import type { JsonEdit } from '../types.js';

/**
 * What a recipe is: a choice of file and of edits, and nothing else. A recipe does not read the file,
 * write it or ask anyone anything; the engine plans and applies, and the command shows and asks. A recipe
 * only says WHICH change is wanted, and what is honest to say about it.
 */

/** Agents `stroq harden` has a recipe for. The ids are those `stroq init --agent` uses. */
export type HardenAgent = 'claude-code' | 'cursor';

/** `user`: the person's own configuration. `project`: the folder the command is run in. */
export type HardenScope = 'user' | 'project';

/** Where a recipe is asked to work: the folder the command runs in, the home directory, the scope. */
export interface RecipeContext {
  readonly cwd: string;
  readonly home: string;
  readonly scope: HardenScope;
  /** `CLAUDE_CONFIG_DIR` where it is set: Claude Code may keep its user settings there. */
  readonly claudeConfigDir?: string | undefined;
}

/** What a recipe wants of a file. */
export type RecipeChange =
  | {
      readonly kind: 'json';
      readonly edits: readonly JsonEdit[];
      /**
       * The lines to add by hand to a file the engine will not rewrite (one with comments in it). They come
       * from the recipe alone and never from the file, so printing them shows the owner nothing of it.
       */
      readonly snippet: string;
    }
  | { readonly kind: 'text-block'; readonly id: string; readonly lines: readonly string[] };

export interface RecipeTarget {
  readonly recipe: string;
  readonly agent: HardenAgent;
  readonly scope: HardenScope;
  /** One sentence, for the top of its plan. */
  readonly summary: string;
  /** The file to change, as a path: it may be a link; the engine follows it. */
  readonly file: string;
  /** The folder the file must stay inside: the home for the user's files, the project for the project's. */
  readonly root: string;
  /** The rules or lines the recipe adds, in the order they are shown. */
  readonly items: readonly string[];
  /** The words of its plan around the items. */
  readonly words: {
    /** The line above the items: what is added, and where. */
    readonly adds: string;
    /** Said instead of the change when everything is there already. */
    readonly alreadyDone: string;
    /** Said after the change is made: what it does now, and that it is not more than that. */
    readonly done: string;
  };
  readonly change: RecipeChange;
  /** The mode of the file if the recipe has to make it. */
  readonly newFileMode: number;
  /** What the change does and does not do, one plain sentence each. */
  readonly limits: readonly string[];
  /** One sentence saying the change could not be checked against the agent, or `null` when it could. */
  readonly unverified: string | null;
}

export interface Recipe {
  readonly name: string;
  readonly agent: HardenAgent;
  /** The scopes it works in; the first is not necessarily the default. */
  readonly scopes: readonly HardenScope[];
  readonly defaultScope: HardenScope;
  /** One sentence, for the top of its plan. */
  readonly summary: string;
  target(context: RecipeContext): RecipeTarget;
}
