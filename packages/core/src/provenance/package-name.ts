const QUOTES = '"\'';
// What prose puts after a name: "run npx helper-fix." must yield `helper-fix`, or the
// command that copies it never matches. `;` and `!` need no entry: `VERSION_MARKER`
// cuts at both.
export const TRAILING = `${QUOTES}.,:?)`;
const LEADING_QUOTES = /^["']+/;
const VERSION_MARKER = /[[<>=!~;]/;
const LINE_BREAKS = '\n\r\u2028\u2029';

/**
 * `text` without the run of `chars` at its end. A loop, not a `[…]+$` pattern: that
 * restarts at every character of a run it cannot finish, so a long run followed by
 * one character outside it costs time quadratic in the run.
 */
export function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * `name` cut at its first version, extra or marker character (`>=2.0`, `[socks]`,
 * `; python_version…`), on its last line only: it used to be `/[[<>=!~;].*$/`, whose
 * `.` stops at a line break, so a marker before one was never cut. The same pattern
 * restarted at every marker character of a run it could not finish.
 */
function withoutVersion(name: string): string {
  let lastLine = name.length;
  while (lastLine > 0 && !LINE_BREAKS.includes(name.charAt(lastLine - 1))) lastLine -= 1;
  const cut = name.slice(lastLine).search(VERSION_MARKER);
  return cut === -1 ? name : name.slice(0, lastLine + cut);
}

/**
 * A package name as a lookup key. `knownPackages` runs every dependency name in the
 * project's `package.json` through here on every Bash call — up to 256 KiB of it,
 * written by whoever wrote the repository — so nothing here may be super-linear: with
 * the edges stripped by `/^["']+|["']+$/g` and `/[[<>=!~;].*$/`, one planted name of
 * 262,000 quotes, or of `[`s and a line break, took 30 s.
 */
export function normalizePackageName(raw: string): string {
  const name = trimEndOf(raw.replace(LEADING_QUOTES, ''), TRAILING);
  const at = name.startsWith('@') ? name.indexOf('@', 1) : name.indexOf('@');
  const base = at > 0 ? name.slice(0, at) : name;
  return withoutVersion(base).toLowerCase();
}

/**
 * A Python package name in its one form (PEP 503): lower case, and every run of dashes, underscores
 * and dots one dash. `Evil_Helper..Fix` and `evil-helper-fix` are the same package on PyPI.
 */
export const pythonPackageName = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, '-');

/** The tools whose packages come from PyPI, and so are named in that form. */
const PYTHON_TOOLS: ReadonlySet<string> = new Set(['pip', 'uv', 'pipx', 'poetry', 'pdm', 'conda']);
/** The tools whose packages come from the npm registry (`deno` runs `npm:` specifiers). */
const NPM_TOOLS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'bunx',
  'npx',
  'pnpx',
  'deno',
]);

/** The registry a package is named in: PyPI, npm, or any other (crates, gems, modules, formulae). */
export type Ecosystem = 'npm' | 'python' | 'other';

/** The registry the tool (its name in the table) or the kind of runner takes its packages from. */
export const ecosystemOf = (tool: string, family?: string): Ecosystem => {
  if (family === 'python' || PYTHON_TOOLS.has(tool)) return 'python';
  return NPM_TOOLS.has(tool) ? 'npm' : 'other';
};

/** A name PyPI could have: no scope, path or URL in it, so the one form of PEP 503 is a name of it. */
const PYPI_LIKE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The names a package is read as. A Python installer's package is read in the one form PyPI gives
 * it (PEP 503), whatever its spelling, and so is every other registry's when it is only recorded
 * (a page that names `evil_helper_fix` with `npx` is also recorded as `evil-helper-fix`, so that a
 * Python installer that spells the name another way finds it), and a page that names a package
 * with a Python installer is also recorded as it is written (an npm command that spells it so
 * finds it). A command of any other registry is read as it is written: `evil_helper_fix` is not
 * `evil-helper-fix` on npm. A name PyPI cannot have (a scope, a path, a URL) is read as written.
 */
export function nameForms(written: string, ecosystem: Ecosystem, recording: boolean): string[] {
  if (!PYPI_LIKE.test(written)) return [written];
  const canonical = pythonPackageName(written);
  if (canonical === written) return [written];
  if (ecosystem === 'python') return recording ? [canonical, written] : [canonical];
  return recording ? [written, canonical] : [written];
}

/**
 * The names the project already depends on or has installed, by the registry they are from: a
 * name in `package.json` or `node_modules/.bin` says nothing about the package of that name on
 * PyPI, nor one in `requirements.txt` about the package of that name on npm. The Python names are
 * in the one form of PEP 503.
 */
export interface KnownPackages {
  readonly npm: ReadonlySet<string>;
  readonly python: ReadonlySet<string>;
}

/** Whether the project already depends on the package of that name in that registry. */
export function isKnownPackage(
  written: string,
  ecosystem: Ecosystem,
  known: KnownPackages,
): boolean {
  if (ecosystem === 'npm') return known.npm.has(written);
  return ecosystem === 'python' && known.python.has(pythonPackageName(written));
}
