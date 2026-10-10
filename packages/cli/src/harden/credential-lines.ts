import { extractEnv } from '@stroq/core';

/**
 * Credential-shaped text, found one line (or one string) at a time, in time linear in its length.
 *
 * Everything here is read with plain scans and anchored, unambiguous patterns, because the text is
 * a config file that a repository can commit, and a pattern that backtracks on a long run of
 * spaces is a way to hang the command that reads it (the `NAME=VALUE` pattern core uses for
 * `.env` files is quadratic on exactly that, which is why it is not used here).
 *
 * "Credential-shaped" is a heuristic that leans toward yes: a false alarm costs a byte copy, and a
 * miss costs a credential in one more place. None of these functions returns any of the text.
 */

/**
 * Lines longer than this are not read by the line scanners. A real `.env`, ini or npmrc line is
 * far shorter, and the scanners' work per line is bounded by it. A line that long is reported as
 * unchecked instead, which is not the same as clean.
 */
export const MAX_LINE_CHARS = 4096;

const TAB = 9;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const HASH = 0x23;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;

/** The characters `\s` stands for in a pattern. */
const isSpace = (code: number): boolean =>
  code === SPACE ||
  (code >= TAB && code <= CARRIAGE_RETURN) ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

const isNameStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x2f;
const isNameChar = (code: number): boolean =>
  isNameStart(code) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2e ||
  code === 0x3a ||
  code === 0x2d;

// ---------------------------------------------------------------------------------------------
// NAME=VALUE

/** A `# comment` after a value that is not quoted. */
function withoutInlineComment(value: string): string {
  const first = value.charCodeAt(0);
  if (first === 0x22 || first === 0x27) return value;
  const space = value.indexOf(' #');
  const tab = value.indexOf('\t#');
  const at = space === -1 ? tab : tab === -1 ? space : Math.min(space, tab);
  return at > 0 ? value.slice(0, at).trim() : value;
}

function unquoted(value: string): string {
  const quote = value.charCodeAt(0);
  const isQuote = quote === 0x22 || quote === 0x27;
  return isQuote && value.length >= 2 && value.charCodeAt(value.length - 1) === quote
    ? value.slice(1, -1)
    : value;
}

/**
 * Whether `line` is `NAME=VALUE` (dotenv, ini, npmrc; an `export` in front is fine) with a value
 * that is a credential under that name. The same question core asks of an environment, answered
 * by `extractEnv`; only the splitting of the line is done here.
 */
export function keyValueSecret(line: string): boolean {
  const n = line.length;
  let i = 0;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (i >= n) return false;
  const first = line.charCodeAt(i);
  if (first === HASH || first === SEMICOLON) return false;
  if (line.startsWith('export', i) && isSpace(line.charCodeAt(i + 6))) {
    i += 6;
    while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  }
  const nameStart = i;
  if (!isNameStart(line.charCodeAt(i))) return false;
  i += 1;
  while (i < n && isNameChar(line.charCodeAt(i))) i += 1;
  const name = line.slice(nameStart, i);
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  if (line.charCodeAt(i) !== EQUALS) return false;
  i += 1;
  while (i < n && isSpace(line.charCodeAt(i))) i += 1;
  const rest = line.slice(i).trimEnd();
  if (rest === '') return false;
  return extractEnv({ [name]: unquoted(withoutInlineComment(rest)) }).length > 0;
}

// ---------------------------------------------------------------------------------------------
// Values that are not credentials however they are spelled.

/**
 * Something that stands in for a value: a template, a reference to an environment variable, a
 * path, a flag, a word every document uses for an example. Matched at the start of the value only,
 * so the cost is the length of the value at most.
 */
const NOT_A_VALUE =
  /^(?:[<$%{@~/-]|\.{1,2}\/|\*+$|x{3,}$|(?:change|replace)[-_]?me|todo|example|sample|dummy|placeholder|your[-_]|(?:pass(?:word|wd)?|secret|token|key)$)/i;

/**
 * A value that a name or a flag says is secret: long enough to be one, in one piece, and not a
 * stand-in. `minLength` is shorter than core's for values whose position says they are secret.
 */
function opaque(value: string, minLength: number): boolean {
  if (value.length < minLength) return false;
  for (let i = 0; i < value.length; i += 1) if (isSpace(value.charCodeAt(i))) return false;
  return !NOT_A_VALUE.test(value);
}

const FLAG_VALUE_MIN = 6;
const AUTH_TOKEN_MIN = 8;
const URL_PASSWORD_MIN = 4;
const URL_TOKEN_MIN = 20;

// ---------------------------------------------------------------------------------------------
// `--password hunter2` and `--token=abc`

/** The flags whose value is a secret, spelled the way `--api_key` and `--API-KEY` are normalised. */
const SECRET_FLAGS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'token',
  'api-key',
  'apikey',
  'secret',
  'client-secret',
  'access-token',
  'auth-token',
  'bearer-token',
  'secret-key',
  'access-key',
  'private-key',
]);

/** `--API_Key` as `api-key`: the name of a flag, which is not the name of a variable. */
function flagName(token: string): string {
  return token.replace(/^-+/, '').replace(/_/g, '-').toLowerCase();
}

/** Quotes, commas and brackets around a word that is one element of an argument list. */
const isWrapper = (code: number): boolean =>
  isSpace(code) ||
  code === 0x22 ||
  code === 0x27 ||
  code === 0x60 ||
  code === 0x2c ||
  code === 0x3b ||
  code === 0x5b ||
  code === 0x5d ||
  code === 0x28 ||
  code === 0x29 ||
  code === 0x7b ||
  code === 0x7d;

/**
 * `word` without the wrapping characters at either end. Two plain scans: a pattern with `+$` in
 * it is quadratic on a long run of the characters it trims.
 */
function trimmed(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && isWrapper(word.charCodeAt(start))) start += 1;
  while (end > start && isWrapper(word.charCodeAt(end - 1))) end -= 1;
  return word.slice(start, end);
}

/** Whether `flag` (a whole argument, as written) is one whose value is a secret. */
export function isSecretFlag(flag: string): boolean {
  return flag.startsWith('--') && SECRET_FLAGS.has(flagName(flag));
}

/** Whether `value`, found right after a secret flag, is a secret and not a stand-in. */
export const flagValueIsSecret = (value: string): boolean => opaque(value, FLAG_VALUE_MIN);

/**
 * Whether `text` holds a secret flag with a secret value after it, as separate words
 * (`--password hunter2`) or joined (`--token=abc123`).
 */
export function flagSecretInText(text: string): boolean {
  if (!text.includes('--')) return false;
  const words = text.split(/\s+/);
  for (let k = 0; k < words.length; k += 1) {
    const word = trimmed(words[k] ?? '');
    if (!word.startsWith('--')) continue;
    const equals = word.indexOf('=');
    if (!isSecretFlag(equals === -1 ? word : word.slice(0, equals))) continue;
    const value = equals === -1 ? trimmed(words[k + 1] ?? '') : trimmed(word.slice(equals + 1));
    if (flagValueIsSecret(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// `Authorization: Bearer <token>`

const AUTHORIZATION = 'authorization';
/** Between the name of the header and its scheme: a colon, a quote, a space or two. */
const MAX_HEADER_GAP = 8;

const isGap = (code: number): boolean =>
  isSpace(code) || code === 0x22 || code === 0x27 || code === 0x3a || code === EQUALS;
/** What an opaque token is made of: base64, base64url, and the punctuation of a JWT or an API key. */
const isTokenChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x2e ||
  code === 0x5f ||
  code === 0x7e ||
  code === 0x2b ||
  code === 0x2f ||
  code === EQUALS ||
  code === 0x2d;

/**
 * Whether `lower` (already in lower case) has, from `from` on, a Bearer or Basic scheme followed
 * by an opaque token, after at most a few characters of punctuation and white space.
 */
function schemeToken(lower: string, from: number): boolean {
  let i = from;
  const gapEnd = i + MAX_HEADER_GAP;
  while (i < gapEnd && i < lower.length && isGap(lower.charCodeAt(i))) i += 1;
  const scheme = lower.startsWith('bearer', i) ? 6 : lower.startsWith('basic', i) ? 5 : 0;
  if (scheme === 0) return false;
  i += scheme;
  if (!isSpace(lower.charCodeAt(i))) return false;
  while (i < lower.length && isSpace(lower.charCodeAt(i))) i += 1;
  let end = i;
  while (end < lower.length && isTokenChar(lower.charCodeAt(end))) end += 1;
  return opaque(lower.slice(i, end), AUTH_TOKEN_MIN);
}

/**
 * Whether `text` has an `Authorization` header (any case; `Proxy-Authorization` too) whose scheme
 * is Bearer or Basic and whose credential is an opaque token. "Basic" and "bearer" are ordinary
 * words, so the header's name has to be there too.
 */
export function authorizationSecret(text: string): boolean {
  if (text.length < AUTHORIZATION.length + AUTH_TOKEN_MIN) return false;
  const lower = text.toLowerCase();
  for (
    let at = lower.indexOf(AUTHORIZATION);
    at !== -1;
    at = lower.indexOf(AUTHORIZATION, at + AUTHORIZATION.length)
  ) {
    if (schemeToken(lower, at + AUTHORIZATION.length)) return true;
  }
  return false;
}

/** Whether `name` is the name of an authorization header (a JSON key, for instance). */
export const isAuthorizationName = (name: string): boolean =>
  name.toLowerCase().includes(AUTHORIZATION);

/**
 * Whether `value`, which hangs under a key named like an authorization header, is `Bearer <token>`
 * or `Basic <token>`: the header's name is the key and not part of the value.
 */
export const authorizationValue = (value: string): boolean => schemeToken(value.toLowerCase(), 0);

// ---------------------------------------------------------------------------------------------
// `scheme://user:password@host`

/** Where the authority part of a URL ends. */
const isAuthorityEnd = (code: number): boolean =>
  isSpace(code) ||
  code === 0x2f ||
  code === 0x3f ||
  code === 0x23 ||
  code === 0x22 ||
  code === 0x27 ||
  code === 0x60 ||
  code === 0x3c ||
  code === 0x3e;

/** More than any user name, password and host are; the scan of one URL never goes further. */
const MAX_AUTHORITY_CHARS = 512;

/**
 * Whether `text` has a URL that carries a password in front of its host. A user name alone is
 * not a credential (`ssh://git@host`); a password is, unless it is a stand-in
 * (`user:${DB_PASSWORD}@`, `user:password@`). A long token alone in front of the host
 * (`https://<token>@github.com`) counts as well.
 */
export function urlSecret(text: string): boolean {
  for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
    const start = at + 3;
    const limit = Math.min(text.length, start + MAX_AUTHORITY_CHARS);
    let end = start;
    let atSign = -1;
    for (; end < limit && !isAuthorityEnd(text.charCodeAt(end)); end += 1) {
      if (text.charCodeAt(end) === 0x40) atSign = end;
    }
    if (atSign === -1) continue;
    const userinfo = text.slice(start, atSign);
    const colon = userinfo.indexOf(':');
    if (
      colon === -1
        ? opaque(userinfo, URL_TOKEN_MIN)
        : opaque(userinfo.slice(colon + 1), URL_PASSWORD_MIN)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// PEM private keys

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
/** A label such as `OPENSSH PRIVATE KEY` or `PGP PRIVATE KEY BLOCK` is far shorter than this. */
const MAX_PEM_LABEL = 80;

/** Whether the PEM header that starts at `at` in `text` is a private key's. */
function isPrivateKeyLabel(text: string, at: number, marker: string): boolean {
  const start = at + marker.length;
  const label = text.slice(start, start + MAX_PEM_LABEL);
  const close = label.indexOf('-----');
  return (close === -1 ? label : label.slice(0, close)).includes('PRIVATE KEY');
}

/** Whether `text` has the header of a PEM private key (`-----BEGIN ... PRIVATE KEY-----`). */
export function privateKeyHeaderIn(text: string): boolean {
  for (
    let at = text.indexOf(PEM_BEGIN);
    at !== -1;
    at = text.indexOf(PEM_BEGIN, at + PEM_BEGIN.length)
  ) {
    if (isPrivateKeyLabel(text, at, PEM_BEGIN)) return true;
  }
  return false;
}

/**
 * The lines of `text` that belong to a PEM private key, from its header to its footer (or to the
 * end, if the footer is missing): the body is only base64, and nothing about one of its lines on
 * its own says that it is a key.
 */
export function privateKeyBlockLines(lines: readonly string[]): ReadonlySet<number> {
  const inside = new Set<number>();
  let open = false;
  lines.forEach((line, index) => {
    if (!open) {
      const at = line.indexOf(PEM_BEGIN);
      if (at !== -1 && isPrivateKeyLabel(line, at, PEM_BEGIN)) open = true;
    }
    if (open) {
      inside.add(index);
      const end = line.indexOf(PEM_END);
      if (end !== -1 && isPrivateKeyLabel(line, end, PEM_END)) open = false;
    }
  });
  return inside;
}

// ---------------------------------------------------------------------------------------------
// All of the above, for one line.

/**
 * Whether `text` (one line, or one string of a JSON document) holds a credential under a name,
 * a flag, a header or a URL. `keyValue` is for plain text: in a JSON document a line such as
 * `"a": "b"` is the document's business, not an `.env` line.
 */
export function holdsNamedSecret(text: string, keyValue: boolean): boolean {
  return (
    (keyValue && text.includes('=') && keyValueSecret(text)) ||
    flagSecretInText(text) ||
    authorizationSecret(text) ||
    (text.includes('://') && urlSecret(text))
  );
}

/** Whether a value under `name` is a secret by core's own rule for names and values. */
export const secretUnderName = (name: string, value: string): boolean =>
  value.length >= 12 && extractEnv({ [name]: value }).length > 0;
