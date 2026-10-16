/**
 * Which binary payloads strict mode lets through without reading them as text.
 *
 * An MCP `image` or `audio` item, and an embedded resource's `blob`, carry base64 the
 * default scanner skips: megabytes of base64 are not worth scanning on every call, and
 * there is no instruction text in the bytes of a JPEG. Strict mode cannot skip a field
 * just because it is probably harmless, so it asks the narrower question it can answer:
 * is this payload what it says it is? A payload that is wholly base64, declared as one
 * of a short list of picture or sound formats, and that begins with that format's own
 * signature is passed on as opaque media. Anything else (text under an image type, a
 * type not on the list, prose behind a real header) is content Stroq cannot classify,
 * and the message carrying it is withheld.
 *
 * What this does NOT claim: text drawn INTO a picture, or spoken in a recording, is read
 * by the model and not by Stroq. That is the stated limit of strict mode, not a case it
 * solves.
 */

/** The prefix decoded to check a signature: the longest signature below is 12 bytes. */
const SIGNATURE_CHARS = 24;

/**
 * Strict base64: the alphabet, then at most two `=`, in a length that is a multiple of
 * four. A flat character class on purpose: payloads reach 8 MiB, and a pattern built
 * from nested groups would need a backtracking stack as long as the payload.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64 = (data: string): boolean => data.length % 4 === 0 && BASE64.test(data);

const startsWith = (bytes: Buffer, prefix: readonly number[]): boolean =>
  prefix.every((byte, i) => bytes[i] === byte);

const ascii = (text: string): readonly number[] => [...text].map((c) => c.charCodeAt(0));
const at = (bytes: Buffer, offset: number, text: string): boolean =>
  ascii(text).every((byte, i) => bytes[offset + i] === byte);

const riff = (bytes: Buffer, form: string): boolean => at(bytes, 0, 'RIFF') && at(bytes, 8, form);

/**
 * Format signatures, keyed by the media type that may claim them. A `Map`, not an
 * object: the key is a string the SERVER chose, and `'constructor'` must not find a
 * signature checker on `Object.prototype`.
 */
const SIGNATURES: ReadonlyMap<string, (bytes: Buffer) => boolean> = new Map([
  ['image/png', (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', (b) => startsWith(b, [0xff, 0xd8, 0xff])],
  ['image/gif', (b) => at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')],
  ['image/webp', (b) => riff(b, 'WEBP')],
  ['audio/wav', (b) => riff(b, 'WAVE')],
  ['audio/ogg', (b) => at(b, 0, 'OggS')],
  ['audio/flac', (b) => at(b, 0, 'fLaC')],
  ['audio/webm', (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])],
  ['audio/mp4', (b) => at(b, 4, 'ftyp')],
  ['audio/mpeg', (b) => at(b, 0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)],
]);

/** Spellings of a listed type that real servers send. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['image/jpg', 'image/jpeg'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'],
]);

function baseType(mimeType: string): string {
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return ALIASES.get(base) ?? base;
}

/** True when `data` is wholly base64 of a picture or sound whose first bytes match `mimeType`. */
export function isClassifiedMedia(mimeType: unknown, data: unknown): boolean {
  if (typeof mimeType !== 'string' || typeof data !== 'string' || data === '') return false;
  const matches = SIGNATURES.get(baseType(mimeType));
  if (matches === undefined || !isBase64(data)) return false;
  return matches(Buffer.from(data.slice(0, SIGNATURE_CHARS), 'base64'));
}
