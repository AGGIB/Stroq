// Small text helpers the card shares: numbers, paths, words from outside made safe, wrapping.
//
// Anything that came from a transcript, a repository or a key file (a command, a path, a host, a file
// name, a key's name) goes through `clean` before it is put in a sentence: blanks folded to one space,
// every control character written out as a visible `\uXXXX` (the existing neutraliser), and a cut to a
// length. The card then holds nothing a terminal could obey.
import { win32 } from 'node:path';
import { neutralizeControls } from '@stroq/core';

/** `31785` as `31,785`. */
export const num = (value: number): string => value.toLocaleString('en-US');

/** `1 key`, `2 keys`. */
export const plural = (value: number, one: string, many: string): string =>
  `${num(value)} ${value === 1 ? one : many}`;

/** The first `max` characters of a text, with an ellipsis when it is longer. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** Text from outside as one safe, short line. */
export function clean(text: string, max = 80): string {
  return cut(neutralizeControls(text.replace(/\s+/g, ' ').trim()), max);
}

/** A drive-rooted path or a UNC path with a server and share. */
const windowsPath = (path: string): boolean =>
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$))/.test(path);

/** A path with the home folder written as `~`. */
export function tilde(path: string, home: string): string {
  if (windowsPath(home)) {
    if (!windowsPath(path)) return path;
    const relative = win32.relative(home, path);
    if (relative === '') return '~';
    if (relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) return path;
    return `~/${relative.replace(/\\/g, '/')}`;
  }
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** A path for a line of the card: `~` for home, and the middle cut out when it is long. */
export function shortPath(path: string, home: string, max = 44): string {
  const shown = clean(tilde(path, home), 4_096);
  const chars = [...shown];
  if (chars.length <= max) return shown;
  const head = Math.ceil((max - 1) / 3);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

/**
 * Words wrapped to `width` columns. `first` is put before the first line and `rest` before the others
 * (spaces, to hang the text under itself). A word longer than a line is cut to fit.
 */
export function wrap(
  text: string,
  width: number,
  first = '',
  rest = first.replace(/./g, ' '),
): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  const room = (prefix: string): number => Math.max(8, width - [...prefix].length);
  for (const raw of text.split(/\s+/).filter((w) => w !== '')) {
    const prefix = lines.length === 0 ? first : rest;
    const word = cut(raw, room(prefix));
    const joined = empty ? `${line}${word}` : `${line} ${word}`;
    if ([...joined].length <= width || empty) {
      line = joined;
      empty = false;
    } else {
      lines.push(line);
      line = `${rest}${word}`;
      empty = false;
    }
  }
  lines.push(empty ? first.trimEnd() : line);
  return lines;
}
