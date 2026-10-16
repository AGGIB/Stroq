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

/** The scan text for `value`: its leaves, a real newline between them; null when too deep. */
export function leafText(value: unknown, media: MediaPayloads = NO_MEDIA): string | null {
  const leaves = collectLeaves(value, media);
  return leaves === null ? null : leaves.join('\n');
}
