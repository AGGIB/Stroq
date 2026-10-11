import {
  SHORT_SECRET_MIN,
  nameFacts,
  parameterFacts,
  secretUnderName,
} from './credential-names.js';
import { isQuote, isSpace, isStandIn, trimmed } from './credential-values.js';

/**
 * Names and the values written next to them, in text: a line of an env file (`NAME=VALUE`), an
 * assignment in front of a command (`MY_SECRET=abc node run.js`), a parameter of a URL
 * (`?exaApiKey=...`), a line of YAML or an HTTP header (`password: hunter2`).
 *
 * Plain scans over words, and every pattern anchored: the text is a config file that a repository
 * can commit. Each function takes time in proportion to the length of what it is given (a few
 * passes over it), and a name is read only up to a bound.
 */

const HASH = 0x23;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;
const COLON = 0x3a;
const DASH = 0x2d;

const isNameStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x2f;
const isNameChar = (code: number): boolean =>
  isNameStart(code) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2e ||
  code === COLON ||
  code === DASH;

/** The longest name an assignment or a header has; a longer run is text that has an `=` in it. */
const MAX_NAME_CHARS = 128;

/**
 * Whether `name` can be the name of a variable or a parameter: the letters, digits and signs a
 * name is made of (an npmrc scope path such as `//registry.npmjs.org/:_authToken` included), and
 * not the front of a URL.
 */
export function isPlainName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return false;
  if (!isNameStart(name.charCodeAt(0)) || name.includes('://')) return false;
  for (let i = 1; i < name.length; i += 1) if (!isNameChar(name.charCodeAt(i))) return false;
  return true;
}

/**
 * Whether `value`, written next to `name`, is a secret. The cheap questions are asked first: most
 * of the `NAME=value` pairs of a text are not secret, and the name is the dearer thing to read.
 */
export function secretUnderPair(name: string, value: string, inQuery: boolean): boolean {
  if (value.length < SHORT_SECRET_MIN || isStandIn(value)) return false;
  return secretUnderName(parameterFacts(name, inQuery), value);
}

// ---------------------------------------------------------------------------------------------
// NAME=VALUE at the start of a line

/** A `# comment` after a value that is not quoted. */
function withoutInlineComment(value: string): string {
  if (isQuote(value.charCodeAt(0))) return value;
  const space = value.indexOf(' #');
  const tab = value.indexOf('\t#');
  const at = space === -1 ? tab : tab === -1 ? space : Math.min(space, tab);
  return at > 0 ? value.slice(0, at).trim() : value;
}

function unquoted(value: string): string {
  const quote = value.charCodeAt(0);
  return isQuote(quote) && value.length >= 2 && value.charCodeAt(value.length - 1) === quote
    ? value.slice(1, -1)
    : value;
}

/** Commented-out credentials still belong to the owner: read past the comment marker. */
export function withoutCommentPrefix(line: string): string {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i += 1;
  const first = line.charCodeAt(i);
  return first === HASH || first === SEMICOLON ? line.slice(i + 1).trimStart() : line;
}

/** The first word of `value`: the shell reads `NAME=value rest` as the value, then a command. */
function firstWord(value: string): string {
  let end = 0;
  while (end < value.length && !isSpace(value.charCodeAt(end))) end += 1;
  return value.slice(0, end);
}

/**
 * Whether `line` is `NAME=VALUE` (dotenv, ini, npmrc; an `export` in front is fine) with a value
 * that is a credential under that name. A value that is not quoted ends at its first white space,
 * as in a shell: `MY_SECRET=abc123def456ghi789 node run.js` has a secret and a command.
 */
export function keyValueSecret(line: string): boolean {
  const n = line.length;
  let i = 0;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (i >= n) return false;
  if (line.startsWith('export', i) && isSpace(line.charCodeAt(i + 6))) {
    i += 6;
    while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  }
  const nameStart = i;
  if (!isNameStart(line.charCodeAt(i))) return false;
  i += 1;
  while (i < n && isNameChar(line.charCodeAt(i))) i += 1;
  const name = line.slice(nameStart, i);
  if (!isPlainName(name)) return false;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (line.charCodeAt(i) !== EQUALS) return false;
  i += 1;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  const rest = line.slice(i).trimEnd();
  if (rest === '') return false;
  const text = withoutInlineComment(rest);
  const value = unquoted(text);
  const facts = nameFacts(name);
  if (secretUnderName(facts, value)) return true;
  const word = value === text ? firstWord(text) : '';
  return word !== '' && word !== value && secretUnderName(facts, word);
}

// ---------------------------------------------------------------------------------------------
// NAME=VALUE anywhere: in front of a command, in an option, in a URL

/** What separates the parameters of a query string and its fragment, and commands. */
const PARAMETER_SEPARATORS = /[?&#;]/;

/** A wrapper such as `Bash(` is not part of the assignment's name. Never truncate a long name. */
function assignmentName(head: string): string {
  const text = trimmed(head);
  let start = text.length;
  while (start > 0 && isNameChar(text.charCodeAt(start - 1))) {
    start -= 1;
    if (text.length - start > MAX_NAME_CHARS) return '';
  }
  return text.slice(start);
}

/**
 * Whether `part` (a word, or a piece of one between `?`, `&`, `#` and `;`) is `NAME=VALUE` with a
 * secret value. `inQuery` is for the pieces after the first: a parameter of a URL.
 */
function partHoldsSecret(part: string, inQuery: boolean): boolean {
  let assignment = part;
  if (part.startsWith('-')) {
    // `--env=NAME=value`: the option is not the name. (`--token=value` is the flag reader's.)
    const equals = part.indexOf('=');
    if (equals === -1) return false;
    assignment = part.slice(equals + 1);
  }
  const equals = assignment.indexOf('=');
  if (equals <= 0) return false;
  const name = assignmentName(assignment.slice(0, equals));
  return isPlainName(name) && secretUnderPair(name, trimmed(assignment.slice(equals + 1)), inQuery);
}

/**
 * Whether any word of a text is an assignment of a secret: `DB_PASSWORD=devpass1 npm test`,
 * `docker run -e API_KEY=abcd1234`, `https://mcp.exa.ai/mcp?exaApiKey=...`. `words` are the white
 * space separated words of the text.
 */
export function assignmentSecret(words: readonly string[]): boolean {
  for (const word of words) {
    if (!word.includes('=')) continue;
    // The word as it is first: a password may hold a `&`, a `#` or a `;`.
    if (partHoldsSecret(word, false)) return true;
    if (!PARAMETER_SEPARATORS.test(word)) continue;
    const parts = word.split(PARAMETER_SEPARATORS);
    for (let i = 0; i < parts.length; i += 1) {
      if (partHoldsSecret(parts[i] ?? '', i > 0)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// name: value

/**
 * Whether `line` starts with `name: value` (YAML, an ini file, an HTTP header written out) with a
 * secret value. The name has to be the first word of the line, after a list dash: a colon in the
 * middle of a sentence is prose. A value on the next line is not read.
 */
export function leadingPairSecret(line: string): boolean {
  const n = line.length;
  let i = 0;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (line.charCodeAt(i) === DASH && isSpace(line.charCodeAt(i + 1))) {
    while (i < n && (line.charCodeAt(i) === DASH || isSpace(line.charCodeAt(i)))) i += 1;
  }
  const quote = isQuote(line.charCodeAt(i));
  if (quote) i += 1;
  const nameStart = i;
  while (i < n && isNameChar(line.charCodeAt(i)) && line.charCodeAt(i) !== COLON) i += 1;
  const name = line.slice(nameStart, i);
  if (quote && isQuote(line.charCodeAt(i))) i += 1;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (line.charCodeAt(i) !== COLON || !isPlainName(name)) return false;
  const rest = line.slice(i + 1).trim();
  if (rest === '' || rest.startsWith('//')) return false;
  return secretUnderPair(name, unquoted(withoutInlineComment(rest)), false);
}
