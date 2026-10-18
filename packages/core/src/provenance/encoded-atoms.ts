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
  // The hash of a Go module in go.sum: SHA-256, as `h1:` and 44 characters.
  ['h1:', { length: 44, pad: 1, last: 'AEIMQUYcgkosw048' }],
]);

/** The share of printable ASCII (with the whitespace of text) from which bytes are read as text. */
const TEXT_SHARE = 0.9;
/** A run of this many printable bytes in a row is text however much else is there. */
const TEXT_RUN = 16;

const isPrintableByte = (byte: number): boolean =>
  (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isPaddingByte = (byte: number): boolean =>
  byte === 0x00 || byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

function longestPrintableRun(bytes: Uint8Array): number {
  let longest = 0;
  let run = 0;
  for (const byte of bytes) {
    run = isPrintableByte(byte) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Whether the bytes are valid UTF-8 and most of what they decode to is not a control character. */
function isPrintableUtf8(bytes: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const characters = [...decoded];
    return characters.filter((c) => !/\p{C}/u.test(c)).length * 2 > characters.length;
  } catch {
    return false;
  }
}

/**
 * Whether bytes are text and not a digest: a digest is high-entropy, so no more than a third of
 * its bytes are printable and it has no run of sixteen of them, where text is mostly printable
 * (90% or more of the bytes, or valid UTF-8 that is mostly not control characters) or holds such
 * a run. The padding at the end (NUL, blanks) is not counted: a command filled out to the length
 * of a hash with either is still the command.
 */
function decodesToText(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (end > 0 && isPaddingByte(bytes[end - 1] ?? 0)) end -= 1;
  const body = bytes.subarray(0, end);
  if (body.length === 0) return true;
  const printable = body.filter(isPrintableByte).length;
  return (
    printable >= body.length * TEXT_SHARE ||
    longestPrintableRun(body) >= TEXT_RUN ||
    isPrintableUtf8(body)
  );
}

/**
 * Whether the token that starts at `index` of `text` is exactly an integrity string: one of the
 * labels (`sha256-`, `sha384-`, `sha512-`, lowercase, and Go's `h1:`) straight before a standard base64
 * hash of that label's length, padded as its length is padded, ending as a digest ends, and
 * decoding to bytes that are not text. Nothing near it is exempt: another label, another length,
 * other padding, or a body that decodes to a command is a blob like any. The label alone is
 * not enough, because it is the one thing in the token that anyone can write.
 */
function isIntegrity(text: string, index: number, token: string): boolean {
  const shape = [...INTEGRITY].find(([label]) => text.startsWith(label, index - label.length))?.[1];
  if (shape === undefined || index < 0 || token.length !== shape.length) return false;
  const body = token.replace(/=+$/, '');
  if (token.length - body.length !== shape.pad) return false;
  if (!shape.last.includes(body.charAt(body.length - 1))) return false;
  return !decodesToText(Buffer.from(token, 'base64'));
}

/**
 * The blobs in `text`. A token that is a hash by its label, its shape and its bytes is a `digest`,
 * the cheapest atom there is, and not a blob (`cheapDigests`): the exact token still finds its record
 * when a later action carries it, but it never marks a session and goes first when records are
 * dropped. Where the page that holds it was flagged (`cheapDigests` off) it is a blob like any, so
 * that a payload labelled as a hash among a great many real ones cannot hide.
 */
export function encodedAtoms(text: string, cheapDigests = true): Positioned[] {
  return [...text.matchAll(BASE64)]
    .filter((m) => looksBase64(m[0]))
    .map((m): Positioned => {
      const index = m.index ?? 0;
      const digest = cheapDigests && isIntegrity(text, index, m[0]);
      return { index, atom: { kind: digest ? 'digest' : 'encoded', value: m[0] } };
    });
}
