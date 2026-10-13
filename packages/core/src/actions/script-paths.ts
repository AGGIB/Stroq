import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { expandBraces } from './brace-expansion.js';
import { filesNamedBy, isPattern, type PatternBudget } from './file-glob.js';

/**
 * Where a script a command names can be: the names it is written with, a pattern or a brace
 * expansion in them, and the directory the command is in, put as the shell and the system put them.
 */

/** A script a command names: as it is written, and whether only a shell `#!` line makes it one. */
export interface ScriptReference {
  readonly token: string;
  readonly needsShebang: boolean;
  /** A word run by its path with no shell named: most words that begin a segment are not commands. */
  readonly direct?: boolean;
  /** Read by `source` or `.`: a file of variables is configuration, not a program. */
  readonly sourced?: boolean;
}

export const named = (token: string, sourced = false): ScriptReference => ({
  token,
  needsShebang: false,
  sourced,
});

/** A path with `~`, `~+`, `$HOME` and `$PWD` at its front put as the shell would put them. */
export function frontExpanded(token: string, cwd: string): string {
  const front = /^(?:~\+|~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=[/\\]|$)/.exec(token);
  if (front === null) return token;
  const root = front[0] === '~+' || front[0].includes('PWD') ? cwd : homedir();
  return join(root, token.slice(front[0].length));
}

/** A path as the shell would expand it: `~`, `$HOME` and `$PWD` at the front; any other variable is unknown. */
export function expandedPath(token: string, cwd: string): string | null {
  const joined = frontExpanded(token, cwd);
  return /[$`*?<>|]/.test(joined) ? null : joined;
}

export const asPath = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path);

export function resolveScript(token: string, cwd: string): string | null {
  if (token === '') return null;
  const expanded = expandedPath(token, cwd);
  return expanded === null ? null : asPath(expanded, cwd);
}

/**
 * Where `token` leads from `dir` when each `..` follows the link before it, as the system does:
 * `link/../x.sh` is in the directory above what `link` points at, which is not the one above it.
 */
function physicalPath(token: string, dir: string): string | null {
  if (!token.split('/').includes('..')) return null;
  try {
    let at = isAbsolute(token) ? '/' : dir;
    for (const part of token.split('/')) {
      if (part === '' || part === '.') continue;
      at = part === '..' ? dirname(realpathSync(at)) : join(at, part);
    }
    return at;
  } catch {
    return null;
  }
}

/**
 * The paths a script operand can mean: itself, as it is spelt (a file may be named `a$b.sh`) and
 * with `~`, `$HOME` and `$PWD` put in, each `..` followed as the system follows it, and when it
 * holds a pattern or a brace expansion, the files the shell would make of it (see `file-glob.ts`).
 * A name an expansion this cannot know stands in (`$(…)`, a variable that is not `$HOME` or
 * `$PWD`) is not one of these.
 *
 * Only a script a shell is told to run has its patterns expanded. A word that begins a segment and
 * has a `/` in it is also looked up as a program run by its path, but most are not: the head of
 * `x=$(ls build/*.ipa)` is that word, and so is a line of a `git add` list. Reading every file
 * such a pattern matches would classify a listing of scripts as the commands they hold. Its braces
 * are expanded, which names the program without a listing.
 */
export function scriptPaths(
  reference: ScriptReference,
  cwd: string,
  patterns: PatternBudget,
): { readonly paths: readonly string[]; readonly complete: boolean } {
  const { token } = reference;
  const namesOf = (word: string): string[] =>
    [...new Set([resolveScript(word, cwd), asPath(word, cwd), physicalPath(word, cwd)])].filter(
      (path): path is string => path !== null,
    );
  const own = namesOf(token);
  if (reference.direct === true) {
    // A brace expansion needs no listing, and a command word that holds one runs the first word it
    // makes (`./{t,u}.sh` runs `./t.sh`): a pattern is not expanded here, braces are.
    if (!token.includes('{')) return { paths: own, complete: true };
    const words = expandBraces(token);
    if (words === null) return { paths: own, complete: false };
    return { paths: [...new Set([...own, ...namesOf(words[0] ?? token)])], complete: true };
  }
  if (!isPattern(token)) return { paths: own, complete: true };
  const found = filesNamedBy(token, cwd, patterns, (word) => frontExpanded(word, cwd));
  // A name from a listing is a name, whatever it holds: `a$b.sh` is not an unset variable.
  return {
    paths: [...own, ...found.paths.map((path) => asPath(path, cwd))],
    complete: found.complete,
  };
}
