/**
 * What makes git take a folder for a repository of its own, a bare one, and read its `config`:
 * `HEAD` with `objects` and `refs`, or with a `commondir` file that points at them elsewhere. Each
 * may be a folder, a file or a link, and the disk decides which names open as these. Names are
 * folded as the most forgiving disk opens them, and the test errs toward a repository: `HEAD` and
 * `config` with either `objects` or `refs` counts.
 */

const NAMES: ReadonlySet<string> = new Set(['head', 'objects', 'refs', 'config', 'commondir']);

/** Printable ASCII: most names are, and fold with a few steps only. */
const PLAIN = /^[\x20-\x7e]*$/;
/** Windows drops dots and blanks at the end of a name. */
const TRAILING = /[. ]+$/;
/**
 * Characters macOS ignores in a name (zero-width ones, soft hyphens, variation selectors), and
 * the marks that only accent a letter: `cómmondir` is read as `commondir`, in doubt.
 */
const DROPPED = /[\p{Default_Ignorable_Code_Point}\p{M}]/gu;

/**
 * A name as the most forgiving disk opens it: from `:` on dropped (Windows reads `HEAD::$DATA` as
 * `HEAD`), ignorable characters and accents dropped, compatibility forms and case folded (`ſ`,
 * the dotless `ı` and fullwidth letters too), and dots and blanks at the end dropped. Two names
 * that fold to one text may be the same folder on some disk.
 */
export function foldName(name: string): string {
  const colon = name.indexOf(':');
  const stream = colon === -1 ? name : name.slice(0, colon);
  if (PLAIN.test(stream)) return stream.toLowerCase().replace(TRAILING, '');
  const folded = stream
    .normalize('NFKD')
    .replace(DROPPED, '')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
  return folded.replace(TRAILING, '');
}

/** The name as git looks for it (`head`, `objects`...), or undefined for any other name. */
export function gitDirName(name: string): string | undefined {
  const folded = foldName(name);
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
