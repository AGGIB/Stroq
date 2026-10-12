// Text from an artifact, made fit to be put in a passport.
//
// A passport is committed to a README and printed by `vet --json`, so no text in it may hold a
// control character or one that shows nothing or reorders what is shown (`PassportLineSchema` refuses
// them). Everything an inspector reads is written by whoever wrote the artifact, so every subject,
// every place and every host passes through here before it is a line: such a character is written out
// as a visible escape, blanks are folded, and the text is cut to a length that is decided here and not
// by the artifact.
import { hasUnshowableCharacter } from '../safe-path.js';

const ELLIPSIS = '…';
/** A run of blanks, newlines and tabs: shown as one space. */
const BLANKS = /\s+/g;
/** How many characters of the input are looked at for each one that may be kept. */
const WINDOW_PER_KEPT = 8;

/** A character as an escape that can be read and cannot act: `\u001b`, or `\u{1f600}` above the BMP. */
function escapeOf(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * `text` as it may be shown in a passport: blanks folded to single spaces and trimmed, every
 * character the schema refuses written out as an escape, and cut to `max` characters with an
 * ellipsis when it was longer. Only a bounded part of a long input is read, so the time does not
 * depend on how long the artifact made it. The result may be empty, and the caller decides what
 * that means.
 */
export function showable(text: string, max: number): string {
  const limit = Math.max(1, Math.floor(max));
  const windowSize = limit * WINDOW_PER_KEPT + 64;
  const wasCut = text.length > windowSize;
  const folded = (wasCut ? text.slice(0, windowSize) : text).replace(BLANKS, ' ').trim();

  const pieces: string[] = [];
  const costs: number[] = [];
  let used = 0;
  let cut = wasCut;
  for (const char of folded) {
    const piece = hasUnshowableCharacter(char) ? escapeOf(char) : char;
    // An escape is ASCII and costs its length; a character costs one, however many units it takes.
    const cost = piece === char ? 1 : piece.length;
    if (used + cost > limit) {
      cut = true;
      break;
    }
    pieces.push(piece);
    costs.push(cost);
    used += cost;
  }
  if (!cut) return pieces.join('');
  // Room for the mark of the cut.
  while (used + 1 > limit && pieces.length > 0) {
    pieces.pop();
    used -= costs.pop() ?? 0;
  }
  return `${pieces.join('').trimEnd()}${ELLIPSIS}`;
}

/** The longest path of the tree that a passport names. */
const WHERE_MAX = 240;

/** A place in a file as a passport holds it: a path of the tree and a line number, or none. */
export function showableWhere(
  file: string,
  line: number | null,
): { readonly file: string; readonly line: number | null } {
  const shownFile = showable(file, WHERE_MAX);
  return {
    file: shownFile === '' ? '(unnamed)' : shownFile,
    line: line !== null && Number.isSafeInteger(line) && line > 0 ? line : null,
  };
}
