// One 512-byte tar header, read as hostile bytes.
//
// Nothing in a header is believed until the checksum adds up, and then every field that npm's extractor
// reads is checked, though only a few are used: the name (with the ustar prefix when the header is the
// kind that has one), the type, the mode and the size are. The owner, the group, the time and the device
// numbers are checked to be numbers and are not kept: they are things a tar program does to a disk, and
// this reader never writes one. The checks are there because the program that installs the archive
// afterwards (npm, with node-tar) skips a header it finds wrong and reads the 512 bytes after it as a
// header, so a header that is wrong to npm and right here is a way to put a file in the install that was
// not in the tree that was looked at. What a header may be is therefore narrower here than anywhere:
//
//  - the checksum is the unsigned sum, in octal digits and a NUL or a space (`tar-number.ts`);
//  - every number is octal or base-256 and nothing else (`tar-number.ts`);
//  - a file, a folder and a long name have an empty link name;
//  - a ustar header has the version 00, and a header that is not ustar has no prefix bytes;
//  - a name and a prefix end at the first NUL, and nothing but NULs follows.
//
// A size that is more than any limit is returned as Infinity so that the caller's limit check refuses
// it before a byte is sliced.
import { ArchiveError } from './archive-error.js';
import { readNumber } from './tar-number.js';
import { LIMITS } from './types.js';

export const BLOCK = 512;

/** The typeflag bytes this reader knows by name. Everything not listed here that is not a file is refused. */
export const TYPE = Object.freeze({
  oldFile: 0x00,
  file: 0x30,
  hardLink: 0x31,
  symlink: 0x32,
  charDevice: 0x33,
  blockDevice: 0x34,
  directory: 0x35,
  fifo: 0x36,
  contiguous: 0x37,
  globalPax: 0x67,
  gnuLongLink: 0x4b,
  gnuLongName: 0x4c,
  sparse: 0x53,
  pax: 0x78,
});

/**
 * The longest name that is read before the folder an archive is wrapped in is taken off: a path of the
 * most bytes a path may have, the slash, and a folder of the most a name may have on a common
 * filesystem. A name longer than this cannot become a path of the tree whatever is taken off it, so it is
 * refused as over the limit and never decoded.
 */
export const MAX_NAME_BYTES = LIMITS.maxPathBytes + 1 + 255;

export interface TarHeader {
  /** The name as the header has it, the ustar prefix and a slash in front when the header has one. */
  readonly nameBytes: Uint8Array;
  readonly type: number;
  /** A finite number: the permission bits and, in some writers, the bits of the file type. */
  readonly mode: number;
  /** Infinity when the field holds more than any limit. */
  readonly size: number;
}

const corrupt = (what: string): ArchiveError => new ArchiveError('corrupt', what);

export function isZeroBlock(block: Uint8Array): boolean {
  for (let at = 0; at < block.length; at += 1) {
    if (block[at] !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------------------------

const CHECKSUM_AT = 148;
const CHECKSUM_END = 156;

/** The sum of all the bytes as unsigned bytes, with the checksum field counted as spaces. */
function unsignedSum(block: Uint8Array): number {
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) {
    sum += at >= CHECKSUM_AT && at < CHECKSUM_END ? 0x20 : (block[at] ?? 0);
  }
  return sum;
}

/**
 * Whether the checksum field is octal digits and a NUL or a space, and is the unsigned sum of the
 * block. The signed sum that some old programs wrote is not accepted: npm does not accept it, and an
 * archive that is a header to this reader and not to npm is two archives (see the top of this file).
 */
export function hasValidChecksum(block: Uint8Array): boolean {
  try {
    const stored = readNumber(block.subarray(CHECKSUM_AT, CHECKSUM_END), 'checksum', {
      checksum: true,
    });
    return stored === unsignedSum(block);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------------------------

/** A text field: the bytes up to the first NUL. Nothing but NULs may follow it, or npm reads another name. */
function cString(bytes: Uint8Array, what: string): Uint8Array {
  const end = bytes.indexOf(0);
  if (end === -1) return bytes;
  for (let at = end + 1; at < bytes.length; at += 1) {
    if (bytes[at] !== 0) throw corrupt(`the ${what} field of a header has bytes after its end`);
  }
  return bytes.subarray(0, end);
}

const isMagic = (block: Uint8Array, magic: string, at = 257): boolean =>
  [...magic].every((letter, index) => block[at + index] === letter.charCodeAt(0));

/**
 * Whether the header has a prefix: `ustar` and a NUL is the POSIX format, whose bytes at 345 are the
 * prefix of the name. GNU's `ustar  ` is not. A header with this magic has the version `00`, or it is
 * refused: npm reads a prefix only from `ustar\0` and `00`, so with any other version it is a header
 * with no prefix to npm and one with a prefix to every other program.
 */
function hasPrefix(block: Uint8Array): boolean {
  if (!isMagic(block, 'ustar\0')) return false;
  if (block[263] !== 0x30 || block[264] !== 0x30) {
    throw corrupt('a ustar header has a version that is not 00');
  }
  return true;
}

const PREFIX_AT = 345;
const PREFIX_END = 500;

function nameOf(block: Uint8Array, withPrefix: boolean): Uint8Array {
  const name = cString(block.subarray(0, 100), 'name');
  const prefix = withPrefix
    ? cString(block.subarray(PREFIX_AT, PREFIX_END), 'prefix')
    : new Uint8Array(0);
  if (prefix.length === 0) return name;
  const joined = new Uint8Array(prefix.length + 1 + name.length);
  joined.set(prefix);
  joined[prefix.length] = 0x2f;
  joined.set(name, prefix.length + 1);
  return joined;
}

/** A header that has no prefix has nothing at 345 to 499: those bytes are other fields, or are not there. */
function checkNoPrefix(block: Uint8Array): void {
  for (let at = PREFIX_AT; at < PREFIX_END; at += 1) {
    if (block[at] !== 0) {
      throw corrupt(
        'a header that is not ustar has bytes at 345 to 499, where ustar keeps a prefix',
      );
    }
  }
}

/** The numbers that are checked and not kept: the owner, the group and the time; the device numbers of ustar. */
const NOT_KEPT = [
  { what: 'user id', from: 108, to: 116 },
  { what: 'group id', from: 116, to: 124 },
  { what: 'modification time', from: 136, to: 148 },
] as const;
const DEVICE_NUMBERS = [
  { what: 'device major', from: 329, to: 337 },
  { what: 'device minor', from: 337, to: 345 },
] as const;

/**
 * The types that cannot have a link name, because npm skips a header of these types that has one. A pax
 * header may have bytes there and npm does not mind; the other types are links and kinds that are refused.
 */
const NO_LINK_NAME: ReadonlySet<number> = new Set([
  TYPE.oldFile,
  TYPE.file,
  TYPE.directory,
  TYPE.gnuLongName,
]);

function checkNumbersNotKept(block: Uint8Array): void {
  const fields = isMagic(block, 'ustar') ? [...NOT_KEPT, ...DEVICE_NUMBERS] : NOT_KEPT;
  for (const { what, from, to } of fields) {
    readNumber(block.subarray(from, to), what, { blank: true, negative: true });
  }
}

function checkLinkName(block: Uint8Array, type: number): void {
  if (!NO_LINK_NAME.has(type)) return;
  for (let at = 157; at < 257; at += 1) {
    if (block[at] !== 0) {
      throw corrupt('a file, a folder or a long name in the archive has a link name');
    }
  }
}

/** The headers that describe the entry after them. */
const DESCRIBES_NEXT: ReadonlySet<number> = new Set([TYPE.pax, TYPE.globalPax, TYPE.gnuLongName]);

/** The fields of a block whose checksum has been checked. */
export function readHeader(block: Uint8Array): TarHeader {
  const type = block[156] ?? 0;
  const withPrefix = hasPrefix(block);
  if (!withPrefix) checkNoPrefix(block);
  checkLinkName(block, type);
  checkNumbersNotKept(block);
  const nameBytes = nameOf(block, withPrefix);
  // npm skips a header with no path, whatever its type, and then reads the data after it as headers.
  // A file or a folder with no name is refused or is nothing; these carry the name of another entry.
  if (nameBytes.length === 0 && DESCRIBES_NEXT.has(type)) {
    throw corrupt('an extended header or a long name header in the archive has no name');
  }
  return {
    nameBytes,
    type,
    mode: readNumber(block.subarray(100, 108), 'mode', { blank: true }),
    size: readNumber(block.subarray(124, 136), 'size', { huge: true }),
  };
}

// ---------------------------------------------------------------------------------------------
// Names, and kinds that are not read
// ---------------------------------------------------------------------------------------------

/** Strict, and keeping a byte order mark: a name that is not UTF-8 is refused, never repaired. */
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a name. A name over the longest a path can be is a limit and is not decoded. */
export function decodeName(bytes: Uint8Array): string {
  if (bytes.length > MAX_NAME_BYTES) {
    throw new ArchiveError('limit', `a name in the archive is over ${MAX_NAME_BYTES} bytes`);
  }
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new ArchiveError('refused', 'a name in the archive is not valid UTF-8');
  }
}

/** The refusal for an entry of a kind that is not read. It names the kind and nothing the archive chose. */
export function unsupportedType(type: number): ArchiveError {
  const refuse = (what: string): ArchiveError => new ArchiveError('unsupported', what);
  switch (type) {
    case TYPE.hardLink:
    case TYPE.symlink:
      return refuse('an archive with a link is not read (a symbolic or hard link was found)');
    case TYPE.charDevice:
    case TYPE.blockDevice:
      return refuse('an archive with a device file is not read');
    case TYPE.fifo:
      return refuse('an archive with a FIFO (a named pipe) is not read');
    case TYPE.contiguous:
      return refuse('an archive with a contiguous file is not read');
    case TYPE.sparse:
      return refuse('an archive with a sparse file is not read');
    case TYPE.gnuLongLink:
      return refuse('an archive with a GNU long link name is not read (it belongs to a link)');
    default:
      return refuse(`an entry of an unknown type is not read (type byte 0x${type.toString(16)})`);
  }
}
