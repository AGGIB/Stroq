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
  isSecretFlag,
  privateKeyBlockLines,
  privateKeyHeaderIn,
} from './credential-lines.js';
import { nameFacts, secretUnderName, type NameFacts } from './credential-names.js';
import { jsonTokens } from './json-tokens.js';

/**
 * Deciding whether a file holds credential-shaped text, and which of its lines do.
 *
 * Two questions are asked of a config file that belongs to someone else. Before a byte copy of it
 * is kept: would the copy be one more place a credential lives? And before a diff of it is
 * shown: would the diff print one? Both lean toward "yes, hide it" (a false alarm costs the copy,
 * or a line of the diff, and a miss costs a credential in one more place), and neither ever
 * returns any of the text.
 *
 * The file is someone else's, and a repository can commit it, so the work is bounded. Plain text
 * is read line by line, and a line above `MAX_LINE_CHARS` is not read. A JSON document is read
 * string by string with the name above each string, and three limits (`SCAN_LIMITS`) bound it: a
 * key longer than any key is, more strings than any config holds, and a total of characters
 * examined. A document that goes past one is reported as unchecked, which is not the same as clean.
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
function stringHoldsCredential(
  facts: NameFacts | null,
  value: string,
  before: string | null,
): boolean {
  if (facts !== null && secretUnderName(facts, value)) return true;
  // `{"Authorization": "Bearer abc..."}`: here the header's name is the key, not part of the text.
  if (facts !== null && facts.authorization && authorizationValue(value)) return true;
  // `["--password", "hunter2"]`: the flag and its value are two elements of one list.
  if (before !== null && isSecretFlag(before) && flagValueIsSecret(value)) return true;
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (privateKeyHeaderIn(value)) return true;
  return value.includes('\n')
    ? value.split('\n').some((line) => holdsNamedSecret(line, true))
    : holdsNamedSecret(value, true);
}

/**
 * What bounds the reading of a JSON document. Real configs are far inside all three; a file that
 * is not one is reported as unchecked instead of being read further.
 */
export interface ScanLimits {
  /** The longest key a document may have. A name is read once per key, and this bounds that. */
  readonly maxKeyChars: number;
  /** The most strings (values and items of lists, not keys) a document may hold. */
  readonly maxStrings: number;
  /**
   * The most characters of keys and strings that are looked at in all, counted as they are read
   * (plus one for each, so that a million empty strings are not free). A file is never longer than
   * `MAX_SCAN_CHARS`, so with the default this is a backstop: it is what keeps the cost of a read
   * bounded if a reader is ever made to look at a string more than once.
   */
  readonly maxExamined: number;
}

export const SCAN_LIMITS: ScanLimits = {
  maxKeyChars: 512,
  maxStrings: 50_000,
  maxExamined: MAX_SCAN_CHARS,
};

/** What reading the strings of a JSON document found. */
interface JsonScan {
  /** Where the strings that hold a credential start. */
  readonly starts: readonly number[];
  /** Where reading stopped because it passed a limit, or `null` when everything was read. */
  readonly stoppedAt: number | null;
}

/**
 * Reads the strings of a JSON document. A string is read with the name it hangs under (the nearest
 * key above it, which an array hands down to its items; the name is judged where the key is, once),
 * and with the string right before it when both are items of one list. Walked with stacks of its
 * own: a hostile file can be nested far deeper than the call stack. With `firstOnly` it stops at
 * the first credential.
 */
function scanJsonStrings(text: string, limits: ScanLimits, firstOnly: boolean): JsonScan {
  const starts: number[] = [];
  const isObject: boolean[] = [];
  const names: (NameFacts | null)[] = [];
  const before: (string | null)[] = [];
  let strings = 0;
  let examined = 0;
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
      examined += token.value.length + 1;
      if (token.value.length > limits.maxKeyChars || examined > limits.maxExamined) {
        return { starts, stoppedAt: token.start };
      }
      if (top >= 0) names[top] = nameFacts(token.value);
    } else if (token.kind === 'string') {
      strings += 1;
      examined += token.value.length + 1;
      if (strings > limits.maxStrings || examined > limits.maxExamined) {
        return { starts, stoppedAt: token.start };
      }
      const facts = top < 0 ? null : (names[top] ?? null);
      const neighbour = top >= 0 && isObject[top] === false ? (before[top] ?? null) : null;
      if (stringHoldsCredential(facts, token.value, neighbour)) {
        starts.push(token.start);
        if (firstOnly) return { starts, stoppedAt: null };
      }
      if (top >= 0) before[top] = token.value;
    } else if (top >= 0) {
      before[top] = null;
    }
  }
  return { starts, stoppedAt: null };
}

// ---------------------------------------------------------------------------------------------
// The answer for a whole file.

type Named = 'found' | 'none' | 'unchecked' | 'unchecked-line';

/** Credentials under a name, a flag, a header or a URL: in a JSON document, or line by line. */
function namedSecretsIn(text: string, limits: ScanLimits): Named {
  if (isJsonDocument(text)) {
    const scan = scanJsonStrings(text, limits, true);
    if (scan.starts.length > 0) return 'found';
    return scan.stoppedAt === null ? 'none' : 'unchecked';
  }
  let unchecked = false;
  for (const line of text.split('\n')) {
    if (line.length > MAX_LINE_CHARS) unchecked = true;
    else if (holdsNamedSecret(line, true)) return 'found';
  }
  return unchecked ? 'unchecked-line' : 'none';
}

/**
 * What kind of credential-shaped text `text` holds, or `null` when it holds none. It never
 * throws and never returns any part of the text. The work is bounded by the length of the text and
 * by `limits`; what it could not read all the way through is `unchecked`, and not `null`.
 */
export function findCredentialShape(
  text: string,
  limits: ScanLimits = SCAN_LIMITS,
): CredentialShape | null {
  if (text.length > MAX_SCAN_CHARS) return 'unchecked';
  // The vendor shape goes first: the name-aware readers below also take such a value under any
  // name, and "a token of a known shape" is the more exact thing to say about it.
  if (hasVendorToken(text)) return 'vendor-token';
  if (privateKeyHeaderIn(text)) return 'private-key';
  const named = namedSecretsIn(text, limits);
  if (named === 'found') return 'named-secret';
  if (hasPersonalData(text)) return 'personal-data';
  return named === 'none' ? null : named;
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
export function hiddenLineMask(text: string, limits: ScanLimits = SCAN_LIMITS): LineMask {
  if (isJsonDocument(text)) {
    const starts = lineStarts(text);
    const scan = scanJsonStrings(text, limits, false);
    const flagged = new Set(scan.starts.map((start) => lineOf(starts, start)));
    // Reading stopped at a limit: nothing from that line on was looked at, so none of it is shown.
    const unread = scan.stoppedAt === null ? Infinity : lineOf(starts, scan.stoppedAt);
    return (index, line) =>
      index >= unread || flagged.has(index) || lineHoldsCredential(line, false);
  }
  const inKey = privateKeyBlockLines(text.split('\n'));
  return (index, line) =>
    inKey.has(index) || line.length > MAX_LINE_CHARS || lineHoldsCredential(line, true);
}
