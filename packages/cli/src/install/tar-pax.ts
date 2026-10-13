// The records of a pax extended header: `<length> <key>=<value>\n`, one after another.
//
// Only two keys change what an entry is here, `path` and `size`, and they are the two a hostile archive
// would use: the first decides where a file lands, the second decides how far the reader goes. Every
// other key (times, owners, extended attributes, a commit id GitHub writes in a global header) is
// metadata of a disk this reader never writes, and is skipped. The keys that mean the entry is not
// stored as it is described, the sparse ones, are refused, as a sparse file is.
//
// The length at the front of a record counts the length itself, so a record is cut out by that number
// and checked, not searched for. But npm's extractor (node-tar) does not read them that way: it splits the
// text at every newline, keeps a line whose number is its length, and cuts the key off after the number
// written again without its leading zeros. So a record with a newline inside it is several records to
// npm (one can be a `path` that this reader never saw, or a global `size`), and a record whose length
// starts with a zero is one it reads with the wrong key. Both are refused, and the two readings agree on
// every record that is left.
import { ArchiveError } from './archive-error.js';
import { decodeName } from './tar-header.js';

/** The most bytes of records a pax header may hold. Real ones are a few hundred. */
export const MAX_PAX_BYTES = 64 * 1024;
/** A record of this many bytes is the longest a header this size can hold, so a length has at most this many digits. */
const MAX_LENGTH_DIGITS = 6;
/** The most digits of a size record: more than any limit and less than a double holds exactly. */
const MAX_SIZE_DIGITS = 15;

export interface Pax {
  /** The path of the next entry, or null when the header does not set one. */
  readonly path: string | null;
  /** The size of the next entry, or null. */
  readonly size: number | null;
  /** A 40-hex commit hash from a comment record, if one was present. */
  readonly comment?: string | null;
}

const malformed = (): ArchiveError =>
  new ArchiveError('corrupt', 'an extended header of the archive is malformed');

const isDigit = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x30 && byte <= 0x39;

/** Where the record that starts at `at` ends, checked against the data. */
function recordEnd(data: Uint8Array, at: number): { digits: number; end: number } {
  let length = 0;
  let cursor = at;
  while (isDigit(data[cursor])) {
    length = length * 10 + ((data[cursor] ?? 0) - 0x30);
    cursor += 1;
    if (cursor - at > MAX_LENGTH_DIGITS) throw malformed();
  }
  const digits = cursor - at;
  if (data[at] === 0x30) throw malformed();
  // A record is at least the digits, a space, a one-byte key, an equals sign and a newline.
  if (digits === 0 || data[cursor] !== 0x20 || length < digits + 4) throw malformed();
  if (at + length > data.length || data[at + length - 1] !== 0x0a) throw malformed();
  return { digits, end: at + length };
}

function sizeOf(value: Uint8Array): number {
  if (value.length === 0 || value.length > MAX_SIZE_DIGITS) throw malformed();
  let size = 0;
  for (const byte of value) {
    if (!isDigit(byte)) throw malformed();
    size = size * 10 + (byte - 0x30);
  }
  return size;
}

const keyText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const isSparseKey = (key: string): boolean =>
  key.startsWith('GNU.sparse') || key === 'SCHILY.realsize';

function isHex40(bytes: Uint8Array): string | null {
  let start = 0;
  let end = bytes.length;
  while (start < end && bytes[start]! <= 0x20) start += 1;
  while (end > start && bytes[end - 1]! <= 0x20) end -= 1;
  if (end - start !== 40) return null;
  for (let i = start; i < end; i += 1) {
    const b = bytes[i]!;
    const isHex = (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);
    if (!isHex) return null;
  }
  return Buffer.from(bytes.subarray(start, end)).toString('latin1');
}

/**
 * The `path` and `size` of a pax header. A global header may carry neither, nor a link path: it would
 * apply to every entry after it. Throws an ArchiveError for a record that is malformed, a sparse record,
 * a name that is not UTF-8 or is over the limit, and a size that is not a number.
 */
export function parsePax(data: Uint8Array, isGlobal: boolean): Pax {
  let path: string | null = null;
  let size: number | null = null;
  let comment: string | null = null;
  for (let at = 0; at < data.length;) {
    const { digits, end } = recordEnd(data, at);
    const record = data.subarray(at + digits + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1 || record.indexOf(0x0a) !== -1) throw malformed();
    const key = keyText(record.subarray(0, equals));
    const value = record.subarray(equals + 1);
    if (isSparseKey(key))
      throw new ArchiveError('unsupported', 'an archive with a sparse file is not read');
    if (isGlobal && (key === 'path' || key === 'size' || key === 'linkpath')) {
      throw new ArchiveError(
        'unsupported',
        'a global extended header that sets a name or a size is not read',
      );
    }
    if (key === 'path') path = decodeName(value);
    if (key === 'size') size = sizeOf(value);
    if (key === 'comment') {
      const hex = isHex40(value);
      if (hex !== null) comment = hex;
    }
    at = end;
  }
  return { path, size, comment };
}
