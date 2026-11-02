import { expandBraces } from './brace-expansion.js';

/**
 * Whether a recursive delete is aimed outside the working tree.
 *
 * Lives in its own module because both shell readers need it and neither may own
 * it: `classify-bash.ts` applies it to `rm -rf`, `classify-powershell.ts` to
 * `Remove-Item -Recurse` and `rd /s`, and a second copy of this judgement would be
 * a target one reader called dangerous and the other did not.
 *
 * A path that holds `..` is read word by word against the directory it is judged from, so that
 * `tmp/../../x` and `/work/project/../x` are the directory above the project, as `../x` is, and
 * `build/../dist` is the folder it names. A name a shell expands beside a `..` (`a/$X/../..`) is not
 * known to stay, and is not judged to.
 */

/** `C:\…`, `c:/…`, and the bare drive on its own. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;
/** `\\server\share` — someone else's filesystem, never the checkout. */
const UNC_PATH = /^\\\\/;

/** Both separators, one casing, no trailing slash — so two spellings compare equal. */
const foldPath = (path: string): string => withoutTrailingSlashes(path.replace(/[\\/]+/g, '/'));

/**
 * `path` without its trailing slashes. A loop rather than `/\/+$/`, which restarts at
 * every slash of a run it cannot finish: a target of 65,536 slashes and one more
 * character took 1.7 s, and a delete target is a word of a command the agent wrote.
 */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === '/') end -= 1;
  return path.slice(0, end);
}

/** Both separators: a path read here may be a PowerShell path as well as a POSIX one. */
const SEPARATORS = /[\\/]+/;
/** A name a shell replaces with words of its own: it may hold a slash or a `..`. */
const EXPANDED = /[$`{(]/;
/** A pattern; it matches one name and never a slash, but a dot-leading one may match `..`. */
const PATTERN = /[*?[]/;

/**
 * A name read as more than one name, or as none that is known: a word the shell replaces, a pattern that
 * may match `..` (dot-leading), and `**`, which zsh and bash with globstar match against zero or many
 * directories.
 */
const expands = (component: string): boolean =>
  EXPANDED.test(component) ||
  component.includes('**') ||
  (component.startsWith('.') && PATTERN.test(component));

/**
 * How a name of a path that holds `..` is counted. A pattern with a `..` after it is not known to be one
 * name: a `..` climbs over whatever it matched, and what it matched is the shell's to say. A pattern after
 * the last `..` cannot change how far the path climbs, and counts as the one name it matches.
 */
type Step = 'skip' | 'up' | 'name' | 'unknown';
function stepOf(component: string, climbsLater: boolean): Step {
  if (component === '' || component === '.') return 'skip';
  if (component === '..') return 'up';
  if (expands(component)) return 'unknown';
  return climbsLater && PATTERN.test(component) ? 'unknown' : 'name';
}

/** Whether a path has a `..` of its own among its names. */
const climbs = (path: string): boolean =>
  path.includes('..') && path.split(SEPARATORS).includes('..');

/**
 * Whether a relative path that holds `..` climbs out of the directory it starts in, or comes back to it
 * (`a/..` is the directory itself, as `.` is). A name that is not known to be one name beside a `..`
 * is not known to stay.
 */
function leavesStart(path: string): boolean {
  const components = path.split(SEPARATORS);
  const last = components.lastIndexOf('..');
  let depth = 0;
  for (const [at, component] of components.entries()) {
    const step = stepOf(component, at < last);
    if (step === 'unknown') return true;
    if (step === 'skip') continue;
    if (step === 'up') {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      // `a/../*` is every file of the directory, as `*` is.
      if (depth === 0 && (component === '*' || component === '.*')) return true;
      depth += 1;
    }
  }
  return depth <= 0;
}

/**
 * The names of an absolute path with its `..` taken out, or null when a name beside one is not known to be
 * one name. The first `keep` names stay (the drive of a Windows path), as `/..` is `/`.
 */
function resolvedNames(path: string, keep: number): string[] | null {
  const components = path.split(SEPARATORS);
  const last = components.lastIndexOf('..');
  const names: string[] = [];
  for (const [at, component] of components.entries()) {
    const step = stepOf(component, at < last);
    if (step === 'unknown') return null;
    if (step === 'name') names.push(component);
    else if (step === 'up' && names.length > keep) names.pop();
  }
  return names;
}

/** An absolute POSIX path with its `..` taken out, or null when that cannot be told. */
function absoluteNames(path: string): string | null {
  const names = resolvedNames(path, 0);
  return names === null ? null : `/${names.join('/')}`;
}

export function isDangerousRmTarget(target: string, cwd: string): boolean {
  const t = target.replace(/["']/g, '');
  if (t === '') return false;
  // `rm -rf {~,/tmp/x}` deletes two targets, and the text shows neither: each is judged, and a
  // word that makes too many to read is one that is not known to be safe.
  if (t.includes('{')) {
    const words = expandBraces(t);
    if (words === null) return true;
    if (words.length !== 1 || words[0] !== t)
      return words.some((word) => isDangerousRmTarget(word, cwd));
  }
  // `.*` and `./.*` are every dotfile of the directory: `.git`, `.env`, the agent's own settings.
  if (['/', '/*', '.', './', '*', './*', '.*', './.*'].includes(t)) return true;
  // `~`, `~/…` and `~user/…` expand to a home directory, which is never inside a
  // project checkout; `$VAR` is unknown and `..` points upward — all treated as
  // outside the working tree. `$` also covers PowerShell's `$env:USERPROFILE`,
  // which is the same claim about the same directory in a different spelling.
  if (t.startsWith('~') || t.startsWith('$') || t.startsWith('..')) return true;
  if (UNC_PATH.test(t)) return true;
  /**
   * A Windows absolute path, which the POSIX branch below rejected outright because
   * it does not begin with `/` — so `Remove-Item -Recurse -Force C:\` and
   * `rd /s /q C:\Windows` were both "inside the working tree" and carried no class
   * at all. Compared case-insensitively, because Windows resolves `C:\Src` and
   * `c:\src` to one directory and a case-sensitive test would call the second one
   * an outside target for a delete that is in fact inside the checkout.
   */
  if (WINDOWS_DRIVE_PATH.test(t)) {
    const folded = foldPath(t).toLowerCase();
    const root = foldPath(cwd).toLowerCase();
    // The drive stays: `C:\..` is `C:\`.
    const normalized = climbs(folded) ? resolvedNames(folded, 1)?.join('/') : folded;
    return normalized === undefined || normalized === '' || !normalized.startsWith(`${root}/`);
  }
  // A relative path is inside the working tree wherever it goes, unless it climbs out of it.
  if (!t.startsWith('/')) return climbs(t) && leavesStart(t);
  const normalized = withoutTrailingSlashes(t);
  // `cwd` is compared without its trailing slashes, so `/repo/` holds `/repo/build`. A working tree
  // at `/` (or none) would then hold every path: none is inside it, for a recursive delete.
  const root = withoutTrailingSlashes(cwd);
  if (root === '') return true;
  const resolved = climbs(normalized) ? absoluteNames(normalized) : normalized;
  return resolved === null || !resolved.startsWith(`${root}/`);
}
