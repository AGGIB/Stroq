import { jsonTokens } from './json-tokens.js';

/**
 * Finding what a JSON file says that the object it parses to does not keep.
 *
 * The engine edits a file by parsing it, changing the object, and printing the object back. That
 * only changes what was asked if printing the parsed object, untouched, gives the same document
 * (up to layout). Three things in a document do not survive the trip, and each of them changes
 * the file in a place the edit never touched:
 *
 * - a number that a double cannot hold exactly (more digits than it keeps, or out of its range),
 *   which is printed as the nearest double;
 * - a key that appears twice in one object, of which only the last is kept;
 * - keys in an order a JavaScript object does not keep: the ones that are whole numbers come
 *   first, in numeric order, wherever the file put them.
 *
 * A file like that is refused, always. (Layout alone, such as a minified file, is not this: that
 * is a change the owner is asked about.)
 */

const NUMBER_PROBLEM =
  'a number in the file has more digits than a double holds, or is out of its range, so writing the file back would change it';
const DUPLICATE_PROBLEM =
  'an object in the file has the same key more than once, so writing the file back would drop all but the last';
const ORDER_PROBLEM =
  'an object in the file has number-like keys that a JavaScript object keeps in another order, so writing the file back would reorder them';

// ---------------------------------------------------------------------------------------------
// Numbers

interface Decimal {
  readonly negative: boolean;
  /** The significant digits, no leading and no trailing zeros; empty for zero. */
  readonly digits: string;
  /** The value is `digits` times ten to this power. */
  readonly exponent: number;
}

const isDigitCode = (code: number): boolean => code >= 0x30 && code <= 0x39;

/** A JSON number, or what `String(number)` prints, as digits and a power of ten. */
function decimalOf(text: string): Decimal {
  let i = 0;
  const negative = text.charCodeAt(0) === 0x2d;
  if (negative) i += 1;
  const intStart = i;
  while (isDigitCode(text.charCodeAt(i))) i += 1;
  const whole = text.slice(intStart, i);
  let fraction = '';
  if (text.charCodeAt(i) === 0x2e) {
    const fractionStart = i + 1;
    i = fractionStart;
    while (isDigitCode(text.charCodeAt(i))) i += 1;
    fraction = text.slice(fractionStart, i);
  }
  const exponentMark = (text.charCodeAt(i) | 0x20) === 0x65;
  const written = exponentMark ? Number(text.slice(i + 1)) : 0;
  const all = whole + fraction;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 0x30) start += 1;
  let end = all.length;
  while (end > start && all.charCodeAt(end - 1) === 0x30) end -= 1;
  return {
    negative,
    digits: all.slice(start, end),
    exponent: written - fraction.length + (all.length - end),
  };
}

const sameDecimal = (a: Decimal, b: Decimal): boolean =>
  a.digits === b.digits &&
  (a.digits === '' || (a.negative === b.negative && a.exponent === b.exponent));

/**
 * Whether the number written as `text` is not the number a double prints as. Layout does not count
 * (`1.0` and `1e2` are the numbers 1 and 100); digits do.
 */
function numberLoses(text: string): boolean {
  const number = Number(text);
  if (!Number.isFinite(number)) return true;
  const written = decimalOf(text);
  // Zero: either the number is zero, or it was so small that it became zero (it has digits left).
  // A negative zero prints as 0.
  if (number === 0) return written.digits !== '' || text.charCodeAt(0) === 0x2d;
  return !sameDecimal(written, decimalOf(String(number)));
}

// ---------------------------------------------------------------------------------------------
// Keys

const INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/;
/** The largest key an object treats as a position: 2^32 - 2. */
const MAX_INDEX = 4_294_967_294;

/** Per object: the keys seen, and what is needed to tell whether the order will survive. */
interface Keys {
  readonly seen: Set<string>;
  /** A key that is not a position has been seen: no position may follow it. */
  sawOther: boolean;
  /** The last position seen; positions come out in increasing order. */
  lastIndex: number;
}

/**
 * What is wrong with the way a JSON text can be written back, in a sentence that names no key and
 * no value, or `null` when nothing is. `text` must already parse as JSON.
 */
export function findLossyJson(text: string): string | null {
  const stack: (Keys | null)[] = [];
  for (const token of jsonTokens(text)) {
    if (token.kind === 'open') {
      stack.push(token.object ? { seen: new Set(), sawOther: false, lastIndex: -1 } : null);
    } else if (token.kind === 'close') {
      stack.pop();
    } else if (token.kind === 'number') {
      if (numberLoses(token.text)) return NUMBER_PROBLEM;
    } else if (token.kind === 'key') {
      const keys = stack[stack.length - 1];
      if (keys === null || keys === undefined) continue;
      if (keys.seen.has(token.value)) return DUPLICATE_PROBLEM;
      keys.seen.add(token.value);
      if (INDEX_KEY.test(token.value) && Number(token.value) <= MAX_INDEX) {
        if (keys.sawOther || Number(token.value) < keys.lastIndex) return ORDER_PROBLEM;
        keys.lastIndex = Number(token.value);
      } else {
        keys.sawOther = true;
      }
    }
  }
  return null;
}
