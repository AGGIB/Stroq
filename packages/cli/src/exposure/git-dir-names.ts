/**
 * What makes git take a folder for a repository of its own, a bare one, and read its `config`:
 * `HEAD` with `objects` and `refs`, or with a `commondir` file that points at them elsewhere. Each
 * may be a folder, a file or a link, and the disk decides which names open as these. Names are
 * folded as the most forgiving disk opens them, and the test errs toward a repository: `HEAD` and
 * `config` with either `objects` or `refs` counts.
 */

const NAMES: ReadonlySet<string> = new Set(['head', 'objects', 'refs', 'config', 'commondir']);

/**
 * Longer than any name a disk holds (255 units on every common one, 255 bytes on most), with room
 * to spare: a part of a path this long is never checked out, so it is not folded, only put in lower
 * case, and is no name git looks for.
 */
export const MAX_NAME = 1024;

/** Printable ASCII: most names are, and fold with a few steps only. */
const PLAIN = /^[\x20-\x7e]*$/;

/**
 * Windows drops dots and blanks at the end of a name. One pass from the end, by char code: a
 * pattern such as `/[. ]+$/` tries every start in a long run of them, which is slow on a name
 * built for it (`. . . x`).
 */
function dropTrailing(name: string): string {
  let end = name.length;
  for (let c = name.charCodeAt(end - 1); end > 0 && (c === 0x2e || c === 0x20);) {
    end -= 1;
    c = name.charCodeAt(end - 1);
  }
  return name.slice(0, end);
}
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
  if (name.length > MAX_NAME) return name.toLowerCase();
  const colon = name.indexOf(':');
  const stream = colon === -1 ? name : name.slice(0, colon);
  if (PLAIN.test(stream)) return dropTrailing(stream.toLowerCase());
  const folded = stream
    .normalize('NFKD')
    .replace(DROPPED, '')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
  return dropTrailing(folded);
}

/**
 * Whether a name is one Windows opens as another name, or may: dots or blanks at its end, a `:`
 * stream, or the shape of a short 8.3 name (`CLAUDE~1`, `SETTIN~1.JSO`), which NTFS gives a long
 * name such as `.claude` next to its own. Git for Windows refuses the first two on checkout, but
 * other tools and settings do not.
 */
export function windowsAlias(name: string): boolean {
  if (name.includes(':')) return true;
  if (name !== dropTrailing(name)) return true;
  const tilde = name.indexOf('~');
  if (tilde === -1 || tilde > 6) return false;
  const dot = name.indexOf('.', tilde);
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot + 1);
  return (
    stem.length <= 8 &&
    ext.length <= 3 &&
    !ext.includes('.') &&
    !stem.slice(0, tilde).includes('.') &&
    /^[0-9]+$/.test(stem.slice(tilde + 1))
  );
}

/** The name as git looks for it (`head`, `objects`...), or undefined for any other name. */
export function gitDirName(name: string): string | undefined {
  if (name.length > MAX_NAME) return undefined;
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
