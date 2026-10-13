// Lines that fit: wrapping, aligned rows, and paths cut in the middle where they are too long.
import { neutralizeControls } from '../terminal-safe.js';
import { visibleLength } from './style.js';

/** Text from outside (a path, a name) as it may be put on a line: its control characters made visible. */
export const outside = (text: string): string => neutralizeControls(text);

/**
 * Text from outside that belongs on one line (a path, a name): as `outside` makes it, and with a line
 * break or a tab made visible too, which `outside` leaves for the text that has several lines.
 */
export const outsideLine = (text: string): string =>
  outside(text).replace(/[\n\t]/g, (c) => (c === '\n' ? '\\n' : '\\t'));

/** Words wrapped to `width` columns, each line after the first indented by `hang` spaces. */
export function wrap(text: string, width: number, hang = 0): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const room = lines.length === 0 ? width : width - hang;
    if (line !== '' && [...line].length + 1 + [...word].length > room) {
      lines.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : `${' '.repeat(hang)}${l}`));
}

/** What stands for a blank inside text that must not be broken over two lines: a command to copy. */
const KEPT = '\u0001';
/** A command in backticks, or in quotes where it begins with a program that is Stroq's or the agent's own. */
const KEPT_SPANS = /`[^`]{1,100}`|"(?:stroq|openclaw|npx|npm|git) [^"]{1,100}"/g;

/** The text with the blanks inside a command made one that `wrap` does not break at. */
export const keepWhole = (text: string): string =>
  text.replace(KEPT_SPANS, (span) => span.replaceAll(' ', KEPT));

/** A command whose blanks are not broken at, where the text it is in is wrapped by `wrapKeeping`. */
export const unbreakable = (command: string): string => command.replaceAll(' ', KEPT);

/**
 * `wrap`, with a command that a person is to copy (in backticks, or in quotes and begun by a program
 * of ours) kept on one line: a break in it makes two commands of one. A line that is longer than the
 * terminal because of it is the terminal's to fold.
 */
export const wrapKeeping = (text: string, width: number, hang = 0): string[] =>
  wrap(keepWhole(text), width, hang).map((line) => line.replaceAll(KEPT, ' '));

/** A path in `width` columns: the end of it kept, because the end is what names the file. */
export function shortPath(path: string, width: number, ellipsis = '…'): string {
  const chars = [...path];
  if (chars.length <= width) return path;
  const cut = [...ellipsis];
  // Less room than the ellipsis itself: as much of it as there is.
  if (width <= cut.length) return cut.slice(0, Math.max(0, width)).join('');
  return `${ellipsis}${chars.slice(chars.length - (width - cut.length)).join('')}`;
}

/** `label` padded to `labelWidth`, then `value`: one aligned row. */
export const row = (label: string, value: string, labelWidth: number): string =>
  `${label}${' '.repeat(Math.max(1, labelWidth - visibleLength(label)))}${value}`;

/** The longest line of `lines`, as it is seen. */
export const widest = (lines: readonly string[]): number =>
  Math.max(0, ...lines.map((l) => visibleLength(l)));
