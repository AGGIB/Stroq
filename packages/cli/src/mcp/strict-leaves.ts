import { STRICT_MAX_DEPTH } from './strict-limits.js';

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
 * The post-condition: whether `text` is exactly the scan text of `value`. Run on the
 * structure that is about to be delivered, after the text was built and before anything
 * is sent, so the invariant strict mode exists for (every string the client is given was
 * scanned) is checked at the last moment rather than assumed from how the text was made.
 * A string that is in the message and not in the text, a text that has a string the
 * message lacks, or a different order, all fail it.
 *
 * Written as a second, separate walk (recursive, with a cursor over `text`) rather than a
 * call to `collectLeaves`, so that a change to one cannot silently change what the other
 * agrees to. Linear in the size of the message: each string is matched in place, never
 * searched for.
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
  return walk(value, 0) && cursor === text.length;
}

/** The scan text for `value`: its leaves, a real newline between them; null when too deep. */
export function leafText(value: unknown, media: MediaPayloads = NO_MEDIA): string | null {
  const leaves = collectLeaves(value, media);
  return leaves === null ? null : leaves.join('\n');
}
