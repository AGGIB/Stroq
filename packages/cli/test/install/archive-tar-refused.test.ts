import { describe, expect, it } from 'vitest';
import { ArchiveError, type ArchiveErrorCode } from '../../src/install/archive-error.js';
import { readTarArchive } from '../../src/install/archive-tar.js';
import { RAW_UNSAFE } from '../helpers/vet-world.js';
import {
  concat,
  dataBlocks,
  gzip,
  headerBlock,
  paxBlocks,
  paxRecord,
  tarOf,
  tgzOf,
  type TarEntry,
} from '../helpers/tar-writer.js';

/** The ArchiveError that reading the bytes throws; any other outcome fails the test. */
function refusal(bytes: Uint8Array): ArchiveError {
  try {
    readTarArchive(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) {
      // Whatever is refused, what is said can be printed: no raw control or invisible character.
      expect(error.message).not.toMatch(RAW_UNSAFE);
      return error;
    }
    throw error;
  }
  throw new Error('expected an ArchiveError, and nothing was thrown');
}

const GOOD: TarEntry = { name: 'pkg/ok.txt', data: 'fine' };
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
/** An entry whose name is these bytes, as they are, in the header. */
const rawNamed = (name: Uint8Array, data = ''): Uint8Array =>
  concat([headerBlock({ name, size: data.length }), ...(data === '' ? [] : [dataBlocks(data)])]);

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

  it('refuses a pax size that is less than the data, because the data would then be read as headers', () => {
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

describe('a name that is not safe', () => {
  /**
   * A file at the top, beside the name, keeps the one wrapping folder from being taken off, so that the
   * name is judged as it is spelled.
   */
  const SIBLING: TarEntry = { name: 'sibling.txt', data: 'x' };
  const carried = (name: string): TarEntry[] => [{ name, data: 'x', via: 'pax' }, SIBLING];

  it.each([
    ['a .. component', 'pkg/../evil.txt', /'\.' or '\.\.' component/],
    ['a leading ..', '../evil.txt', /'\.' or '\.\.' component/],
    ['an absolute path', '/etc/cron.d/evil', /absolute path/],
    ['a backslash', 'pkg\\evil.txt', /backslash/],
    ['a drive letter', 'C:/evil.txt', /drive letter/],
    ['a colon', 'pkg/dir/a:stream', /':'/],
    ['.git', 'pkg/.git/config', /\.git/],
    ['a Windows device', 'pkg/NUL', /Windows device name/],
    ['a Windows short name', 'pkg/GIT~1/config', /\.git|short name/],
    ['a name Windows will not make', 'pkg/a*b.txt', /Windows does not allow/],
    ['a trailing dot', 'pkg/a.', /ending in a dot or a space/],
    ['a leading ./', './a.txt', /'\.' or '\.\.' component/],
    ['an empty component', 'pkg//a.txt', /empty component/],
    ['a NUL in the middle', 'pkg/a\0b.txt', /control character/],
  ])('refuses %s, from a pax path and from the header', (_label, name, reason) => {
    // A NUL ends a name in a header, so there it can only be in a pax record.
    const header: TarEntry[] = [{ name, data: 'x' }, SIBLING];
    const ways = name.includes('\0') ? [carried(name)] : [carried(name), header];
    for (const entries of ways) {
      const error = refusal(tarOf(entries));

      expect(error.code).toBe('refused');
      expect(error.treeCode).toBe('bad-path');
      expect(error.message).toMatch(reason);
      expect(error.message).toMatch(/^entry ".*": path refused: /);
    }
  });

  it('refuses the folder an archive is wrapped in when its name is not safe, though it is taken off', () => {
    for (const [name, reason] of [
      ['C:/a.txt', /drive letter/],
      ['.git/config', /\.git/],
    ] as const) {
      const error = refusal(tarOf([{ name, data: 'x' }]));

      expect(error.code, name).toBe('refused');
      expect(error.message, name).toMatch(/the folder the archive is wrapped in/);
      expect(error.message, name).toMatch(reason);
    }
  });

  it('refuses a name that is a ../ below the folder that is taken off', () => {
    const error = refusal(
      tarOf([
        { name: 'pkg/ok.txt', data: 'x' },
        { name: 'pkg/../escape.txt', data: 'x' },
      ]),
    );

    expect(error.message).toMatch(/'\.' or '\.\.' component/);
  });

  it('writes a control character of a name out, and never repeats it', () => {
    const error = refusal(tarOf(carried('pkg/a\u001b[2Jb.txt')));

    expect(error.message).toContain('\\u001b');
    expect(error.message).not.toContain('\u001b');
  });

  it('writes a direction override out too', () => {
    const error = refusal(tarOf(carried('pkg/exe\u202etxt.sh')));

    expect(error.message).toContain('\\u202e');
  });

  it('refuses a name with a trailing slash on a file, with data or without', () => {
    // Without data this is how the v7 format writes a folder, which has no type of its own: it is refused too.
    for (const data of ['x', '']) {
      const error = refusal(
        tarOf([
          { name: 'pkg/dir/', data },
          { name: 'pkg/ok.txt', data: 'y' },
        ]),
      );

      expect(error.code, JSON.stringify(data)).toBe('refused');
      expect(error.message, JSON.stringify(data)).toMatch(/trailing slash/);
    }
  });

  it.each([
    ['a lone 0xff', [0xff]],
    ['an overlong NUL', [0xc0, 0x80]],
    ['a surrogate half', [0xed, 0xa0, 0x80]],
    ['a cut sequence', [0xe2, 0x82]],
    ['Latin-1 text', [0x63, 0x61, 0x66, 0xe9]],
  ])('refuses a name with %s, which is not valid UTF-8', (_label, bytes) => {
    const named = new Uint8Array([0x70, 0x2f, ...bytes, 0x2e, 0x74, 0x78, 0x74]);
    const carriers = [
      rawNamed(named, 'x'),
      concat(paxBlocks(paxRecord('path', named))),
      concat([
        headerBlock({
          name: '././@LongLink',
          typeflag: 'L',
          size: named.length + 1,
          format: 'gnu',
        }),
        dataBlocks(concat([named, new Uint8Array(1)])),
      ]),
    ];
    for (const [at, carrier] of carriers.entries()) {
      const entries =
        at === 0 ? [carrier] : [carrier, { name: 'placeholder', data: 'x' } as TarEntry];

      const error = refusal(tarOf(entries));

      expect(error.code, String(at)).toBe('refused');
      expect(error.message, String(at)).toMatch(/not valid UTF-8/);
    }
  });

  it('refuses a name that starts with a byte order mark, and does not drop the mark', () => {
    const named = new Uint8Array([0xef, 0xbb, 0xbf, ...text('a.txt')]);

    const error = refusal(tarOf([rawNamed(named, 'x')]));

    expect(error.code).toBe('refused');
    expect(error.message).toMatch(/invisible/);
  });

  it('refuses a name over the length of a path, and one so long it is not read', () => {
    const long = refusal(tarOf([{ name: `pkg/${'x'.repeat(300)}`, data: 'x', via: 'pax' }]));
    const huge = refusal(tarOf([{ name: `pkg/${'x'.repeat(600)}`, data: 'x', via: 'pax' }]));

    expect(long.code).toBe('refused');
    expect(long.message).toMatch(/longer than 240 bytes/);
    expect(huge.code).toBe('limit');
  });

  it('refuses a path deeper than the tree allows', () => {
    const deep = `${Array.from({ length: 24 }, (_, i) => `d${i}`).join('/')}/f.txt`;

    expect(refusal(tarOf([{ name: deep, data: 'x', via: 'pax' }])).message).toMatch(
      /deeper than 20/,
    );
  });

  it('refuses a GNU long name of 100 KiB as over the limit, without reading it', () => {
    const name = 'a'.repeat(100 * 1024);
    const bytes = tarOf([{ name, data: 'x', via: 'gnu' }]);

    const error = refusal(bytes);

    expect(error.code).toBe('limit');
    expect(error.message).not.toContain('aaaaaaaa');
  });

  it('refuses a pax path of 100 KiB as over the limit', () => {
    const error = refusal(tarOf([{ name: 'a'.repeat(100 * 1024), data: 'x', via: 'pax' }]));

    expect(error.code).toBe('limit');
  });
});

describe('names that are not names of different files', () => {
  it('refuses a path that is given twice, and says it once, with the name quoted', () => {
    const error = refusal(
      tarOf([
        { name: 'pkg/a.txt', data: 'one' },
        { name: 'pkg/a.txt', data: 'two' },
      ]),
    );

    expect(error.code).toBe('refused');
    expect(error.treeCode).toBe('duplicate-path');
    expect(error.message.match(/twice/g)).toHaveLength(1);
    expect(error.message).toContain('"a.txt"');
  });

  it('refuses a path given twice when the second is written another way', () => {
    const error = refusal(
      tarOf([
        { name: 'pkg/a.txt', data: 'one' },
        { name: 'ignored', data: 'two', pax: { path: 'pkg/a.txt' } },
      ]),
    );

    expect(error.message).toMatch(/twice/);
  });

  it.each([
    ['letters of two cases', 'pkg/README.md', 'pkg/readme.md'],
    ['a composed and a decomposed letter', 'pkg/\u00e9.md', 'pkg/e\u0301.md'],
    ['two folders spelled two ways', 'pkg/Docs/a.md', 'pkg/docs/b.md'],
  ])('refuses %s, because a disk that ignores them would merge the two', (_label, one, two) => {
    const error = refusal(
      tarOf([
        { name: one, data: '1' },
        { name: two, data: '2' },
      ]),
    );

    expect(error.code).toBe('refused');
    expect(error.treeCode).toBe('path-collision');
    expect(error.message).toMatch(
      /one name on a filesystem that ignores letter case or Unicode form/,
    );
    expect(error.message).not.toContain('README');
  });

  it('refuses a file that is also the folder of another', () => {
    const error = refusal(
      tarOf([
        { name: 'a', data: '1' },
        { name: 'a/b', data: '2' },
      ]),
    );

    expect(error.code).toBe('refused');
    expect(error.treeCode).toBe('path-conflict');
  });

  it('takes a folder entry for a folder, and refuses the file of the same name beside it', () => {
    const bytes = tarOf([
      { name: 'pkg/a/', typeflag: '5' },
      { name: 'pkg/a/b.txt', data: 'x' },
      { name: 'pkg/a', data: 'y' },
    ]);

    expect(refusal(bytes).treeCode).toMatch(/path-conflict|path-collision/);
  });
});

describe('what is wrapped in gzip', () => {
  it('refuses a gzip layer that is damaged, with the typed error and not a stack', () => {
    const bytes = tgzOf([GOOD]);
    const damaged = bytes.slice(0, bytes.length - 12);

    expect(refusal(damaged).code).toBe('bad-gzip');
  });

  it('refuses two gzip members, though the second one would read as more of the same tar', () => {
    const first = tarOf([GOOD], { end: 'none' });
    const second = concat([tarOf([{ name: 'pkg/b.txt', data: 'b' }])]);

    const error = refusal(concat([gzip(first), gzip(second)]));

    expect(error.code).toBe('bad-gzip');
    expect(error.message).toMatch(/more than one gzip member/);
  });

  it('refuses bytes after the gzip data', () => {
    const error = refusal(concat([tgzOf([GOOD]), text('trailing')]));

    expect(error.code).toBe('bad-gzip');
  });

  it('refuses a gzip bomb as over the limit, and does not hold what it expands to', () => {
    const bomb = gzip(new Uint8Array(48 * 1024 * 1024));

    const error = refusal(bomb);

    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/expands to more than 33554432 bytes/);
  });
});

describe('every refusal is one of the codes', () => {
  it('carries a code from the list and a name of its own', () => {
    const codes: ArchiveErrorCode[] = [
      refusal(text('x')).code,
      refusal(new Uint8Array(0)).code,
      refusal(tarOf([{ name: 'l', typeflag: '2' }])).code,
    ];

    expect(codes).toEqual(['not-a-tar', 'empty', 'unsupported']);
    expect(refusal(text('x')).name).toBe('ArchiveError');
  });
});
