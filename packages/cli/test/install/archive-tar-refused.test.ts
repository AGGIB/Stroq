import { describe, expect, it } from 'vitest';
import { readTarArchive } from '../../src/install/archive-tar.js';
import { GOOD, refusal, text } from '../helpers/archive-refusal.js';
import {
  concat,
  dataBlocks,
  gzip,
  headerBlock,
  paxBlocks,
  tarOf,
  tgzOf,
} from '../helpers/tar-writer.js';

describe('an archive that is not a tar archive', () => {
  it.each([
    [
      'a zip file',
      concat([new Uint8Array([0x50, 0x4b, 0x03, 0x04]), new Uint8Array(600).fill(7)]),
      /zip/,
    ],
    ['a short zip file', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), /zip/],
    [
      'an xz file',
      concat([new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), new Uint8Array(600)]),
      /xz/,
    ],
    ['text', text('hello world, this is not an archive. '.repeat(30)), /not a tar archive/],
    ['a few bytes', text('hello'), /not a tar archive/],
    ['bytes that are all ones', new Uint8Array(1024).fill(0xff), /not a tar archive/],
    ['a gzip of text', gzip(text('hello world '.repeat(100))), /not a tar archive/],
  ])('refuses %s as not a tar archive', (_label, bytes, message) => {
    const error = refusal(bytes);

    expect(error.code).toBe('not-a-tar');
    expect(error.message).toMatch(message);
  });

  it('refuses a first header whose checksum is wrong as not a tar archive', () => {
    const error = refusal(tarOf([{ name: 'a', header: { checksum: 'wrong' } }]));

    expect(error.code).toBe('not-a-tar');
  });

  it('does not take a tar file for a bzip2 file because a name in it starts with BZh', () => {
    const bytes = tarOf([{ name: 'BZh91AY&SY.txt', data: 'x' }]);

    expect(readTarArchive(bytes).tree.entries).toHaveLength(1);
  });
});

describe('an archive with no files', () => {
  it.each([
    ['no bytes at all', new Uint8Array(0)],
    ['nothing but the end marker', tarOf([])],
    [
      'only folders',
      tarOf([
        { name: 'pkg/', typeflag: '5' },
        { name: 'pkg/empty/', typeflag: '5' },
      ]),
    ],
    ['a gzip of nothing', gzip(new Uint8Array(0))],
    ['a gzip of the end marker', tgzOf([])],
  ])('says it has no files: %s', (_label, bytes) => {
    const error = refusal(bytes);

    expect(error.code).toBe('empty');
    expect(error.message).toMatch(/no files/);
  });
});

describe('a header that does not hold together', () => {
  it('refuses a wrong checksum after the first header', () => {
    const error = refusal(tarOf([GOOD, { name: 'pkg/b.txt', header: { checksum: 'wrong' } }]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/checksum/);
  });

  it('refuses a checksum that is not a number', () => {
    const error = refusal(tarOf([GOOD, { name: 'pkg/b.txt', header: { checksum: 'abcdefg ' } }]));

    expect(error.code).toBe('corrupt');
  });

  it.each([
    ['a size that is not a number', { size: 'zzzzzzzzzzz\0' }, /size/],
    ['a size with a letter in the digits', { size: '0000000001a\0' }, /size/],
    ['a negative size in the GNU form', { size: new Uint8Array(12).fill(0xff) }, /size/],
    ['a mode that is not a number', { mode: 'rwxr-xr-' }, /mode/],
  ])('refuses %s', (_label, header, message) => {
    const error = refusal(tarOf([GOOD, { name: 'pkg/b.txt', header }]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(message);
  });

  it('refuses a header that is cut short, and says so', () => {
    const cut = concat([tarOf([GOOD], { end: 'none' }), new Uint8Array(300).fill(1)]);

    const error = refusal(cut);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/ends in the middle of a header/);
  });

  it('refuses an archive with no end marker, and one with half of it', () => {
    for (const end of ['none', 'one'] as const) {
      const error = refusal(tarOf([GOOD], { end }));

      expect(error.code, end).toBe('corrupt');
      expect(error.message, end).toMatch(/without its end marker/);
    }
  });

  it('refuses an empty block in the middle of the archive', () => {
    const bytes = concat([tarOf([GOOD], { end: 'one' }), headerBlock({ name: 'pkg/late.txt' })]);

    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/empty block/);
  });

  it('refuses data after the end of the archive, however little', () => {
    for (const tail of [
      [1],
      [0, 0, 1],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
    ]) {
      const bytes = tarOf([GOOD], { after: concat([new Uint8Array(1000), new Uint8Array(tail)]) });

      const error = refusal(bytes);

      expect(error.code, tail.join()).toBe('corrupt');
      expect(error.message, tail.join()).toMatch(/data after the end of the archive/);
    }
  });

  it('refuses another archive appended after the end marker', () => {
    const bytes = concat([tarOf([GOOD]), tarOf([{ name: 'pkg/second.txt', data: 'b' }])]);

    expect(refusal(bytes).message).toMatch(/data after the end of the archive/);
  });

  it('refuses a folder that has data', () => {
    const bytes = concat([
      headerBlock({ name: 'pkg/', typeflag: '5', size: 5 }),
      dataBlocks('hello'),
      tarOf([GOOD]),
    ]);

    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/folder.*data/);
  });
});

describe('data that is cut short', () => {
  it('refuses a file whose data ends before its size says', () => {
    const bytes = concat([
      headerBlock({ name: 'pkg/a.txt', size: 1000 }),
      new Uint8Array(600).fill(0x61),
    ]);

    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/ends inside the data of a file/);
  });

  it('refuses a file whose data is all there and whose padding is not', () => {
    const bytes = concat([
      headerBlock({ name: 'pkg/a.txt', size: 600 }),
      new Uint8Array(600).fill(0x61),
    ]);

    expect(refusal(bytes).message).toMatch(/ends inside the data of a file/);
  });

  it('refuses a size far larger than the archive, without reading past the end', () => {
    const bytes = concat([headerBlock({ name: 'pkg/a.txt', size: 100_000 }), new Uint8Array(3000)]);

    expect(refusal(bytes).code).toBe('corrupt');
  });

  it('refuses a pax size below the size in the header, whose rest a program that believes it reads as headers', () => {
    const bytes = tarOf([
      { name: 'pkg/a.txt', data: 'a'.repeat(1000), pax: { size: '3' }, header: { size: 1000 } },
    ]);

    expect(refusal(bytes).code).toBe('corrupt');
  });
});

describe('what an extended header may say', () => {
  it('refuses one with no entry after it', () => {
    const error = refusal(tarOf([concat(paxBlocks({ path: 'a.txt' }))]));

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/not followed by the entry it describes/);
  });

  it.each([
    ['two pax headers', [paxBlocks({ path: 'a' }), paxBlocks({ path: 'b' })]],
    ['a pax header and a global one', [paxBlocks({ path: 'a' }), paxBlocks({ comment: 'c' }, 'g')]],
    [
      'a long name and a pax header',
      [
        [
          headerBlock({ name: '././@LongLink', typeflag: 'L', size: 2, format: 'gnu' }),
          dataBlocks('a\0'),
        ],
        paxBlocks({ mtime: '1' }),
      ],
    ],
  ])('refuses %s in a row', (_label, groups) => {
    const bytes = tarOf([concat(groups.flat()), { name: 'pkg/a.txt', data: 'x' }]);

    expect(refusal(bytes).message).toMatch(/not followed by the entry it describes/);
  });

  it('refuses a global header that sets a name or a size, which would change every entry after it', () => {
    for (const records of [{ path: 'everything-is-here' }, { size: '5' }, { linkpath: 'x' }]) {
      const error = refusal(tarOf([concat(paxBlocks(records, 'g')), GOOD]));

      expect(error.code, JSON.stringify(records)).toBe('unsupported');
      expect(error.message, JSON.stringify(records)).toMatch(/global/);
    }
  });

  it.each(['GNU.sparse.major', 'GNU.sparse.name', 'GNU.sparse.realsize', 'SCHILY.realsize'])(
    'refuses the sparse record %s, in an entry and in a global header',
    (key) => {
      const entry = refusal(tarOf([{ name: 'pkg/a.txt', data: 'x', pax: { [key]: '1' } }]));
      const global = refusal(tarOf([concat(paxBlocks({ [key]: '1' }, 'g')), GOOD]));

      expect(entry.code).toBe('unsupported');
      expect(entry.message).toMatch(/sparse/);
      expect(global.code).toBe('unsupported');
    },
  );

  it.each([
    ['a length that runs past the data', '99 path=a\n'],
    ['a length that is too short for the record', '3 path=a\n'],
    ['a record with no equals sign', '13 pathpatha\n'],
    ['a record with no newline', '9 path=ab'],
    ['a record with no length', 'path=a\n'],
    ['a record with no key', '6 =ab\n'],
    ['padding after the last record', '14 path=a.txt\n\0\0'],
    ['a length with too many digits', '00000000000012 path=a\n'],
  ])('refuses %s', (_label, records) => {
    const bytes = tarOf([concat(paxBlocks(text(records))), { name: 'x', data: 'x' }]);

    const error = refusal(bytes);

    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/extended header/);
  });

  it('refuses a size record that is not a number', () => {
    for (const size of ['abc', '-5', '5.5', '', '1e3', '99999999999999999999']) {
      const bytes = tarOf([{ name: 'pkg/a.txt', data: 'x', pax: { size } }]);

      expect(refusal(bytes).code, size).toMatch(/corrupt|limit/);
    }
  });
});

describe('an entry of a kind that is not read', () => {
  const NAME = 'secret-entry-name';
  const LINK = '/etc/passwd-target';

  it.each([
    ['a symbolic link', '2', /an archive with a link is not read/],
    ['a hard link', '1', /an archive with a link is not read/],
    ['a character device', '3', /device/],
    ['a block device', '4', /device/],
    ['a FIFO', '6', /FIFO/],
    ['a contiguous file', '7', /contiguous/],
    ['a GNU sparse file', 'S', /sparse/],
    ['a GNU long link name', 'K', /long link/],
    ['a GNU volume label', 'V', /unknown type/],
    ['a GNU multi-volume continuation', 'M', /unknown type/],
    ['a GNU dump directory', 'D', /unknown type/],
    ['a type nobody has heard of', 'Z', /unknown type/],
    ['a digit that is no type', '9', /unknown type/],
    ['a control byte for a type', '\u0007', /unknown type/],
  ])('refuses %s, with a fixed phrase and no name', (_label, typeflag, message) => {
    const bytes = tarOf([
      GOOD,
      { name: NAME, typeflag, linkname: LINK, header: { size: 0 } },
      { name: 'pkg/after.txt', data: 'a' },
    ]);

    const error = refusal(bytes);

    expect(error.code).toBe('unsupported');
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain(NAME);
    expect(error.message).not.toContain('passwd');
  });

  it('refuses the whole archive for one link, wherever it is, and does not skip it', () => {
    const first = tarOf([{ name: 'pkg/link', typeflag: '2', linkname: 'ok.txt' }, GOOD]);
    const last = tarOf([GOOD, { name: 'pkg/link', typeflag: '2', linkname: 'ok.txt' }]);

    expect(refusal(first).code).toBe('unsupported');
    expect(refusal(last).code).toBe('unsupported');
  });

  it('refuses a link that has a pax header before it', () => {
    const bytes = tarOf([{ name: 'pkg/link', typeflag: '2', linkname: 'x', pax: { mtime: '1' } }]);

    expect(refusal(bytes).message).toMatch(/an archive with a link is not read/);
  });
});
