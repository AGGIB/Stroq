import { posix } from 'node:path';

/**
 * The words of a command line that could name a file of the repository, for following what a
 * hook, a task or a script runs. Not a shell parser: every place a path can start is a place a
 * word ends, so a path behind `$(git rev-parse --show-toplevel)/`, `${DIR:-.}/` or a quote is a
 * word of its own, starting with `/`, and is matched by its end (see `agent-run-files.ts`).
 *
 * Each step is a split or a single pass, so the work is linear in the length of the command.
 */

/** Where a word of a command line ends, for finding the paths in it. */
const SEPARATOR = /[\s;&|()<>`=,{}[\]"':]+/;
/** A quoted string on one line: its text is one path even with a blank in it. */
const QUOTED = /"([^"\n]*)"|'([^'\n]*)'/g;
const ESCAPED_SPACE = /\\ /g;
/** An address: blanked before the line is split at `:`, so no part of it is taken for a path. */
const ADDRESS = /[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s"'`]*/g;
const BLANK = /\s/;
/** Stands for an escaped blank while the line is split: no separator, and in no real command. */
const HOLD = String.fromCharCode(1);

/** Longer than any path a host can open (`PATH_MAX`), so no file of the repository. */
export const MAX_PATH_CHARS = 4096;

/** The words of a command line in order, then the text of each quoted string that holds a blank. */
export function commandWords(command: string): string[] {
  const held = command.replace(ADDRESS, ' ').replace(ESCAPED_SPACE, HOLD);
  const words = held
    .split(SEPARATOR)
    .filter((word) => word !== '')
    .map((word) => (word.includes(HOLD) ? word.split(HOLD).join(' ') : word));
  const quoted: string[] = [];
  for (const match of command.matchAll(QUOTED)) {
    const text = (match[1] ?? match[2] ?? '').trim();
    if (BLANK.test(text)) quoted.push(text);
  }
  return [...words, ...quoted];
}

/**
 * A word as a path with `/` between its parts and `./` and `a/../` resolved; undefined for a word
 * that is no path of the repository: an option, an address, one longer than a path can be.
 */
export function pathOf(word: string): string | undefined {
  if (word.length > MAX_PATH_CHARS || word.startsWith('-') || word.includes('://'))
    return undefined;
  const normal = posix.normalize(word.replace(/\\/g, '/'));
  const path = normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
  return path === '.' || path === '' ? undefined : path;
}

/** The words of a command line that could be a path, as paths. */
export const pathWords = (command: string): string[] =>
  commandWords(command).flatMap((word) => pathOf(word) ?? []);

/** The last word of `path`: what a shell finds a program by. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The ends of `path` that could be a path of the repository: the whole of it unless it starts
 * at `/`, what follows its first `/` (the path behind a prefix such as `$(pwd)/`), and what
 * follows each of its last `max` slashes, longest first.
 */
export function pathEnds(path: string, max: number): string[] {
  const ends = new Set<string>();
  if (!path.startsWith('/')) ends.add(path);
  const first = path.indexOf('/');
  if (first !== -1 && first + 1 < path.length) ends.add(path.slice(first + 1));
  const tail: string[] = [];
  for (let at = path.length - 1; at >= 0 && tail.length < max; at -= 1)
    if (path.charCodeAt(at) === 0x2f && at + 1 < path.length) tail.push(path.slice(at + 1));
  for (const end of tail.reverse()) ends.add(end);
  return [...ends];
}

/** Whether a word holds a pattern the shell expands: `*`, `?` or `[`. */
export const isGlob = (word: string): boolean => /[*?[]/.test(word);

/** The folder a pattern is under: its parts before the first that holds a wildcard. */
export function globFolder(path: string): string {
  const parts = path.split('/');
  const at = parts.findIndex(isGlob);
  return parts.slice(0, at === -1 ? parts.length : at).join('/');
}
