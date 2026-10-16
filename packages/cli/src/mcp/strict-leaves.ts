import {
  STRICT_COPY_MAX_CHARS,
  STRICT_COPY_SEPARATOR,
  STRICT_COPY_STRING_CHARS,
  STRICT_MAX_DEPTH,
  STRICT_MAX_TEXT_CHARS,
} from './strict-limits.js';

/**
 * The text strict mode scans, made of the strings a message CARRIES.
 *
 * Every string value and every object key, in document order, one per line. Never JSON:
 * the scanner reads a sentence, and the JSON form of a field escapes a line break or a tab
 * between its words into a backslash and a letter, which turns a sentence the model reads
 * as one into text the rules do not. Keys are leaves too, since a key is a string the
 * client is handed. Numbers, booleans and null carry no text and add none.
 *
 * Only the payload of a binary item that `strict-media.ts` recognised is left out, and
 * which payload that is a caller says by record identity, not by name: a field called
 * `data` or `blob` anywhere else is text like any other.
 *
 * AFTER the decoded strings comes a separator line and a clipped serialised copy of the
 * same structure. Some bundled rules (about forty of 621) are written for the JSON a
 * server's result is made of: `"query"\s*:\s*"...'; DROP TABLE` is a key and its value
 * side by side, and in a list of decoded strings they are two lines. The default proxy
 * reads the JSON form of `structuredContent`, of an input schema and of annotations, so
 * those rules fire there; strict mode must scan at least what the default scans, hence the
 * copy. It is clipped (strings to 2,000 characters, the whole to 32 KiB) and added only as
 * far as the window leaves room, so it never makes a text that fits look cut short: the
 * window is decided on the decoded strings alone, as it always was.
 */

/** Records whose value under the given key is a classified media payload, to leave out. */
export type MediaPayloads = ReadonlyMap<object, string>;

export const NO_MEDIA: MediaPayloads = new Map();

/**
 * The leaves of `value` in document order, or null when it nests deeper than
 * `STRICT_MAX_DEPTH`. Iterative: the structure is a server's, and a recursive walk of
 * one nested a hundred thousand deep would overflow the stack instead of answering.
 */
export function collectLeaves(value: unknown, media: MediaPayloads = NO_MEDIA): string[] | null {
  const leaves: string[] = [];
  // A stack of [node, depth]. Children are pushed in reverse so they pop in order, and
  // a key is pushed after its value so that it pops first.
  const stack: [unknown, number][] = [[value, 0]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [node, depth] = top;
    if (typeof node === 'string') {
      leaves.push(node);
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    if (depth >= STRICT_MAX_DEPTH) return null;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], depth + 1]);
      continue;
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    const payloadKey = media.get(record);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const key = keys[i] as string;
      if (key !== payloadKey) stack.push([record[key], depth + 1]);
      stack.push([key, depth + 1]);
    }
  }
  return leaves;
}

/**
 * The clipped serialised copy of `value`: JSON, strings cut to `STRICT_COPY_STRING_CHARS`,
 * the whole cut to `STRICT_COPY_MAX_CHARS`. Keys are kept (they are part of the JSON), and
 * the payload of a recognised media record is replaced by a fixed marker so the copy keeps
 * the shape without carrying megabytes of base64. Plain `JSON.stringify` with a replacer:
 * the structure was already walked to its depth bound, so it cannot overflow the stack.
 */
export function clippedCopy(value: unknown, media: MediaPayloads = NO_MEDIA): string {
  const json = JSON.stringify(value, function (this: unknown, key: string, member: unknown) {
    if (typeof this === 'object' && this !== null && media.get(this) === key) return '[media]';
    return typeof member === 'string' && member.length > STRICT_COPY_STRING_CHARS
      ? member.slice(0, STRICT_COPY_STRING_CHARS)
      : member;
  });
  return (json ?? '').slice(0, STRICT_COPY_MAX_CHARS);
}

/**
 * What follows the decoded strings in the scan text when they are `leafLength` characters
 * long: the separator line and the copy, as far as the window leaves room, or nothing.
 */
export function copyTail(value: unknown, media: MediaPayloads, leafLength: number): string {
  const room = STRICT_MAX_TEXT_CHARS - leafLength;
  if (room <= STRICT_COPY_SEPARATOR.length) return '';
  // An empty object or array (a ping answer) has nothing to read and no copy either.
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return '';
  const copy = clippedCopy(value, media);
  return copy === '' ? '' : `${STRICT_COPY_SEPARATOR}${copy}`.slice(0, room);
}

/**
 * The post-condition: whether `text` is exactly the scan text of `value`. Run on the
 * structure that is about to be delivered, after the text was built and before anything
 * is sent, so the invariant strict mode exists for (every string the client is given was
 * scanned) is checked at the last moment rather than assumed from how the text was made.
 * A string that is in the message and not in the text, a text that has a string the
 * message lacks, or a different order, all fail it.
 *
 * The text has two parts and both are checked against the structure. The first is the
 * decoded strings: a second, separate walk (recursive, with a cursor over `text`) rather
 * than a call to `collectLeaves`, so that a change to one cannot silently change what the
 * other agrees to; linear, each string matched in place, never searched for. The second is
 * the serialised copy, which must be exactly what `copyTail` makes of this structure: a
 * copy of anything else (or a different amount of it) fails.
 */
export function isCovered(value: unknown, media: MediaPayloads, text: string): boolean {
  let cursor = 0;
  let first = true;
  const take = (leaf: string): boolean => {
    if (!first) {
      if (text.charCodeAt(cursor) !== 10) return false;
      cursor += 1;
    }
    first = false;
    if (!text.startsWith(leaf, cursor)) return false;
    cursor += leaf.length;
    return true;
  };
  const walk = (node: unknown, depth: number): boolean => {
    if (typeof node === 'string') return take(node);
    if (node === null || typeof node !== 'object') return true;
    if (depth >= STRICT_MAX_DEPTH) return false;
    if (Array.isArray(node)) return node.every((item) => walk(item, depth + 1));
    const record = node as Record<string, unknown>;
    const payloadKey = media.get(record);
    return Object.keys(record).every(
      (key) => take(key) && (key === payloadKey || walk(record[key], depth + 1)),
    );
  };
  if (!walk(value, 0)) return false;
  return text.slice(cursor) === copyTail(value, media, cursor);
}

/** The decoded strings of `value`, a real newline between them; null when too deep. */
export function leafText(value: unknown, media: MediaPayloads = NO_MEDIA): string | null {
  const leaves = collectLeaves(value, media);
  return leaves === null ? null : leaves.join('\n');
}

/**
 * The whole scan text for `value`: the decoded strings, then the separator and the copy as
 * far as the window leaves room. Null when it nests too deep.
 */
export function scanText(value: unknown, media: MediaPayloads = NO_MEDIA): string | null {
  const leaves = leafText(value, media);
  return leaves === null ? null : leaves + copyTail(value, media, leaves.length);
}
