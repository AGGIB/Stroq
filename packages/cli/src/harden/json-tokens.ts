/**
 * The tokens of a JSON text, in order, with where each one starts.
 *
 * It exists for two readers that need what `JSON.parse` throws away: where a value sits in the
 * file (so that a line of a diff can be hidden), and what the file said before it became an
 * object (a key that appears twice, the order the keys came in, a number as it was written). It is
 * meant for text that has already parsed: it does not check the grammar, it only never loops,
 * never recurses and never reads past the end, whatever it is given. One pass, no backtracking,
 * and a stack of its own, so a document nested far deeper than the call stack is only long.
 */

export type JsonToken =
  | { readonly kind: 'open'; readonly object: boolean; readonly start: number }
  | { readonly kind: 'close'; readonly start: number }
  /** A string in the position of an object's key. `value` is the key itself, unescaped. */
  | { readonly kind: 'key'; readonly value: string; readonly start: number }
  /** A string anywhere else. `value` is unescaped. */
  | { readonly kind: 'string'; readonly value: string; readonly start: number }
  /** A number, as it was written. */
  | { readonly kind: 'number'; readonly text: string; readonly start: number }
  /** `true`, `false` or `null`. */
  | { readonly kind: 'word'; readonly start: number };

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isLetter = (code: number): boolean => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
/** Every character a number is made of: digits, a sign, a point and an exponent mark. */
const isNumberChar = (code: number): boolean =>
  isDigit(code) || code === MINUS || code === PLUS || code === DOT || (code | 0x20) === 0x65;

/**
 * A string token's text, unescaped. `end` is where the closing quote is, or at least `text.length`
 * for a string that never closes; such a string, and one that cannot be unescaped, gives the raw
 * text after its opening quote.
 */
function stringValue(text: string, quote: number, end: number): string {
  const inner = text.slice(quote + 1, Math.min(end, text.length));
  if (!inner.includes('\\') || end >= text.length) return inner;
  try {
    return JSON.parse(text.slice(quote, end + 1)) as string;
  } catch {
    return inner;
  }
}

export function* jsonTokens(text: string): Generator<JsonToken> {
  // One entry per open container: is it an object, and is it waiting for a key.
  const isObject: boolean[] = [];
  const awaitingKey: boolean[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      let end = i + 1;
      while (end < n) {
        const c = text.charCodeAt(end);
        if (c === BACKSLASH) end += 2;
        else if (c === QUOTE) break;
        else end += 1;
      }
      const value = stringValue(text, i, end);
      const last = isObject.length - 1;
      if (last >= 0 && isObject[last] === true && awaitingKey[last] === true) {
        awaitingKey[last] = false;
        yield { kind: 'key', value, start: i };
      } else {
        yield { kind: 'string', value, start: i };
      }
      i = end + 1;
    } else if (code === LEFT_BRACE || code === LEFT_BRACKET) {
      isObject.push(code === LEFT_BRACE);
      awaitingKey.push(code === LEFT_BRACE);
      yield { kind: 'open', object: code === LEFT_BRACE, start: i };
      i += 1;
    } else if (code === RIGHT_BRACE || code === RIGHT_BRACKET) {
      isObject.pop();
      awaitingKey.pop();
      yield { kind: 'close', start: i };
      i += 1;
    } else if (code === COMMA) {
      const last = isObject.length - 1;
      if (last >= 0 && isObject[last] === true) awaitingKey[last] = true;
      i += 1;
    } else if (code === COLON) {
      const last = isObject.length - 1;
      if (last >= 0) awaitingKey[last] = false;
      i += 1;
    } else if (code === MINUS || isDigit(code)) {
      let end = i + 1;
      while (end < n && isNumberChar(text.charCodeAt(end))) end += 1;
      yield { kind: 'number', text: text.slice(i, end), start: i };
      i = end;
    } else if (isLetter(code)) {
      let end = i + 1;
      while (end < n && isLetter(text.charCodeAt(end))) end += 1;
      yield { kind: 'word', start: i };
      i = end;
    } else {
      // White space, a byte order mark, or anything else a text that did not parse might hold.
      i += 1;
    }
  }
}
