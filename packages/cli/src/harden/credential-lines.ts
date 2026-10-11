import { flagSecretInText } from './credential-flags.js';
import {
  assignmentSecret,
  withoutCommentPrefix,
  keyValueSecret,
  leadingPairSecret,
} from './credential-pairs.js';
import { isSpace, opaque } from './credential-values.js';

/**
 * Credential-shaped text, found one line (or one string) at a time. Every reader takes time in
 * proportion to the length of what it is given (a few passes over it), because the text is a
 * config file that a repository can commit and a pattern that backtracks on a long run of spaces
 * is a way to hang the command that reads it:
 * the `NAME=VALUE` pattern core uses for `.env` files is quadratic on exactly that, which is why
 * it is not used here. Plain scans and anchored, unambiguous patterns.
 *
 * The readers live in four files. `credential-pairs.ts` reads a name and the value written next to
 * it (`NAME=VALUE`, `name: value`, the parameters of a URL), `credential-flags.ts` reads a command
 * line (`--password x`, `-u user:pass`, `-H 'X-Key: x'`), and this file reads what has a shape of
 * its own: an Authorization header, the front of a URL, a PEM private key. `credential-values.ts`
 * says what stands in for a value, and `credential-names.ts` what a name says.
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

const EQUALS = 0x3d;
const AUTH_TOKEN_MIN = 8;
const URL_PASSWORD_MIN = 4;
const URL_TOKEN_MIN = 20;

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

/** The schemes of an Authorization header that carry a token: `Token` is Django REST's and GitHub's. */
const SCHEMES: readonly string[] = ['bearer', 'basic', 'token'];

/**
 * Whether `lower` (the text in lower case) has, from `from` on, a Bearer, Basic or Token scheme
 * followed by an opaque token, after at most a few characters of punctuation and white space.
 * The token is cut out of `source`, the text as it was written: case tells a base64 token from a
 * path, and a flag from a token that starts with a dash.
 */
function schemeToken(source: string, lower: string, from: number): boolean {
  let i = from;
  const gapEnd = i + MAX_HEADER_GAP;
  while (i < gapEnd && i < lower.length && isGap(lower.charCodeAt(i))) i += 1;
  const scheme = SCHEMES.find((name) => lower.startsWith(name, i));
  if (scheme === undefined) return false;
  i += scheme.length;
  if (!isSpace(lower.charCodeAt(i))) return false;
  while (i < lower.length && isSpace(lower.charCodeAt(i))) i += 1;
  let end = i;
  while (end < lower.length && isTokenChar(lower.charCodeAt(end))) end += 1;
  return opaque(source.slice(i, end), AUTH_TOKEN_MIN);
}

/** `text` and its lower case, which has the same offsets unless a letter lower-cases to two. */
function withLower(text: string): { readonly source: string; readonly lower: string } {
  const lower = text.toLowerCase();
  return { source: lower.length === text.length ? text : lower, lower };
}

/**
 * Whether `text` has an `Authorization` header (any case; `Proxy-Authorization` too) whose scheme
 * is Bearer, Basic or Token and whose credential is an opaque token. "Basic" and "bearer" are
 * ordinary words, so the header's name has to be there too.
 */
export function authorizationSecret(text: string): boolean {
  if (text.length < AUTHORIZATION.length + AUTH_TOKEN_MIN) return false;
  const { source, lower } = withLower(text);
  for (
    let at = lower.indexOf(AUTHORIZATION);
    at !== -1;
    at = lower.indexOf(AUTHORIZATION, at + AUTHORIZATION.length)
  ) {
    if (schemeToken(source, lower, at + AUTHORIZATION.length)) return true;
  }
  return false;
}

/**
 * Whether `value`, which hangs under a key named like an authorization header, is `Bearer <token>`,
 * `Basic <token>` or `Token <token>`: the header's name is the key and not part of the value.
 */
export function authorizationValue(value: string): boolean {
  const { source, lower } = withLower(value);
  return schemeToken(source, lower, 0);
}

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
 * `"a": "b"` is the document's business, not an `.env` line, and the walk of the document has
 * read the name above each string. Comments can hold stale credentials too.
 */
export function holdsNamedSecret(text: string, keyValue: boolean): boolean {
  const words = text.split(/\s+/);
  return (
    (keyValue && namesAValue(text, words)) ||
    flagSecretInText(words) ||
    authorizationSecret(text) ||
    (text.includes('://') && urlSecret(text))
  );
}

/** A name and the value written next to it: `NAME=VALUE`, `NAME=value rest`, `name: value`. */
function namesAValue(text: string, words: readonly string[]): boolean {
  const content = withoutCommentPrefix(text);
  return (
    (content.includes('=') && (keyValueSecret(content) || assignmentSecret(words))) ||
    (content.includes(':') && leadingPairSecret(content))
  );
}
