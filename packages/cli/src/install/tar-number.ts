// The numbers of a tar header, read as hostile bytes.
//
// Every number of a header is read, those this reader uses (the mode, the size, the checksum) and those
// it never does (the owner, the group, the time, the device numbers). The reason is the program that
// installs the archive afterwards: npm's extractor (node-tar) reads all of them, and a header with a
// number it cannot read is skipped by it, 512 bytes, and what comes next is read as a header. A reader
// that did not look would see one file where npm sees two, and the second would be one that was never
// in the tree that was looked at. So what a number may be is narrower here than in any extractor:
//
//  - octal digits, behind spaces, and then only spaces and NULs (a field of nothing but those is a blank
//    where a caller allows one: npm pack leaves the owner blank, Python the device numbers);
//  - or the GNU base-256 form, whose first byte is exactly 0x80 (positive) or exactly 0xFF (negative,
//    for a caller that allows one). Any other byte with the high bit set is no number;
//  - and a number far past what any file has is refused, or, for a size, returned as Infinity so that
//    the limits refuse it before a byte is sliced.
//
// The checksum is the one field that is also read for where it ends: it is octal digits and then a NUL
// or a space, because npm reads 12 bytes for it (the type and the link name come after the eight that
// are the field), and a field of eight digits is a different number to it.
import { ArchiveError } from './archive-error.js';

/** More than a file can be and less than a double can hold exactly: past this a field is "too big". */
const TOO_BIG = 2 ** 40;
const BASE256_POSITIVE = 0x80;
const BASE256_NEGATIVE = 0xff;
const SPACE = 0x20;

export interface NumberRules {
  /** A field of spaces and NULs only is 0. */
  readonly blank?: boolean;
  /** A negative base-256 number is allowed (a time before 1970); it comes back negative. */
  readonly negative?: boolean;
  /** A number past `TOO_BIG` comes back as Infinity, not as a refusal: the caller judges it by a limit. */
  readonly huge?: boolean;
  /** The checksum form: octal only, and a NUL or a space has to end the digits. */
  readonly checksum?: boolean;
}

const corrupt = (what: string, problem: string): ArchiveError =>
  new ArchiveError('corrupt', `the ${what} field of a header is ${problem}`);

/** The size of the two's-complement number in the field, as an unsigned size: -1 is 1, and so on. */
function negativeMagnitude(field: Uint8Array): bigint {
  let value = 0n;
  for (const byte of field) value = value * 256n + BigInt(byte);
  return (1n << BigInt(8 * field.length)) - value;
}

function base256(field: Uint8Array, what: string, rules: NumberRules): number {
  const first = field[0] ?? 0;
  if (first === BASE256_NEGATIVE) {
    if (rules.negative !== true) throw corrupt(what, 'negative');
    const magnitude = negativeMagnitude(field);
    if (magnitude > BigInt(TOO_BIG)) throw corrupt(what, 'too large');
    return -Number(magnitude);
  }
  if (first !== BASE256_POSITIVE) throw corrupt(what, 'not a number');
  let value = 0;
  for (let at = 1; at < field.length; at += 1) {
    value = value * 256 + (field[at] ?? 0);
    if (value > TOO_BIG) {
      if (rules.huge === true) return Infinity;
      throw corrupt(what, 'too large');
    }
  }
  return value;
}

/** Octal digits behind leading spaces, and then nothing but spaces and NULs (for a checksum, at least one of them). */
function octal(field: Uint8Array, what: string, rules: NumberRules): number {
  let at = 0;
  while (at < field.length && field[at] === SPACE) at += 1;
  let value = 0;
  let digits = 0;
  for (; at < field.length; at += 1) {
    const digit = (field[at] ?? 0) - 0x30;
    if (digit < 0 || digit > 7) break;
    value = value * 8 + digit;
    digits += 1;
  }
  if (rules.checksum === true && at === field.length)
    throw corrupt(what, 'not ended by a NUL or a space');
  for (; at < field.length; at += 1) {
    if (field[at] !== 0 && field[at] !== SPACE) throw corrupt(what, 'not a number');
  }
  if (digits === 0 && rules.blank !== true) throw corrupt(what, 'not a number');
  return value;
}

/** The number in a field, or an ArchiveError of the code `corrupt` that says which field and what is wrong with it. */
export function readNumber(field: Uint8Array, what: string, rules: NumberRules = {}): number {
  const isBase256 = ((field[0] ?? 0) & 0x80) !== 0 && rules.checksum !== true;
  if (isBase256) return base256(field, what, rules);
  return octal(field, what, rules);
}
