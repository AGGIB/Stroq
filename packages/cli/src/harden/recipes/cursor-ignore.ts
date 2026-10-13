import { join } from 'node:path';
import { PROJECT_SECRET_FILES } from './credential-paths.js';
import type { Recipe, RecipeContext, RecipeTarget } from './types.js';

/**
 * R3, `cursor-ignore`: a block of Stroq's between two marker lines in the project's `.cursorignore`,
 * naming the project's secret files, so that Cursor leaves them out of what it indexes and sends to a
 * model.
 *
 * It cannot be checked here: there is no Cursor to run. What the block is, and that Cursor reads that file
 * in that syntax, is Cursor's documentation and not something Stroq has seen work, and the plan and the
 * result say so in one sentence. The file is the project's only: Cursor has no user-level ignore file.
 */

const BLOCK_ID = 'cursor-ignore';
const SUMMARY = 'Ask Cursor to leave the secret files of this project out of what it sends.';
/** A `.cursorignore` is normally committed with the project, so it is made readable like any other file. */
const NEW_IGNORE_MODE = 0o644;

const UNVERIFIED =
  'Stroq has not been able to test this against Cursor, so it cannot say that Cursor keeps these files out of what it sends to a model.';

const LIMITS: readonly string[] = [
  'The block lists the secret files of this project in the form an ignore file takes; it does not touch the lines you wrote.',
  'It covers what Cursor itself indexes and sends; a program an agent runs in a terminal can still read the files.',
];

function target(context: RecipeContext): RecipeTarget {
  return {
    recipe: 'cursor-ignore',
    agent: 'cursor',
    scope: 'project',
    summary: SUMMARY,
    file: join(context.cwd, '.cursorignore'),
    root: context.cwd,
    items: PROJECT_SECRET_FILES,
    words: {
      adds: 'Adds this block to the file, between two marker lines:',
      there: 'This block is already in the file:',
      alreadyDone: 'Nothing to change: the block is already in place.',
      done: 'Cursor is now asked to leave these files out of what it indexes and sends.',
    },
    change: { kind: 'text-block', id: BLOCK_ID, lines: PROJECT_SECRET_FILES },
    newFileMode: NEW_IGNORE_MODE,
    limits: LIMITS,
    unverified: UNVERIFIED,
  };
}

export const cursorIgnore: Recipe = {
  name: 'cursor-ignore',
  agent: 'cursor',
  scopes: ['project'],
  defaultScope: 'project',
  summary: SUMMARY,
  target,
};
