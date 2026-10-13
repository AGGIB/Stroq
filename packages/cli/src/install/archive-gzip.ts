// The gzip layer of an archive, and the formats that look like archives and are not read.
//
// A `.tgz` is untrusted bytes twice over: the file, and what it expands to. So the expanded size is
// capped while the data is inflated (`maxOutputLength`, which stops a bomb of a few tens of kilobytes
// before it is held in memory), and the gzip framing is read by hand so that exactly one member is
// accepted and nothing is left over. `gunzipSync` reads a second member as more data and ignores or
// rejects trailing bytes by its own rules; a tool that vets an archive has to say what it read, and
// "everything in the file was one gzip stream" is the one thing it can say with no exceptions.
//
// The deflate data is inflated raw, and the header, the length and the checksum are checked here. The
// number of bytes the inflater consumed says where the stream ended.
import { inflateRawSync } from 'node:zlib';
import { ArchiveError } from './archive-error.js';

const MAGIC = [0x1f, 0x8b] as const;
const METHOD_DEFLATE = 8;
const HEADER_BYTES = 10;
const TRAILER_BYTES = 8;
const FLAG_HEADER_CRC = 0x02;
const FLAG_EXTRA = 0x04;
const FLAG_NAME = 0x08;
const FLAG_COMMENT = 0x10;
const FLAGS_RESERVED = 0xe0;

/** Whether the bytes start as a gzip stream does. The file name is not asked: a name is not a format. */
export const isGzip = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1];

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((byte, at) => bytes[at] === byte);

const NOT_READ = 'is not read: give a tar archive, plain or gzipped (.tar, .tar.gz or .tgz)';

/**
 * The words for a file that is a known archive or compression format and not one this reads, or null.
 * A zip is the usual mistake, so it is said by name; the rest are the compressions a tar travels in.
 */
export function foreignFormat(bytes: Uint8Array): string | null {
  const zip = [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ];
  if (zip.some((magic) => startsWith(bytes, magic))) return `a zip file ${NOT_READ}`;
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return `an xz file ${NOT_READ}`;
  // "BZh", a level from 1 to 9 and the magic of the first block: a name that starts with BZh is not enough.
  const level = bytes[3] ?? 0;
  const block = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
  if (startsWith(bytes, [0x42, 0x5a, 0x68]) && level >= 0x31 && level <= 0x39) {
    if (startsWith(bytes.subarray(4), block)) return `a bzip2 file ${NOT_READ}`;
  }
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) return `a zstd file ${NOT_READ}`;
  return null;
}

const damaged = (what: string): ArchiveError => new ArchiveError('bad-gzip', what);
const CUT_SHORT = 'the gzip data is cut short';

/** The place after a zero-terminated field that starts at `at`. */
function afterTerminated(bytes: Uint8Array, at: number): number {
  const end = bytes.indexOf(0, at);
  if (end === -1) throw damaged('the gzip header is cut short');
  return end + 1;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 of gzip. Written out because `zlib.crc32` is not in every Node 22. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let at = 0; at < bytes.length; at += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[at] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Where the deflate data starts: after the fixed header and the optional fields its flags announce. */
function bodyStart(bytes: Uint8Array): number {
  if (bytes.length < HEADER_BYTES + TRAILER_BYTES) throw damaged(CUT_SHORT);
  if (bytes[2] !== METHOD_DEFLATE) throw damaged('the gzip data is not compressed with deflate');
  const flags = bytes[3] ?? 0;
  if ((flags & FLAGS_RESERVED) !== 0) throw damaged('the gzip header uses flags that are reserved');
  let at = HEADER_BYTES;
  if ((flags & FLAG_EXTRA) !== 0) {
    if (at + 2 > bytes.length) throw damaged('the gzip header is cut short');
    at += 2 + ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8));
  }
  if ((flags & FLAG_NAME) !== 0) at = afterTerminated(bytes, at);
  if ((flags & FLAG_COMMENT) !== 0) at = afterTerminated(bytes, at);
  if ((flags & FLAG_HEADER_CRC) !== 0) {
    if (at + 2 > bytes.length) throw damaged('the gzip header is cut short');
    // The low 16 bits of the CRC-32 of every header byte before the field. zlib, and so npm, refuses a
    // header that does not match, so an archive with one is not one that will be installed as it is read.
    const stored = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
    if (stored !== (crc32(bytes.subarray(0, at)) & 0xffff)) {
      throw damaged('the gzip header checksum does not match');
    }
    at += 2;
  }
  if (at > bytes.length) throw damaged('the gzip header is cut short');
  return at;
}

interface Inflated {
  readonly buffer: Buffer;
  readonly engine: { readonly bytesWritten: number };
}

/** Inflates the raw deflate data; `maxOutputLength` stops it at the limit instead of holding all of it. */
function inflate(body: Uint8Array, maxOutput: number): Inflated {
  try {
    const options = { info: true, maxOutputLength: Math.max(1, maxOutput) };
    return inflateRawSync(body, options) as unknown as Inflated;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveError('limit', `the archive expands to more than ${maxOutput} bytes`);
    }
    throw damaged('the gzip data is damaged or cut short');
  }
}

/**
 * The data of a gzip file that is exactly one member, at most `maxOutput` bytes once expanded. Throws
 * an ArchiveError for anything else: data that is damaged or cut short, a checksum or a length that
 * does not match, more than one member, bytes after the stream, or more output than the limit.
 */
export function gunzipOnce(bytes: Uint8Array, maxOutput: number): Uint8Array {
  const start = bodyStart(bytes);
  const { buffer, engine } = inflate(bytes.subarray(start), maxOutput);
  const trailer = start + engine.bytesWritten;
  if (trailer + TRAILER_BYTES > bytes.length) throw damaged(CUT_SHORT);
  const view = new DataView(bytes.buffer, bytes.byteOffset + trailer, TRAILER_BYTES);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== crc32(data)) {
    throw damaged('the gzip checksum does not match the data');
  }
  if (view.getUint32(4, true) !== data.length >>> 0) {
    throw damaged('the gzip length does not match the data');
  }
  const rest = bytes.subarray(trailer + TRAILER_BYTES);
  if (rest.length === 0) return data;
  throw damaged(
    isGzip(rest)
      ? 'the file holds more than one gzip member, which is not read'
      : 'there is data after the gzip data',
  );
}
