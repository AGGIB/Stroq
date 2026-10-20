import { runsFetchedOrHiddenCode, sendsSecrets } from './fetch-shapes.js';
import { foldName } from './git-dir-names.js';

/**
 * How a hook file is taken, in `.git/hooks` and in every folder a commit runs hooks from (husky's,
 * a `.githooks` folder, one `core.hooksPath` names): one table for all of them, so the same file
 * is never milder in one place than in another.
 */

/**
 * The hooks that run only when someone commits or pushes, the ones the pre-commit and husky
 * installers write. Every other hook git runs during routine use (`post-index-change` on a
 * `git status`, `post-checkout`, `reference-transaction` on any ref update), and any other file
 * there may be one a hook sources.
 */
export const COMMIT_HOOKS: ReadonlySet<string> = new Set([
  'pre-commit',
  'pre-push',
  'commit-msg',
  'prepare-commit-msg',
]);

/**
 * `routine` for a file that is not a commit hook, by its name as a forgiving disk opens it;
 * `unsafe` for a commit hook whose text was not read (`undefined`), or downloads and runs code,
 * runs hidden code or sends a secret out; `commit` for any other commit hook. The first two fail
 * before anyone approves anything.
 */
export function hookOutcome(
  name: string,
  text: string | undefined,
): 'routine' | 'unsafe' | 'commit' {
  if (!COMMIT_HOOKS.has(foldName(name))) return 'routine';
  if (text === undefined || runsFetchedOrHiddenCode(text) || sendsSecrets(text)) return 'unsafe';
  return 'commit';
}
