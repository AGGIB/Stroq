import {
  MAX_SCAN_CHARS,
  MIN_SECRET_LENGTH,
  candidatesFromText,
  detectPatterns,
  looksLikeToken,
} from '@stroq/core';
import {
  MAX_LINE_CHARS,
  authorizationValue,
  flagValueIsSecret,
  holdsNamedSecret,
  isAuthorizationName,
  isSecretFlag,
  privateKeyBlockLines,
  privateKeyHeaderIn,
  secretUnderName,
} from './credential-lines.js';
import { jsonTokens } from './json-tokens.js';

/**
 * Deciding whether a file holds credential-shaped text, and which of its lines do.
 *
 * Two questions are asked of a config file that belongs to someone else. Before a byte copy of it
 * is kept: would the copy be one more place a credential lives? And before a diff of it is
 * shown: would the diff print one? Both lean toward "yes, hide it" (a false alarm costs the copy,
 * or a line of the diff, and a miss costs a credential in one more place), and neither ever
 * returns any of the text.
 */

/** What kind of credential-shaped text a file holds. Never the text itself. */
export type CredentialShape =
  /** A token of a known vendor's shape (`ghp_`, `AKIA`, `sk-`, `npm_`, a JWT ...), anywhere. */
  | 'vendor-token'
  /** The header of a PEM private key. */
  | 'private-key'
  /**
   * A value that is not a location or a placeholder, under something that says it is a secret: a
   * name (`API_TOKEN=`, a JSON key), a flag (`--password`), a header (`Authorization: Bearer`) or
   * the front of a URL (`scheme://user:password@host`).
   */
  | 'named-secret'
  /** A payment card, an IBAN or a social security number, each checked by its own check digit. */
  | 'personal-data'
  /** Too large to be checked all the way through, which is not the same as clean. */
  | 'unchecked'
  /** Has a line too long for the line scanners to read, which is not the same as clean either. */
  | 'unchecked-line';

/**
 * Not emails (they are in every config that names its owner, and are not credentials) and not
 * phone numbers (a date is one). Cards, IBANs and social security numbers carry check digits, so
 * a hit is a fact and not a shape.
 */
const PERSONAL_KINDS: ReadonlySet<string> = new Set(['card', 'iban', 'ssn']);

const hasVendorToken = (text: string): boolean =>
  text.length >= MIN_SECRET_LENGTH &&
  candidatesFromText(text).some((candidate) => looksLikeToken(candidate.token));

const hasPersonalData = (text: string): boolean =>
  detectPatterns(text).some((span) => PERSONAL_KINDS.has(span.kind));

// ---------------------------------------------------------------------------------------------
// JSON documents: strings are read with the name above them.

/** A document that parses as an object or an array. Anything else is read line by line. */
function isJsonDocument(text: string): boolean {
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  const first = body.charCodeAt(0);
  const last = body.charCodeAt(body.length - 1);
  const opens = first === 0x7b || first === 0x5b;
  const closes = last === 0x7d || last === 0x5d;
  if (!opens || !closes) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/** Whether one string of a JSON document is a credential, by its name, its neighbour or its content. */
function stringHoldsCredential(name: string | null, value: string, before: string | null): boolean {
  if (name !== null && secretUnderName(name, value)) return true;
  // `{"Authorization": "Bearer abc..."}`: here the header's name is the key, not part of the text.
  if (name !== null && isAuthorizationName(name) && authorizationValue(value)) return true;
  // `["--password", "hunter2"]`: the flag and its value are two elements of one list.
  if (before !== null && isSecretFlag(before) && flagValueIsSecret(value)) return true;
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (privateKeyHeaderIn(value)) return true;
  return value.includes('\n')
    ? value.split('\n').some((line) => holdsNamedSecret(line, true))
    : holdsNamedSecret(value, true);
}

/**
 * Where the strings that hold a credential start, in a JSON document. A string is read with the
 * name it hangs under (the nearest key above it, which an array hands down to its items), and
 * with the string right before it when both are items of one list. Walked with stacks of its own:
 * a hostile file can be nested far deeper than the call stack.
 */
function* credentialStringsIn(text: string): Generator<number> {
  const isObject: boolean[] = [];
  const names: (string | null)[] = [];
  const before: (string | null)[] = [];
  for (const token of jsonTokens(text)) {
    const top = names.length - 1;
    if (token.kind === 'open') {
      // An array hands the name it hangs under (the key above it, or the one it inherited) down to
      // its items; an object's items get their names from their own keys.
      const inherited = top < 0 ? null : (names[top] ?? null);
      isObject.push(token.object);
      names.push(token.object ? null : inherited);
      before.push(null);
      if (top >= 0) before[top] = null;
    } else if (token.kind === 'close') {
      isObject.pop();
      names.pop();
      before.pop();
      if (top >= 1) before[top - 1] = null;
    } else if (token.kind === 'key') {
      if (top >= 0) names[top] = token.value;
    } else if (token.kind === 'string') {
      const name = top < 0 ? null : (names[top] ?? null);
      const neighbour = top >= 0 && isObject[top] === false ? (before[top] ?? null) : null;
      if (stringHoldsCredential(name, token.value, neighbour)) yield token.start;
      if (top >= 0) before[top] = token.value;
    } else if (top >= 0) {
      before[top] = null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The answer for a whole file.

type Named = 'found' | 'unchecked' | 'none';

/** Credentials under a name, a flag, a header or a URL: in a JSON document, or line by line. */
function namedSecretsIn(text: string): Named {
  if (isJsonDocument(text)) {
    for (const _start of credentialStringsIn(text)) return 'found';
    return 'none';
  }
  let unchecked = false;
  for (const line of text.split('\n')) {
    if (line.length > MAX_LINE_CHARS) unchecked = true;
    else if (holdsNamedSecret(line, true)) return 'found';
  }
  return unchecked ? 'unchecked' : 'none';
}

/**
 * What kind of credential-shaped text `text` holds, or `null` when it holds none. It never
 * throws and never returns any part of the text, and it reads in time linear in the text.
 */
export function findCredentialShape(text: string): CredentialShape | null {
  if (text.length > MAX_SCAN_CHARS) return 'unchecked';
  // The vendor shape goes first: the name-aware readers below also take such a value under any
  // name, and "a token of a known shape" is the more exact thing to say about it.
  if (hasVendorToken(text)) return 'vendor-token';
  if (privateKeyHeaderIn(text)) return 'private-key';
  const named = namedSecretsIn(text);
  if (named === 'found') return 'named-secret';
  if (hasPersonalData(text)) return 'personal-data';
  return named === 'unchecked' ? 'unchecked-line' : null;
}

// ---------------------------------------------------------------------------------------------
// The answer for a line.

/** Whether the line at `index` of the text this was made for must not be shown. */
export type LineMask = (index: number, line: string) => boolean;

const lineHoldsCredential = (line: string, keyValue: boolean): boolean =>
  hasVendorToken(line) ||
  hasPersonalData(line) ||
  privateKeyHeaderIn(line) ||
  holdsNamedSecret(line, keyValue);

/** The offset of the first character of each line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

/** The index of the line that holds `offset`: the last line that starts at or before it. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Which lines of `text` hold something that must not be printed. A line is asked about only when
 * it is about to be shown, so a file with a handful of changes costs a handful of lines.
 *
 * - In a JSON document the answer comes from the walk above (a value is a credential by the name
 *   above it, which no single line shows), plus what any one line can show on its own.
 * - In plain text a line is hidden when it holds a credential, when it is too long to be read, or
 *   when it is inside a PEM private key, whose body is only base64.
 */
export function hiddenLineMask(text: string): LineMask {
  if (isJsonDocument(text)) {
    const starts = lineStarts(text);
    const flagged = new Set<number>();
    for (const start of credentialStringsIn(text)) flagged.add(lineOf(starts, start));
    return (index, line) => flagged.has(index) || lineHoldsCredential(line, false);
  }
  const inKey = privateKeyBlockLines(text.split('\n'));
  return (index, line) =>
    inKey.has(index) || line.length > MAX_LINE_CHARS || lineHoldsCredential(line, true);
}
