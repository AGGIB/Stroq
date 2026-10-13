import { describe, expect, it } from 'vitest';
import { ArchiveError, type ArchiveErrorCode } from '../../src/install/archive-error.js';
import { readTarArchive } from '../../src/install/archive-tar.js';
import { GOOD, rawNamed, refusal, text } from '../helpers/archive-refusal.js';
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

  it('tells how to make the archive again when every name starts with ./, as a tar made inside a folder writes them', () => {
    const error = refusal(
      tarOf([
        { name: './', typeflag: '5' },
        { name: './SKILL.md', data: 's' },
        { name: './scripts/run.sh', data: 'r' },
      ]),
    );

    expect(error.code).toBe('refused');
    expect(error.message).toMatch(/path refused: '\.' or '\.\.' component/);
    expect(error.message).toMatch(/make the archive from the folder above it/);
    // A name that merely starts with a dot is not that case, and gets no advice about it.
    expect(refusal(tarOf([{ name: '../x.txt', data: 'x' }, GOOD])).message).not.toMatch(
      /folder above/,
    );
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

  describe('the depth of a path, at the edge', () => {
    const pathOf = (components: number): string =>
      Array.from({ length: components }, (_, i) => `d${i}`).join('/');
    const TOP: TarEntry = { name: 'top.txt', data: 't' };

    it('reads 20 components, and 21 when one of them is the folder that wraps the archive', () => {
      expect(
        readTarArchive(tarOf([{ name: pathOf(20), data: 'x', via: 'pax' }, TOP])).tree.entries,
      ).toHaveLength(2);
      expect(readTarArchive(tarOf([{ name: pathOf(21), data: 'x', via: 'pax' }])).topFolder).toBe(
        'd0',
      );
    });

    it('refuses 21 components that nothing wraps, by the rules of the tree, and 22 as over the limit', () => {
      const tree = refusal(tarOf([{ name: pathOf(21), data: 'x', via: 'pax' }, TOP]));
      const early = refusal(tarOf([{ name: pathOf(22), data: 'x', via: 'pax' }]));

      expect(tree.code).toBe('refused');
      expect(tree.message).toMatch(/deeper than 20/);
      expect(early.code).toBe('limit');
      expect(early.message).toMatch(/deeper than 20/);
    });
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
