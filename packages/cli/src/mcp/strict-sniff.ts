import { asJsonRpcId, type JsonRpcId } from './framing.js';
import { STRICT_ID_CHARS, STRICT_ID_DIGITS, STRICT_ID_SNIFF_CHARS } from './strict-limits.js';

/**
 * Finding the request a message that could not be parsed was answering.
 *
 * A line that is not JSON (or is past the size Stroq parses) cannot be tied to its
 * request by parsing, and a request left unanswered is a client left waiting. So the head
 * of the line is read, token by token, for the TOP-LEVEL `id` member, and the result is
 * used only to look up a request that is waiting: a wrong answer costs one waiting request
 * an early error from Stroq, never a message to anyone.
 *
 * The scan is linear in the window and tracks nesting and strings, so an `"id"` inside a
 * nested value or inside a string is not taken for the top-level one. What it cannot do is
 * look past the window: an id member that comes after the first `STRICT_ID_SNIFF_CHARS`
 * characters is not found, and the message is then dropped and audited with nobody to
 * answer. An id is accepted only if it could be one a client chose: an integer of at most
 * fifteen digits with nothing after it that makes it a fraction or an exponent, or a plain
 * string of up to `STRICT_ID_CHARS` characters with no escape in it.
 */

/** Whitespace, and the byte-order mark a few servers write before their JSON. */
const BLANK = /[\s﻿]/;
const INTEGER = new RegExp(`-?(?:0|[1-9]\\d{0,${STRICT_ID_DIGITS - 1}})(?![\\d.eE+-])`, 'y');

/** The index of the quote that closes the string opened at `open`, or -1 if the window ends first. */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '"') return i;
  }
  return -1;
}

function skipBlanks(text: string, from: number): number {
  let i = from;
  while (i < text.length && BLANK.test(text[i] as string)) i += 1;
  return i;
}

/** The id whose value starts at `at`, if it is one a client could have chosen. */
function idAt(text: string, at: number): JsonRpcId | null {
  if (text[at] === '"') {
    const end = stringEnd(text, at);
    if (end === -1) return null;
    const body = text.slice(at + 1, end);
    if (body.includes('\\') || body.length > STRICT_ID_CHARS) return null;
    return asJsonRpcId(body);
  }
  INTEGER.lastIndex = at;
  const found = INTEGER.exec(text);
  return found === null ? null : asJsonRpcId(Number(found[0]));
}

export function sniffId(head: string): JsonRpcId | null {
  const window = head.slice(0, STRICT_ID_SNIFF_CHARS);
  let i = skipBlanks(window, 0);
  if (window[i] === '[') i = skipBlanks(window, i + 1);
  if (window[i] !== '{') return null;
  let depth = 0;
  while (i < window.length) {
    const c = window[i];
    if (c === '"') {
      const end = stringEnd(window, i);
      if (end === -1) return null;
      if (depth === 1 && window.slice(i + 1, end) === 'id') {
        const colon = skipBlanks(window, end + 1);
        if (window[colon] === ':') return idAt(window, skipBlanks(window, colon + 1));
      }
      i = end + 1;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth <= 0) return null;
    }
    i += 1;
  }
  return null;
}
