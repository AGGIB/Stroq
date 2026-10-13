import { describe, expect, it } from 'vitest';
import { ARCHIVE_BLIND_SPOTS, readTarArchive } from '../../src/install/archive-tar.js';
import { treeDigest } from '../../src/install/tree.js';
import { treeOf } from '../helpers/install-tree.js';
import {
  concat,
  dataBlocks,
  gzip,
  headerBlock,
  paxBlocks,
  tarOf,
  tgzOf,
  type TarEntry,
} from '../helpers/tar-writer.js';

/** The paths of a tree, in the order of the digest, and what each holds. */
const pathsOf = (bytes: Uint8Array): string[] =>
  readTarArchive(bytes).tree.entries.map((entry) => entry.path);

const textOf = (bytes: Uint8Array, path: string): string | undefined => {
  const found = readTarArchive(bytes).tree.entries.find((entry) => entry.path === path);
  return found?.bytes === undefined ? undefined : new TextDecoder().decode(found.bytes);
};

const FILES = [
  { name: 'SKILL.md', data: '---\nname: s\n---\n# s\n' },
  { name: 'scripts/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
  { name: 'docs/notes.txt', data: 'notes' },
] as const satisfies readonly TarEntry[];

const EXPECTED = treeOf({
  'SKILL.md': '---\nname: s\n---\n# s\n',
  'scripts/run.sh': { text: '#!/bin/sh\necho hi\n', exec: true },
  'docs/notes.txt': 'notes',
});

describe('readTarArchive: files', () => {
  it('reads files into the tree that the same files in a folder would give', () => {
    const read = readTarArchive(tarOf(FILES));

    expect(treeDigest(read.tree)).toBe(treeDigest(EXPECTED));
    expect(read.tree.entries.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'docs/notes.txt',
      'scripts/run.sh',
    ]);
    expect(read.blindSpots).toEqual([]);
    expect(read.topFolder).toBeNull();
  });

  it('keeps the bytes of every file, as a tree that is to be looked at must', () => {
    expect(textOf(tarOf(FILES), 'docs/notes.txt')).toBe('notes');
    expect(textOf(tarOf(FILES), 'scripts/run.sh')).toBe('#!/bin/sh\necho hi\n');
  });

  it('reads the same archive when it is gzipped, and decides that by the bytes', () => {
    const plain = readTarArchive(tarOf(FILES));
    const zipped = readTarArchive(tgzOf(FILES));

    expect(treeDigest(zipped.tree)).toBe(treeDigest(plain.tree));
  });

  it('reads an empty file, and a file whose bytes are not text', () => {
    const bytes = tarOf([
      { name: 'empty' },
      { name: 'blob.bin', data: new Uint8Array([0, 255, 128, 10, 13]) },
    ]);
    const entries = readTarArchive(bytes).tree.entries;

    expect(entries.map((entry) => [entry.path, entry.size])).toEqual([
      ['blob.bin', 5],
      ['empty', 0],
    ]);
  });

  it('does not record a directory, so that an empty directory is not in the digest', () => {
    const withFolders = tarOf([
      { name: 'README.md', data: 'r' },
      { name: 'docs/', typeflag: '5' },
      { name: 'docs/empty/', typeflag: '5' },
      { name: 'docs/a.md', data: 'a' },
    ]);

    expect(pathsOf(withFolders)).toEqual(['README.md', 'docs/a.md']);
    expect(treeDigest(readTarArchive(withFolders).tree)).toBe(
      treeDigest(treeOf({ 'README.md': 'r', 'docs/a.md': 'a' })),
    );
  });

  it('does not change the bytes it is given, and keeps its own copy of the files', () => {
    const bytes = tarOf(FILES);
    const before = bytes.slice();

    const read = readTarArchive(bytes);
    const digest = treeDigest(read.tree);
    bytes.fill(0x41);

    expect(before).not.toEqual(bytes);
    expect(treeDigest(read.tree)).toBe(digest);
  });

  it('reads UTF-8 names as they are spelled, with no normalisation', () => {
    // Built from code points, so that no editor or tool turns an escape in this file into the character.
    const composed = `${String.fromCodePoint(0xe9)}.md`;
    const decomposed = `e${String.fromCodePoint(0x301)}.txt`;
    const japanese = `docs/${String.fromCodePoint(0x65e5, 0x672c)}.txt`;
    const emoji = `emoji-${String.fromCodePoint(0x1f600)}.txt`;
    const bytes = tarOf([
      { name: composed, data: 'a' },
      { name: decomposed, data: 'b' },
      { name: japanese, data: 'c' },
      { name: emoji, data: 'd' },
    ]);

    // In the order of the bytes of the names: the decomposed letter starts with a plain e.
    expect(pathsOf(bytes)).toEqual([japanese, emoji, decomposed, composed]);
  });
});

describe('readTarArchive: the executable bit', () => {
  it.each([
    ['0755', 0o755, true],
    ['0644', 0o644, false],
    ['0100, owner execute alone', 0o100, true],
    ['0010, group execute alone', 0o010, false],
    ['0001, other execute alone', 0o001, false],
    ['0600', 0o600, false],
    ['04755, set-user-id and owner execute', 0o4755, true],
    ['0000', 0, false],
    ['0100644, file type bits in the mode', 0o100644, false],
    ['0100755, file type bits in the mode', 0o100755, true],
  ])('is the owner-execute bit of the mode, and nothing else: %s', (_label, mode, exec) => {
    const entry = readTarArchive(tarOf([{ name: 'f', mode }])).tree.entries[0];

    expect(entry?.exec).toBe(exec);
  });

  it('reads a mode written with leading spaces and a trailing space, as some writers do', () => {
    const header = headerBlock({ name: 'f', mode: '  755 \0\0' });

    expect(readTarArchive(tarOf([header])).tree.entries[0]?.exec).toBe(true);
  });

  it('says in a blind spot that a set-user-id, set-group-id or sticky bit was not kept', () => {
    for (const mode of [0o4755, 0o2755, 0o1755, 0o4644]) {
      const read = readTarArchive(tarOf([{ name: 'f', mode }]));

      expect(read.blindSpots, mode.toString(8)).toEqual([ARCHIVE_BLIND_SPOTS.specialModeBits]);
    }
    expect(readTarArchive(tarOf([{ name: 'f', mode: 0o755 }])).blindSpots).toEqual([]);
  });
});

describe('readTarArchive: how a name is carried', () => {
  const LONG_DIR = 'a-directory-with-a-rather-long-name'.repeat(2);
  const LONG = `${LONG_DIR}/${'b'.repeat(40)}/file.txt`;
  // A file at the top, beside the others, keeps the one wrapping folder from being taken off, so that the
  // names are the ones that were written.
  const TOP: TarEntry = { name: 'top.txt', data: 't' };
  const namesOf = (entries: readonly (TarEntry | Uint8Array)[]): string[] =>
    pathsOf(tarOf([...entries, TOP])).filter((path) => path !== TOP.name);

  it('joins the ustar prefix and the name', () => {
    expect(namesOf([{ name: LONG, data: 'x', via: 'prefix' }])).toEqual([LONG]);
  });

  it('reads a GNU long name from the block before the entry', () => {
    expect(namesOf([{ name: LONG, data: 'x', via: 'gnu' }])).toEqual([LONG]);
  });

  it('reads a pax path, which wins over the name in the header', () => {
    expect(namesOf([{ name: LONG, data: 'x', via: 'pax' }])).toEqual([LONG]);
  });

  it('takes the pax path for a name that the header could hold too', () => {
    const entry: TarEntry = {
      name: 'short-name-in-header',
      data: 'x',
      pax: { path: 'from/pax.txt' },
    };

    expect(namesOf([entry])).toEqual(['from/pax.txt']);
  });

  it('takes a GNU long name over the name in the header', () => {
    const header = headerBlock({ name: 'placeholder', size: 1, format: 'gnu' });
    const long = concat([new TextEncoder().encode('from/gnu.txt'), new Uint8Array(1)]);
    const gnu = [
      headerBlock({ name: '././@LongLink', typeflag: 'L', size: long.length, format: 'gnu' }),
      dataBlocks(long),
      header,
      dataBlocks('x'),
    ];

    expect(namesOf([concat(gnu)])).toEqual(['from/gnu.txt']);
  });

  it('reads the bytes at 345 as a prefix when the header is ustar', () => {
    const entry: TarEntry = { name: 'real.txt', data: 'x', header: { prefix: 'some/folder' } };

    expect(namesOf([entry])).toEqual(['some/folder/real.txt']);
  });

  it('reads a name that fills all 100 bytes of the field, with no NUL to end it', () => {
    const name = `${'d'.repeat(49)}/${'f'.repeat(50)}`;

    expect(name.length).toBe(100);
    expect(namesOf([{ name, data: 'x' }])).toEqual([name]);
  });
});

describe('readTarArchive: sizes and extended headers', () => {
  it('reads a pax size that is the size in the header, and takes the pax size as the size', () => {
    const bytes = tarOf([
      { name: 'big.txt', data: 'hello', pax: { size: '5' } },
      { name: 'next.txt', data: 'after' },
    ]);

    expect(pathsOf(bytes)).toEqual(['big.txt', 'next.txt']);
    expect(textOf(bytes, 'big.txt')).toBe('hello');
    expect(textOf(bytes, 'next.txt')).toBe('after');
  });

  it('reads a size written in the GNU base-256 form', () => {
    const size = new Uint8Array(12);
    size[0] = 0x80;
    size[11] = 5;

    const bytes = tarOf([{ name: 'a.txt', data: 'hello', header: { size } }]);

    expect(textOf(bytes, 'a.txt')).toBe('hello');
  });

  it('applies a pax header to the next entry only', () => {
    const bytes = tarOf([
      { name: 'first.txt', data: 'a', pax: { path: 'renamed.txt' } },
      { name: 'second.txt', data: 'b' },
    ]);

    expect(pathsOf(bytes)).toEqual(['renamed.txt', 'second.txt']);
  });

  it('reads the global header that git archive writes, and keeps nothing of it', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const bytes = tarOf([
      concat(paxBlocks({ comment: commit }, 'g')),
      { name: 'owner-repo-0123abc/', typeflag: '5' },
      { name: 'owner-repo-0123abc/README.md', data: 'hi' },
    ]);
    const read = readTarArchive(bytes);

    expect(read.commit).toBe(commit);
    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['README.md']);
    expect(read.topFolder).toBe('owner-repo-0123abc');
  });

  it('does not allow a second global pax header to overwrite the commit from the first', () => {
    const commit1 = '0123456789abcdef0123456789abcdef01234567';
    const commit2 = 'ffffffffffffffffffffffffffffffffffffffff';
    const bytes = tarOf([
      concat(paxBlocks({ comment: commit1 }, 'g')),
      { name: 'README.md', data: 'hello' },
      concat(paxBlocks({ comment: commit2 }, 'g')),
      { name: 'second.md', data: 'world' },
    ]);
    const read = readTarArchive(bytes);
    expect(read.commit).toBe(commit1);
  });

  it('ignores the pax attributes that are not about the name or the size', () => {
    const bytes = tarOf([
      {
        name: 'a.txt',
        data: 'x',
        pax: {
          mtime: '1700000000.123456789',
          atime: '1',
          uid: '1000',
          gid: '1000',
          uname: 'someone',
          gname: 'somegroup',
          'SCHILY.xattr.user.note': 'metadata',
          'LIBARCHIVE.creationtime': '1',
          charset: 'ISO-IR 10646 2000 UTF-8',
        },
      },
    ]);

    expect(pathsOf(bytes)).toEqual(['a.txt']);
  });

  it('lets a later pax record of one key win over an earlier one', () => {
    const records = new TextEncoder().encode('18 path=first.txt\n18 path=other.txt\n');
    const bytes = tarOf([concat(paxBlocks(records)), { name: 'x', data: 'x' }]);

    expect(pathsOf(bytes)).toEqual(['other.txt']);
  });
});

describe('readTarArchive: the header checksum', () => {
  it('is the sum of the bytes as unsigned, whatever the bytes are (the signed sum is refused: see archive-tar-numbers)', () => {
    // Bytes above 127 in the name: the signed and the unsigned sum differ only for these.
    const name = `caf${String.fromCodePoint(0xe9)}-${String.fromCodePoint(0xfc)}ber.md`;

    expect(pathsOf(tarOf([{ name, data: 'x', header: { checksum: 'unsigned' } }]))).toEqual([name]);
    // The two sums differ for this name, or the case would prove nothing.
    expect(headerBlock({ name, checksum: 'signed' })).not.toEqual(
      headerBlock({ name, checksum: 'unsigned' }),
    );
  });
});

describe('readTarArchive: the end of the archive', () => {
  it('ends at two zero blocks, with or without the padding to a record of 20 blocks', () => {
    for (const end of ['two', 'padded'] as const) {
      expect(pathsOf(tarOf(FILES, { end })), end).toHaveLength(3);
    }
  });

  it('accepts any amount of zeros after the end', () => {
    const bytes = tarOf(FILES, { after: new Uint8Array(100_000) });

    expect(pathsOf(bytes)).toHaveLength(3);
  });
});

describe('readTarArchive: the folder an archive is wrapped in', () => {
  it('takes off the one folder that every path is in, and says its name', () => {
    const read = readTarArchive(
      tarOf([
        { name: 'package/', typeflag: '5' },
        { name: 'package/package.json', data: '{}' },
        { name: 'package/lib/index.js', data: 'x' },
      ]),
    );

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['lib/index.js', 'package.json']);
    expect(read.topFolder).toBe('package');
  });

  it('takes off the folder that GitHub names after the owner, the repository and the commit', () => {
    const read = readTarArchive(
      tgzOf([
        { name: 'octo-skills-4f2a9c1/', typeflag: '5' },
        { name: 'octo-skills-4f2a9c1/SKILL.md', data: '# s' },
      ]),
    );

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['SKILL.md']);
    expect(read.topFolder).toBe('octo-skills-4f2a9c1');
  });

  it('takes off exactly one folder, and not the one below it', () => {
    const read = readTarArchive(
      tarOf([
        { name: 'pkg/sub/a.txt', data: 'x' },
        { name: 'pkg/sub/b.txt', data: 'y' },
      ]),
    );

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['sub/a.txt', 'sub/b.txt']);
    expect(read.topFolder).toBe('pkg');
  });

  it('takes nothing off when there are two folders', () => {
    const read = readTarArchive(
      tarOf([
        { name: 'a/x.txt', data: 'x' },
        { name: 'b/y.txt', data: 'y' },
      ]),
    );

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['a/x.txt', 'b/y.txt']);
    expect(read.topFolder).toBeNull();
  });

  it('takes nothing off when a file is at the top, beside the folder', () => {
    const read = readTarArchive(
      tarOf([
        { name: 'README.md', data: 'r' },
        { name: 'pkg/y.txt', data: 'y' },
      ]),
    );

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['README.md', 'pkg/y.txt']);
    expect(read.topFolder).toBeNull();
  });

  it('takes nothing off a single file at the top', () => {
    const read = readTarArchive(tarOf([{ name: 'SKILL.md', data: 's' }]));

    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['SKILL.md']);
    expect(read.topFolder).toBeNull();
  });

  it('gives the digest of the folder it was made from, whatever the wrapping folder is called', () => {
    const wrapped = (top: string) =>
      tarOf(FILES.map((file) => ({ ...file, name: `${top}/${file.name}` })));

    expect(treeDigest(readTarArchive(wrapped('package')).tree)).toBe(treeDigest(EXPECTED));
    expect(treeDigest(readTarArchive(wrapped('x-y-1a2b3c4')).tree)).toBe(treeDigest(EXPECTED));
  });

  it('ignores a folder entry that holds no file when it decides what is shared', () => {
    const read = readTarArchive(
      tarOf([
        { name: 'package/', typeflag: '5' },
        { name: 'elsewhere/', typeflag: '5' },
        { name: 'package/a.txt', data: 'a' },
      ]),
    );

    expect(read.topFolder).toBe('package');
  });
});

describe('readTarArchive: a gzipped archive and a plain one are the same archive', () => {
  it('reads a tar that a gzip of the whole file wraps, whatever the name of the file would have said', () => {
    const plain = tarOf(FILES);

    expect(pathsOf(gzip(plain))).toEqual(pathsOf(plain));
  });
});
