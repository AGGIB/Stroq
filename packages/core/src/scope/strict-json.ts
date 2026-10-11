/**
 * JSON for a file that carries a signature, read the way a signature needs it read.
 *
 * `JSON.parse` has two habits that a signed document cannot have. It keeps the LAST of two
 * equal keys without a word, so `{"body": <what was signed>, "body": <what was swapped in>}`
 * and its reverse are read differently by a parser that keeps the first, and by a person who
 * reads from the top. And it makes `__proto__` an own property, which the next spread or merge
 * in someone's code turns into a prototype. Both are refused here, at any depth, so that what
 * the signature covers is the only reading there is.
 */

export type StrictJsonProblem = 'syntax' | 'duplicate-key' | 'forbidden-key' | 'too-deep';

export type StrictParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: StrictJsonProblem };

/** Keys that mean something to the object model of the language, not to a permit. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A permit nests about six levels. Anything near this is not one. */
export const MAX_JSON_DEPTH = 32;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;

interface Frame {
  /** Keys seen so far in this object; null for an array. */
  readonly keys: Set<string> | null;
  /** True while the next string in this object is a key and not a value. */
  expectKey: boolean;
}

/**
 * Walks text that `JSON.parse` has already accepted, so the structure is known to be well
 * formed and only the keys need looking at. One pass, no recursion: the depth is a counter,
 * and a key is decoded by the JSON parser itself, so `"a"` and `"a"` are the same key
 * here as they are to everyone else.
 */
function findKeyProblem(text: string): StrictJsonProblem | null {
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      let end = i + 1;
      while (text.charCodeAt(end) !== QUOTE) end += text.charCodeAt(end) === BACKSLASH ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (FORBIDDEN_KEYS.has(key)) return 'forbidden-key';
        if (top.keys.has(key)) return 'duplicate-key';
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      if (stack.length >= MAX_JSON_DEPTH) return 'too-deep';
      stack.push(
        code === OPEN_BRACE
          ? { keys: new Set<string>(), expectKey: true }
          : { keys: null, expectKey: false },
      );
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      stack.pop();
    } else if (code === COMMA) {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    }
    i += 1;
  }
  return null;
}

export function parseStrictJson(text: string): StrictParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'syntax' };
  }
  const problem = findKeyProblem(text);
  return problem === null ? { ok: true, value } : { ok: false, reason: problem };
}
