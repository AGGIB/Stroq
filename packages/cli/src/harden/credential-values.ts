/**
 * Values, whatever name they hang under: which of them stand in for a credential and which are a
 * location, and the small scans every reader needs. Plain scans and anchored patterns only: the
 * values are text that a repository can commit, and each function here takes time in proportion
 * to the length of the value (a location is judged by its first few hundred characters).
 */

// ---------------------------------------------------------------------------------------------
// Characters.

const TAB = 9;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const DOLLAR = 0x24;
const PERCENT = 0x25;
const STAR = 0x2a;
const DASH = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const LESS = 0x3c;
const AT = 0x40;
const LEFT_BRACE = 0x7b;
const LEFT_PAREN = 0x28;
const TILDE = 0x7e;

/** The characters `\s` stands for in a pattern. */
export const isSpace = (code: number): boolean =>
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

export function hasSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) if (isSpace(value.charCodeAt(i))) return true;
  return false;
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;

/** Quotes, commas and brackets around a word that is one element of an argument list. */
const isWrapper = (code: number): boolean =>
  isSpace(code) ||
  code === QUOTE ||
  code === APOSTROPHE ||
  code === 0x60 ||
  code === 0x2c ||
  code === 0x3b ||
  code === 0x5b ||
  code === 0x5d ||
  code === LEFT_PAREN ||
  code === 0x29 ||
  code === LEFT_BRACE ||
  code === 0x7d;

/**
 * `word` without the wrapping characters at either end. Two plain scans: a pattern with `+$` in
 * it is quadratic on a long run of the characters it trims.
 */
export function trimmed(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && isWrapper(word.charCodeAt(start))) start += 1;
  while (end > start && isWrapper(word.charCodeAt(end - 1))) end -= 1;
  return word.slice(start, end);
}

export const isQuote = (code: number): boolean => code === QUOTE || code === APOSTROPHE;

/** Whether `value` is digits and nothing else. */
export function isNumeric(value: string): boolean {
  if (value === '') return false;
  for (let i = 0; i < value.length; i += 1) if (!isDigit(value.charCodeAt(i))) return false;
  return true;
}

/** Minimum character length for a user password token. */
export const USER_PASSWORD_MIN = 4;

// ---------------------------------------------------------------------------------------------
// What stands in for a value.

/**
 * Words that stand where a real value would go, matched at the start of the value: the same ones
 * core sets aside, so that the two readers of a value agree.
 */
const EXAMPLE_PREFIX =
  /^(?:(?:change|replace)[-_]?me|todo|example|sample|dummy|placeholder|your[-_])/i;

/**
 * Words that are a value in their own right but not a credential: the word "password" where a
 * password would go, and the modes, schemes and switches a config puts under a name that says
 * `auth` or `token` (`"auth": "none"`, `"tokenType": "bearer"`, `id-token: write`). Whole values
 * only, and short.
 */
const WHOLE_WORD =
  /^(?:pass(?:word|wd)?|secret|token|key|none|null|nil|true|false|yes|no|on|off|read|write|bearer|basic|digest|oauth2?|jwt|apikey|api-key|default|auto|enabled|disabled|required|optional|inherit)$/i;
const LONGEST_WHOLE_WORD = 16;

/** Whether `value` is `ch` repeated (any case), at least `least` times: `xxxx`, `****`. */
function isRunOf(value: string, ch: number, least: number): boolean {
  if (value.length < least) return false;
  for (let i = 0; i < value.length; i += 1)
    if ((value.charCodeAt(i) | 0x20) !== (ch | 0x20)) return false;
  return true;
}

const isStars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) !== STAR) return false;
  return value.length > 0;
};

/** `...` and `…`, which stand where a value was left out of an example. */
const isEllipsis = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== DOT && value.charCodeAt(i) !== 0x2026) return false;
  }
  return value.length > 0;
};

/**
 * `$NAME` (and `$1`): a shell variable, whose name is in one case. `$ecretPass` is a variable by
 * the letters of it, and so is the start of a password; the case is what tells them apart, as
 * variables are written in capitals or in lower case and a password is not.
 */
function isPlainVariable(value: string): boolean {
  if (value.length < 2) return false;
  let upper = false;
  let lower = false;
  for (let i = 1; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isUpper(code)) upper = true;
    else if (isLower(code)) lower = true;
    else if (!isDigit(code) && code !== 0x5f) return false;
  }
  return !(upper && lower);
}

/**
 * `$NAME`, `${NAME}` and `$(command)`. The two bracketed forms count by their opening: a word cut
 * out of a line has often lost its closing bracket to the trimming of wrapping characters, and no
 * password starts with `${`.
 */
function isVariable(value: string): boolean {
  const second = value.charCodeAt(1);
  return second === LEFT_BRACE || second === LEFT_PAREN || isPlainVariable(value);
}

/**
 * One piece of a path: no capital except the first letter, so `etc`, `Users`, `.config` and
 * `id_rsa.pub` are, and the `bPxRfiC` of a base64 token is not. Anchored, and the one optional
 * character in front cannot make it backtrack more than twice.
 */
const PATH_PIECE = /^[A-Za-z0-9._@+~=-]?[a-z0-9._@+~=-]*$/;

/**
 * Whether `value`, which starts with a slash, reads as a path and not as base64 (whose alphabet
 * includes `/`, and which starts with it one time in 64). A path is made of pieces like words; a
 * token has capitals in the middle of its pieces.
 */
function isPlainPath(value: string): boolean {
  for (const piece of value.split('/')) if (!PATH_PIECE.test(piece)) return false;
  return true;
}

/**
 * Whether `value`, which starts with a dash, is a flag: `--anything`, or `-` and lower-case words
 * and digits (`-v`, `-n5`). A base64url token starts with a dash one time in 64, and has capitals
 * and underscores in it.
 */
function isFlag(value: string): boolean {
  if (value.length === 1 || value.charCodeAt(1) === DASH) return true;
  for (let i = 1; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (!isLower(code) && !isDigit(code) && code !== DASH) return false;
  }
  return true;
}

/**
 * Whether `value` stands in for a value instead of being one: a variable, a template, a path, a
 * flag, a word every document uses for an example or a mode. What counts is the WHOLE value: a
 * password may begin with `$`, `-`, `/`, `<` or `{`, and so may a base64 token, so a first
 * character settles nothing.
 */
export function isStandIn(value: string): boolean {
  if (value === '') return true;
  switch (value.charCodeAt(0)) {
    case DOLLAR:
      return isVariable(value);
    case LESS:
      return value.endsWith('>');
    case PERCENT:
      return value.length > 2 && value.endsWith('%');
    case LEFT_BRACE:
      return value.endsWith('}');
    case TILDE:
      return value === '~' || value.startsWith('~/');
    case DOT:
      return value.startsWith('./') || value.startsWith('../') || isEllipsis(value);
    case SLASH:
      return isPlainPath(value);
    case DASH:
      return isFlag(value);
    case AT:
      return value.includes('/') || value.includes('.');
    case STAR:
      return isStars(value);
    case 0x2026:
      return isEllipsis(value);
    default:
      return (
        EXAMPLE_PREFIX.test(value) ||
        isRunOf(value, 0x78, 3) ||
        (value.length <= LONGEST_WHOLE_WORD && WHOLE_WORD.test(value))
      );
  }
}

// ---------------------------------------------------------------------------------------------
// What is a location and not a credential.

/** The same three tests core applies: a URL, a `localhost` or dotted-domain prefix, a host name. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_PREFIX = /^(?:\.|localhost)/i;
const HOST_LIKE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;
/** No host name is longer, so a longer value is not tested as one. */
const LONGEST_HOST = 300;

export const isLocation = (value: string): boolean =>
  URL_SCHEME.test(value) ||
  LOCAL_PREFIX.test(value) ||
  (value.length <= LONGEST_HOST && HOST_LIKE.test(value));

// ---------------------------------------------------------------------------------------------
// A value that a name, a flag or a position says is secret.

/**
 * A value that a flag or a header says is secret: long enough to be one, in one piece, and not a
 * stand-in. `minLength` is shorter than core's for values whose position says they are secret.
 */
export const opaque = (value: string, minLength: number): boolean =>
  value.length >= minLength && !hasSpace(value) && !isStandIn(value);
