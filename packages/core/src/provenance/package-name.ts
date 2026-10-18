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
