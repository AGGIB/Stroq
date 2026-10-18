import type { Positioned } from './atom-kinds.js';

// Base64 runs of 24+ chars; `looksBase64` then requires mixed case plus a digit/symbol and rejects hex.
const BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g;
const HEX = /^[0-9a-fA-F]+$/;

/**
 * A filesystem path passes every base64 test by accident, because `/` is in the
 * base64 alphabet: `/Users/dev/Documents/stroq` is mixed case, is not hex, and its
 * own separators satisfy the "has a digit or symbol" requirement. Treating it as an
 * encoded atom made ordinary work look copied from untrusted output — a path printed
 * by one tool and then used in a command scored `origin.untrusted`.
 *
 * Real base64 places a `/` about once every 64 characters, so its slash-free runs
 * stay long, while a path is short word segments between separators. Requiring at
 * least two separators keeps that distinction from firing on a base64 token that
 * merely happens to contain one slash.
 */
const PATH_SEGMENT_MAX = 16;

function looksLikePath(body: string): boolean {
  const parts = body.split('/');
  return parts.length >= 3 && parts.every((part) => part.length <= PATH_SEGMENT_MAX);
}

function looksBase64(token: string): boolean {
  const body = token.replace(/=+$/, '');
  if (looksLikePath(body)) return false;
  return !HEX.test(body) && /[a-z]/.test(body) && /[A-Z]/.test(body) && /[0-9+/]/.test(body);
}

/**
 * What a subresource-integrity string is made of, by its label: the length of the whole token
 * (hash and padding), the padding, and the characters that may end the hash (the bits left over
 * from the last six are zero in a digest that was encoded, which a smuggled text will not be).
 * A lockfile carries one per package (`integrity: sha512-…`), and every one of them parses as an
 * encoded blob: mixed case, a digit or a symbol, not hex. They are digests, not text anybody copies
 * a command from, and 120 of them in one lockfile chunk used up the cap on atoms by themselves.
 */
const INTEGRITY: ReadonlyMap<
  string,
  { readonly length: number; readonly pad: number; readonly last: string }
> = new Map([
  ['sha256-', { length: 44, pad: 1, last: 'AEIMQUYcgkosw048' }],
  [
    'sha384-',
    {
      length: 64,
      pad: 0,
      last: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    },
  ],
  ['sha512-', { length: 88, pad: 2, last: 'AQgw' }],
]);
const LABEL_LENGTH = 7;

/**
 * Whether the token that starts at `index` of `text` is exactly an integrity string: one of the
 * three labels (`sha256-`, `sha384-`, `sha512-`, lowercase) straight before a standard base64
 * hash of that label's length, padded as its length is padded, and ending as a digest ends.
 * Nothing near it is exempt: another label, another length or other padding is a blob like any.
 */
function isIntegrity(text: string, index: number, token: string): boolean {
  const shape = INTEGRITY.get(text.slice(Math.max(0, index - LABEL_LENGTH), index));
  if (shape === undefined || token.length !== shape.length) return false;
  const body = token.replace(/=+$/, '');
  if (token.length - body.length !== shape.pad) return false;
  return shape.last.includes(body.charAt(body.length - 1));
}

export function encodedAtoms(text: string): Positioned[] {
  return [...text.matchAll(BASE64)]
    .filter((m) => looksBase64(m[0]) && !isIntegrity(text, m.index ?? 0, m[0]))
    .map((m): Positioned => ({ index: m.index ?? 0, atom: { kind: 'encoded', value: m[0] } }));
}
