/**
 * What makes git take a folder for a repository of its own, a bare one, and read its `config`:
 * `HEAD` with `objects` and `refs`, or with a `commondir` file that points at them elsewhere. Each
 * may be a folder, a file or a link, and on a disk that ignores case (macOS, Windows) `Objects`,
 * or `object` with a long s, opens as `objects`. Names are folded as such a disk folds them, and
 * the test errs toward a repository: `HEAD` and `config` with either `objects` or `refs` counts.
 */

const NAMES: ReadonlySet<string> = new Set(['head', 'objects', 'refs', 'config', 'commondir']);
/** No longer name folds to one of those. */
const MAX_NAME = 32;

/** The name as git looks for it (`head`, `objects`...), or undefined for any other name. */
export function gitDirName(name: string): string | undefined {
  if (name.length > MAX_NAME) return undefined;
  const folded = name.normalize('NFKC').toLowerCase();
  return NAMES.has(folded) ? folded : undefined;
}

/** Names git reads as files: a folder by one of these names is not what it looks for. */
export const FILE_NAMES: ReadonlySet<string> = new Set(['head', 'commondir']);

/** Whether a folder holding these names (folded by `gitDirName`) is one git takes for a repository. */
export function looksLikeGitDir(names: ReadonlySet<string>): boolean {
  if (!names.has('head')) return false;
  const objects = names.has('objects');
  const refs = names.has('refs');
  return (objects && refs) || names.has('commondir') || (names.has('config') && (objects || refs));
}
