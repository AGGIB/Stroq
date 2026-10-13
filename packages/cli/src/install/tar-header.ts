// One 512-byte tar header, read as hostile bytes.
//
// Nothing in a header is believed until the checksum adds up, and then only the fields this reader
// needs are read: the name (with the ustar prefix when the header is the kind that has one), the type,
// the mode and the size. The owner, the group and the times are not read at all: they are things a tar
// program does to a disk, and this reader never writes one. A number is read strictly (octal digits and
// then only spaces or NULs, or the GNU base-256 form), and a size that is more than any limit is
// returned as Infinity so that the caller's limit check refuses it before a byte is sliced.
import { ArchiveError } from './archive-error.js';
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
// Numbers
// ---------------------------------------------------------------------------------------------

/** More than a file can be and less than a double can hold exactly: past this a field is "too big". */
const TOO_BIG = 2 ** 40;

/** The GNU form for numbers that do not fit octal: the high bit set, then big-endian. A set sign bit is a negative number. */
function base256(field: Uint8Array, what: string): number {
  const first = field[0] ?? 0;
  if ((first & 0x40) !== 0) throw corrupt(`the ${what} field of a header is negative`);
  let value = first & 0x3f;
  for (let at = 1; at < field.length; at += 1) {
    value = value * 256 + (field[at] ?? 0);
    if (value > TOO_BIG) return Infinity;
  }
  return value;
}

/** Octal digits between spaces and NULs, or base-256. A blank field is 0 only where the caller says so. */
function numberField(field: Uint8Array, what: string, blankIsZero = false): number {
  if (((field[0] ?? 0) & 0x80) !== 0) return base256(field, what);
  const notANumber = corrupt(`the ${what} field of a header is not a number`);
  let at = 0;
  while (at < field.length && field[at] === 0x20) at += 1;
  let value = 0;
  let digits = 0;
  for (; at < field.length; at += 1) {
    const digit = (field[at] ?? 0) - 0x30;
    if (digit < 0 || digit > 7) break;
    value = value * 8 + digit;
    digits += 1;
  }
  for (; at < field.length; at += 1) {
    if (field[at] !== 0 && field[at] !== 0x20) throw notANumber;
  }
  if (digits === 0 && !blankIsZero) throw notANumber;
  return value;
}

// ---------------------------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------------------------

const CHECKSUM_AT = 148;
const CHECKSUM_END = 156;

/** The sum of all the bytes with the checksum field counted as spaces, as unsigned and as signed bytes. */
function sums(block: Uint8Array): { unsigned: number; signed: number } {
  let unsigned = 0;
  let signed = 0;
  for (let at = 0; at < BLOCK; at += 1) {
    const byte = at >= CHECKSUM_AT && at < CHECKSUM_END ? 0x20 : (block[at] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return { unsigned, signed };
}

/**
 * Whether the checksum field is a number and is the sum of the block. Both sums are accepted, because
 * tar programs that disagreed about whether a byte is signed both exist, and both are still a check:
 * a block that is not a header does not add up either way.
 */
export function hasValidChecksum(block: Uint8Array): boolean {
  let stored: number;
  try {
    stored = numberField(block.subarray(CHECKSUM_AT, CHECKSUM_END), 'checksum');
  } catch {
    return false;
  }
  const { unsigned, signed } = sums(block);
  return stored === unsigned || stored === signed;
}

// ---------------------------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------------------------

const cString = (bytes: Uint8Array): Uint8Array => {
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
};

/** `ustar` and a NUL: the POSIX format, whose bytes at 345 are the prefix of the name. GNU's `ustar  ` is not. */
const isPosixUstar = (block: Uint8Array): boolean =>
  block[257] === 0x75 &&
  block[258] === 0x73 &&
  block[259] === 0x74 &&
  block[260] === 0x61 &&
  block[261] === 0x72 &&
  block[262] === 0;

function nameOf(block: Uint8Array): Uint8Array {
  const name = cString(block.subarray(0, 100));
  const prefix = isPosixUstar(block) ? cString(block.subarray(345, 500)) : new Uint8Array(0);
  if (prefix.length === 0) return name;
  const joined = new Uint8Array(prefix.length + 1 + name.length);
  joined.set(prefix);
  joined[prefix.length] = 0x2f;
  joined.set(name, prefix.length + 1);
  return joined;
}

/** The fields of a block whose checksum has been checked. */
export function readHeader(block: Uint8Array): TarHeader {
  const mode = numberField(block.subarray(100, 108), 'mode', true);
  if (!Number.isFinite(mode)) throw corrupt('the mode field of a header is not a number');
  return {
    nameBytes: nameOf(block),
    type: block[156] ?? 0,
    mode,
    size: numberField(block.subarray(124, 136), 'size'),
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
