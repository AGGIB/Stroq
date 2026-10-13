import { describe, expect, it } from 'vitest';
import { refusal } from '../helpers/archive-refusal.js';
import {
  bytesOfText,
  field,
  hiding,
  outerFields,
  pathsOf,
  unsignedSum,
} from '../helpers/tar-differential.js';
import {
  concat,
  dataBlocks,
  headerBlock,
  tarOf,
  type Format,
  type HeaderFields,
} from '../helpers/tar-writer.js';

/**
 * The numbers of a header and its checksum. npm's extractor throws on a number it cannot read, or
 * finds the checksum wrong, skips the header (512 bytes) and reads what comes next as a header: so an
 * archive with such a header in it is two archives, and this reader must refuse it, not read the one.
 * Every archive here is built in memory (`hiding` is the shape: see `helpers/tar-differential.ts`).
 */

// ---------------------------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------------------------

describe('the checksum of a header', () => {
  // Bytes above 127 in the name: the signed and the unsigned sum differ only for these.
  const NAME = `package/caf${String.fromCodePoint(0xe9)}.dat`;
  // The sums of the two headers that are written below, so that a refusal is for the spelling and
  // not for a sum that is wrong.
  const hidingSum = unsignedSum(outerFields());
  const plainSum = unsignedSum({ name: 'package/data.bin', size: 1 });
  const digits = (sum: number, width: number): string => sum.toString(8).padStart(width, '0');

  it('is the sum of the bytes as unsigned, and the signed sum is refused', () => {
    expect(headerBlock({ name: NAME, checksum: 'signed' })).not.toEqual(
      headerBlock({ name: NAME, checksum: 'unsigned' }),
    );
    expect(pathsOf(hiding({ name: NAME }))).toContain(`caf${String.fromCodePoint(0xe9)}.dat`);

    const later = refusal(hiding({ name: NAME, checksum: 'signed' }));
    const first = refusal(tarOf([{ name: NAME, data: 'x', header: { checksum: 'signed' } }]));

    expect(later.code).toBe('corrupt');
    expect(later.message).toMatch(/checksum/);
    expect(first.code).toBe('not-a-tar');
  });

  it.each([
    ['eight digits and no terminator', digits(hidingSum, 8)],
    ['seven digits and a letter', `${digits(hidingSum, 7)}x`],
    ['six digits, a NUL and a digit', `${digits(hidingSum, 6)}\x007`],
    ['six digits, a space and a digit', `${digits(hidingSum, 6)} 7`],
    ['a plus sign', `+${digits(hidingSum, 6)}\0`],
  ])('refuses a checksum of %s, which npm reads as another number or as none', (_what, text) => {
    const error = refusal(hiding({ checksum: text }));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/checksum/);
  });

  it.each([
    ['no digits at all', new Uint8Array(8)],
    ['only spaces', bytesOfText('        ')],
    [
      'a number in base 256',
      field(8, [0x80, 0, 0, 0, 0, hidingSum >> 16, (hidingSum >> 8) & 255, hidingSum & 255]),
    ],
  ])('refuses a checksum of %s', (_what, bytes) => {
    const error = refusal(hiding({ checksum: bytes }));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/checksum/);
  });

  it.each([
    ['six digits, a NUL and a space: GNU tar, Python, bsdtar', `${digits(plainSum, 6)}\0 `],
    ['seven digits and a NUL: git archive', `${digits(plainSum, 7)}\0`],
    ['six digits, a space and a NUL: npm pack', `${digits(plainSum, 6)} \0`],
    ['five digits behind a space', ` ${plainSum.toString(8)}\0`],
  ])('reads a checksum of %s', (_what, text) => {
    // The case would prove nothing if the digits were not the sum that is there.
    expect(Number.parseInt(text.trim(), 8)).toBe(plainSum);
    const bytes = tarOf([{ name: 'package/data.bin', data: 'x', header: { checksum: text } }]);

    expect(pathsOf(bytes)).toEqual(['data.bin']);
  });
});

// ---------------------------------------------------------------------------------------------
// The other numbers
// ---------------------------------------------------------------------------------------------

interface NumberField {
  readonly label: string;
  readonly at: number;
  readonly width: number;
  /** The formats whose header has this field: the device numbers are a ustar field, and v7 has none. */
  readonly formats: readonly Format[];
}

const EVERY_FORMAT: readonly Format[] = ['ustar', 'gnu', 'v7'];
const MODE: NumberField = { label: 'mode', at: 100, width: 8, formats: EVERY_FORMAT };
const SIZE: NumberField = { label: 'size', at: 124, width: 12, formats: EVERY_FORMAT };

/** Fields this reader never uses and npm's extractor reads, so a bad one is a difference between them. */
const UNUSED: readonly NumberField[] = [
  { label: 'user id', at: 108, width: 8, formats: EVERY_FORMAT },
  { label: 'group id', at: 116, width: 8, formats: EVERY_FORMAT },
  { label: 'modification time', at: 136, width: 12, formats: EVERY_FORMAT },
  { label: 'device major', at: 329, width: 8, formats: ['ustar', 'gnu'] },
  { label: 'device minor', at: 337, width: 8, formats: ['ustar', 'gnu'] },
];

const cases = (fields: readonly NumberField[]): [string, NumberField, Format][] =>
  fields.flatMap((one) =>
    one.formats.map((format): [string, NumberField, Format] => [
      `${one.label} of a ${format} header`,
      one,
      format,
    ]),
  );

/** A field of this width that is a base-256 number with this first byte and this last one. */
const base256 = (width: number, first: number, last = 1): Uint8Array => {
  const out = new Uint8Array(width);
  out[0] = first;
  out[width - 1] = last;
  return out;
};

/** A base-256 number with the first byte 0x80 whose value is more than a safe integer. */
const hugePositive = (width: number): Uint8Array =>
  new Uint8Array(width).fill(0xff).fill(0x80, 0, 1);

/** What a field of `width` bytes can hold that is not a number any program should read. */
const notNumbers = (width: number): [string, Uint8Array][] => [
  ['a base-256 number whose first byte is 0x81', base256(width, 0x81)],
  ['a base-256 number whose first byte is 0xC0', base256(width, 0xc0)],
  ['a base-256 number whose first byte is 0xFE', base256(width, 0xfe)],
  ['a base-256 number whose first byte is 0x7F, which is no number', base256(width, 0x7f)],
  ['a negative base-256 number past a safe integer', base256(width, 0xff, 0)],
  ['letters', field(width, 'abcdefghijkl'.slice(0, width - 1))],
  ['the digits 8 and 9', field(width, `${'9'.repeat(width - 2)}8`)],
  ['digits, a NUL and a digit', field(width, '12\0 3')],
  ['digits and a letter', field(width, `${'0'.repeat(width - 3)}1x`)],
  ['a minus sign', field(width, `-${'1'.padStart(width - 2, '0')}`)],
  ['a plus sign', field(width, `+${'1'.padStart(width - 2, '0')}`)],
  ['a tab before the digits', field(width, '\t755')],
];

const expectCorruptNumber = (bytes: Uint8Array, label: string): void => {
  const error = refusal(bytes);

  expect(error.code).toBe('corrupt');
  expect(error.message).toMatch(new RegExp(`the ${label} field of a header is`));
};

describe('the numbers of a header that are not the checksum', () => {
  describe.each(cases([...UNUSED, MODE, SIZE]))('the %s', (_label, one, format) => {
    it.each(notNumbers(one.width))('refuses %s', (_what, bytes) => {
      expectCorruptNumber(hiding({ format, patches: { [one.at]: bytes } }), one.label);
    });
  });

  describe.each(cases([...UNUSED, MODE]))('the %s', (_label, one, format) => {
    it('refuses a base-256 number past a safe integer, which npm throws on', () => {
      const huge = hugePositive(one.width);

      expectCorruptNumber(hiding({ format, patches: { [one.at]: huge } }), one.label);
    });
  });

  it('refuses a size in base 256 past a safe integer as over the limit, the way it always did', () => {
    const error = refusal(hiding({ patches: { [SIZE.at]: hugePositive(SIZE.width) } }));

    expect(error.code).toBe('limit');
  });

  it.each([MODE, SIZE].map((one) => [one.label, one] as const))(
    'refuses a negative number in the %s',
    (_label, one) => {
      const minusOne = new Uint8Array(one.width).fill(0xff);

      const error = refusal(hiding({ patches: { [one.at]: minusOne } }));

      expect(error.code).toBe('corrupt');
      expect(error.message).toMatch(new RegExp(`the ${one.label} field of a header is negative`));
    },
  );

  describe.each(cases(UNUSED))('reads what real writers put in the %s', (_label, one, format) => {
    const { width } = one;
    const read = (bytes: Uint8Array): string[] =>
      pathsOf(
        tarOf([
          { name: 'package/a.txt', data: 'x', header: { format, patches: { [one.at]: bytes } } },
        ]),
      );

    it.each([
      ['no bytes at all, as npm pack writes an owner and Python a device number', field(width, '')],
      ['spaces only', bytesOfText(' '.repeat(width))],
      ['zeros and a NUL: GNU tar, git, Python', field(width, '0'.repeat(width - 1))],
      ['digits, a space and a NUL: npm pack, bsdtar', field(width, `${'0'.repeat(width - 2)} `)],
      ['digits and a space: bsdtar for a time', bytesOfText(`${'1'.repeat(width - 1)} `)],
      ['digits behind spaces', field(width, '  755 ')],
      ['a base-256 number, as GNU tar writes a big id', base256(width, 0x80, 7)],
      ['-1 in base 256, as GNU tar writes a time before 1970', new Uint8Array(width).fill(0xff)],
    ])('%s', (_what, bytes) => {
      expect(read(bytes)).toEqual(['a.txt']);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// What real writers write, whole
// ---------------------------------------------------------------------------------------------

interface Writer {
  readonly label: string;
  readonly format: Format;
  readonly fields: Partial<HeaderFields>;
  /** How the sum is written in the checksum field. */
  readonly checksum: (sum: number) => string;
}

const six = (sum: number): string => sum.toString(8).padStart(6, '0');
const blank = (width: number): Uint8Array => new Uint8Array(width);

/**
 * Taken from archives written on 2026-10-13 by npm 11 (node-tar), bsdtar 3.5.3, Python 3.14 and git,
 * and read back byte by byte. GNU tar is not on that machine: its form is the one in its sources.
 */
const WRITERS: readonly Writer[] = [
  {
    label: 'npm pack (node-tar)',
    format: 'ustar',
    fields: {
      mode: '000644 \0',
      size: '0000000001 \0',
      patches: {
        108: blank(8),
        116: blank(8),
        136: '3560116604 \0',
        329: '000000 \0',
        337: '000000 \0',
      },
    },
    checksum: (sum) => `${six(sum)} \0`,
  },
  {
    label: 'bsdtar, pax and ustar',
    format: 'ustar',
    fields: {
      mode: '000644 \0',
      size: '00000000001 ',
      patches: {
        108: '000765 \0',
        116: '000000 \0',
        136: '15263344006 ',
        329: '000000 \0',
        337: '000000 \0',
      },
    },
    checksum: (sum) => `${six(sum)}\0 `,
  },
  {
    label: 'bsdtar gnutar, and the GNU format of Python',
    format: 'gnu',
    fields: {
      mode: '0000644\0',
      size: '00000000001\0',
      patches: {
        108: '0000765\0',
        116: '0000000\0',
        136: '15263344006\0',
        329: blank(8),
        337: blank(8),
      },
    },
    checksum: (sum) => `${six(sum)}\0 `,
  },
  {
    label: 'git archive',
    format: 'ustar',
    fields: {
      mode: '0000664\0',
      size: '00000000001\0',
      patches: {
        108: '0000000\0',
        116: '0000000\0',
        136: '15263344006\0',
        329: '0000000\0',
        337: '0000000\0',
      },
    },
    checksum: (sum) => `${sum.toString(8).padStart(7, '0')}\0`,
  },
  {
    label: 'Python, pax and ustar',
    format: 'ustar',
    fields: {
      mode: '0000644\0',
      size: '00000000001\0',
      patches: {
        108: '0000765\0',
        116: '0000000\0',
        136: '15263344007\0',
        329: blank(8),
        337: blank(8),
      },
    },
    checksum: (sum) => `${six(sum)}\0 `,
  },
];

describe('the headers that real writers write', () => {
  it.each(WRITERS.map((writer) => [writer.label, writer] as const))(
    'reads the file and the folder of %s',
    (_label, writer) => {
      const entry = (name: string, extra: Partial<HeaderFields>): Uint8Array => {
        const fields = { ...writer.fields, format: writer.format, name, ...extra };
        return headerBlock({ ...fields, checksum: writer.checksum(unsignedSum(fields)) });
      };
      const bytes = tarOf([
        entry('package/', { typeflag: '5', size: '00000000000\0' }),
        concat([entry('package/a.txt', {}), dataBlocks('x')]),
      ]);

      expect(pathsOf(bytes)).toEqual(['a.txt']);
    },
  );
});
