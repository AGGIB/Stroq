// Text from a passport, made fit for a terminal or a README.
//
// A passport is already bounded: the inspectors write out every control and invisible character as an
// escape, and the schema holds a source label to the same rule. But a passport is a record that is read back
// from a file, a README or a lock that somebody else wrote, and the screen is the last thing between a string
// in it and a terminal. So every string from a passport passes here, whatever made it, and what comes out is
// one line, cut to a length decided here, with every character that acts on a terminal or shows nothing
// spelled as a visible escape.
import { hasUnshowableCharacter } from '../install/safe-path.js';
import { outsideLine } from '../ui/layout.js';

const ELLIPSIS = '\u2026';
/** How many characters of the input are looked at for each one that may be kept: a hostile string is read in part. */
const WINDOW_PER_KEPT = 8;

/** A character as an escape that can be read and cannot act: `\u001b`, or `\u{1f600}` above the BMP. */
function escapeOf(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** One character as it is shown: a line break or a tab as `\n` or `\t`, anything else that acts or hides as an escape. */
function shownChar(char: string): string {
  if (char === '\n') return '\\n';
  if (char === '\t') return '\\t';
  return hasUnshowableCharacter(char) ? escapeOf(char) : char;
}

/**
 * `text` on one line, at most `max` characters wide (an escape counts for what it spells), with an ellipsis
 * where it was cut. The cut is on a character and never inside a pair of units, and an escape is never cut
 * in half.
 */
export function lineText(text: string, max: number): string {
  const window = text.length > max * WINDOW_PER_KEPT ? text.slice(0, max * WINDOW_PER_KEPT) : text;
  let width = 0;
  let cut = window.length < text.length;
  const kept: string[] = [];
  const costs: number[] = [];
  for (const char of window) {
    const piece = shownChar(char);
    // A character takes one column, however many units it is; an escape takes what it spells.
    const cost = piece === char ? 1 : piece.length;
    if (width + cost > max) {
      cut = true;
      break;
    }
    kept.push(piece);
    costs.push(cost);
    width += cost;
  }
  if (!cut) return outsideLine(kept.join(''));
  // Room for the mark of the cut.
  while (width + 1 > max && kept.length > 0) {
    kept.pop();
    width -= costs.pop() ?? 0;
  }
  return outsideLine(`${kept.join('')}${ELLIPSIS}`);
}

/**
 * The same, but the END of the text is kept and the ellipsis stands in front: for a path, whose end is
 * what names the file.
 */
export function tailText(text: string, max: number): string {
  const reach = max * WINDOW_PER_KEPT;
  const window = text.length > reach ? text.slice(text.length - reach) : text;
  let width = 0;
  let cut = window.length < text.length;
  const kept: string[] = [];
  const costs: number[] = [];
  for (const char of [...window].reverse()) {
    const piece = shownChar(char);
    const cost = piece === char ? 1 : piece.length;
    if (width + cost > max) {
      cut = true;
      break;
    }
    kept.push(piece);
    costs.push(cost);
    width += cost;
  }
  if (!cut) return outsideLine(kept.reverse().join(''));
  while (width + 1 > max && kept.length > 0) {
    kept.pop();
    width -= costs.pop() ?? 0;
  }
  return outsideLine(`${ELLIPSIS}${kept.reverse().join('')}`);
}

/** How many columns a line of this text takes: characters, an escape for what it spells. */
export const widthOf = (text: string): number => [...text].length;

/** `text` padded with blanks on the right to `width` columns. */
export const padTo = (text: string, width: number): string =>
  `${text}${' '.repeat(Math.max(0, width - widthOf(text)))}`;

/** `1 file`, `2 files`. */
export const count = (n: number, one: string, many: string = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
