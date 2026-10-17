/**
 * How `--strict` writes a JSON message as one line.
 *
 * `JSON.stringify` leaves three characters raw inside a string that a reader less strict
 * than JSON takes for the end of a line: U+2028 and U+2029, the Unicode line and
 * paragraph separators (JSON has allowed them since ES2019, and `JSON.stringify` writes
 * them as they are), and U+0085, NEL. A client that splits the stream into messages on
 * any of them would cut a message in two at a character a server chose. Strict mode
 * writes each as its JSON escape, ` `, ` `, `\u0085`: a parser reads back the
 * same character, and the line contains nothing but the newline at its end.
 *
 * The default proxy keeps writing what `JSON.stringify` makes, byte for byte, so this is
 * applied only where strict mode serialises.
 */

const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029, 0x85)}]`, 'g');

const escapeOf = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** `json` (the text `JSON.stringify` made) with each line separator written as an escape. */
export const escapeLineSeparators = (json: string): string => json.replace(SEPARATORS, escapeOf);

/** One message as a line (without its newline), as strict mode writes it. */
export const strictLine = (value: unknown): string =>
  escapeLineSeparators(JSON.stringify(value) ?? '');
