import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { expandedPath } from './script-paths.js';
import { commandWord } from './shell-segments.js';

/**
 * Where the segments of a command line run: the directory the command began in, as its `cd`s and
 * `pushd`s move it and the end of a group puts it back. A `cd` can fail, can be one stage of a
 * pipeline, can be put off by `&&` or `if`, and can be a function that does nothing, so the commands
 * after one are looked for there and where they were.
 */

/** No real path is longer: past it, a path is a word the shell makes. */
export const MAX_PATH_CHARS = 4096;
/** The most directories a command is looked at in. */
const MAX_DIRECTORIES = 4;

/** Whitespace-separated words with quotes honoured and backslashes kept: a Windows path stays one. */
export function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}

export const baseOf = (word: string): string => word.replace(/^.*[/\\]/, '');

/** A segment of a line without the `(` and `{` that open a group before it, and where it may run. */
export interface PlacedSegment {
  readonly raw: string;
  readonly segment: string;
  readonly directories: readonly string[];
}

/** Each segment with the directories it may run in, in the order of the line. */
export function placedSegments(segments: readonly string[], cwd: string): PlacedSegment[] {
  let directories: readonly string[] = [cwd];
  const saved: (readonly string[])[] = [];
  return segments.map((raw) => {
    const opens = /^[\s(]*/.exec(raw)?.[0].replace(/\s/g, '').length ?? 0;
    for (let k = 0; k < opens; k += 1) saved.push(directories);
    // A `{` opens a group only before a blank: `{./t.sh,x}` is a word a brace expansion makes.
    const segment = raw.replace(/^(?:[\s(]|\{(?=\s))+/, '');
    directories = nextDirectories(directories, segment);
    const placed = { raw, segment, directories };
    for (let k = trailingCloses(raw); k > 0 && saved.length > 0; k -= 1) {
      directories = saved.pop() ?? directories;
    }
    return placed;
  });
}

/** How many `)` a segment ends with, read back from its end (a regex here was quadratic). */
function trailingCloses(raw: string): number {
  let count = 0;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const ch = raw.charAt(i);
    if (ch === ')') count += 1;
    else if (!/\s/.test(ch)) break;
  }
  return count;
}

/** The directories the commands after a segment may be in: where a `cd` in it leads, and where they were. */
function nextDirectories(directories: readonly string[], segment: string): readonly string[] {
  const moved = directories.map((directory) => directoryAfter(segment, directory));
  if (moved.every((directory, n) => directory === directories[n])) return directories;
  // The first is where the command began; the rest are the latest, so a long chain of `cd` goes on.
  const all = [...new Set([...moved, ...directories])];
  return all.length <= MAX_DIRECTORIES
    ? all
    : [all[all.length - 1] as string, ...all.slice(0, MAX_DIRECTORIES - 1)];
}

/**
 * `resolve(directory, name)` for a name that only goes down (`a`, `a/b`): the directory and the name,
 * with no pass over the whole path to clean it, which a long chain of `cd a` makes once for each one.
 */
function below(directory: string, name: string): string {
  if (process.platform === 'win32' || !/^[^/\0]+(?:\/[^/\0]+)*$/.test(name))
    return resolve(directory, name);
  if (name.split('/').some((part) => part === '.' || part === '..'))
    return resolve(directory, name);
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

/** The directory a `cd` or `pushd` leaves the command in; an unknown target leaves it as it was. */
function directoryAfter(segment: string, directory: string): string {
  const word = commandWord(segment);
  if (word !== 'cd' && word !== 'pushd') return directory;
  const tokens = words(segment);
  const at = tokens.findIndex((t) => baseOf(t).toLowerCase() === word);
  if (at === -1) return directory;
  const target = tokens.slice(at + 1).find((w) => w === '-' || !w.startsWith('-'));
  if (target === undefined) return homedir();
  if (target === '-') return directory;
  const expanded = expandedPath(target, directory);
  if (expanded === null) return directory;
  const next = isAbsolute(expanded) ? expanded : below(directory, expanded);
  // No real path is this long; a chain of `pushd a` would otherwise grow it with every step.
  return next.length > MAX_PATH_CHARS ? directory : next;
}
