import { execFileSync } from 'node:child_process';
import { chmodSync, ftruncateSync, mkdirSync, openSync, closeSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveError } from '../../src/install/archive-error.js';
import { readArchiveFile } from '../../src/install/archive-file.js';
import { ReadDirError } from '../../src/install/read-dir.js';
import { sourceTypeOf } from '../../src/install/read-source.js';
import { treeDigest } from '../../src/install/tree.js';
import { removeTempRoots, tempRoot } from '../helpers/install-dir.js';
import { gzip, tarOf, tgzOf, type TarEntry } from '../helpers/tar-writer.js';

afterEach(removeTempRoots);

const isWindows = process.platform === 'win32';
const isRoot = process.getuid?.() === 0;
const FILES: TarEntry[] = [
  { name: 'pkg/SKILL.md', data: '# s\n' },
  { name: 'pkg/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
];

/** A file under a folder of its own, named as the test says. */
function fileWith(name: string, bytes: Uint8Array | string): { file: string; root: string } {
  const root = tempRoot('archive');
  const file = join(root, name);
  writeFileSync(file, bytes);
  return { file, root };
}

async function refusal(run: () => Promise<unknown>): Promise<ArchiveError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ArchiveError) return error;
    throw error;
  }
  throw new Error('expected an ArchiveError, and nothing was thrown');
}

describe('readArchiveFile', () => {
  it('reads a gzipped archive, and the same one plain', async () => {
    const zipped = await readArchiveFile(fileWith('skill.tgz', tgzOf(FILES)).file);
    const plain = await readArchiveFile(fileWith('skill.tar', tarOf(FILES)).file);

    expect(treeDigest(zipped.tree)).toBe(treeDigest(plain.tree));
    expect(zipped.tree.entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'run.sh']);
    expect(zipped.topFolder).toBe('pkg');
  });

  it('decides gzip by the bytes and not by the name of the file', async () => {
    const names = [
      ['gzip-named-txt.txt', tgzOf(FILES)],
      ['gzip-without-extension', tgzOf(FILES)],
      ['tar-named-tgz.tgz', tarOf(FILES)],
      ['tar-named-gz.tar.gz', tarOf(FILES)],
    ] as const;
    const digests = new Set<string>();
    for (const [name, bytes] of names) {
      digests.add(treeDigest((await readArchiveFile(fileWith(name, bytes).file)).tree));
    }

    expect(digests.size).toBe(1);
  });

  it('keeps the executable bit of the archive, on every platform', async () => {
    const read = await readArchiveFile(fileWith('skill.tgz', tgzOf(FILES)).file);

    expect(read.tree.entries.map((entry) => [entry.path, entry.exec])).toEqual([
      ['SKILL.md', false],
      ['run.sh', true],
    ]);
    expect(read.blindSpots).toEqual([]);
  });

  it('says there is nothing at a path that is not there, and does not print the path', async () => {
    const { root } = fileWith('other', 'x');

    for (const path of [join(root, 'not-there.tgz'), '']) {
      const error = await refusal(() => readArchiveFile(path));

      expect(error.code).toBe('not-found');
      expect(error.message).toBe('there is nothing at the path to read');
      expect(error.message).not.toContain(root);
    }
  });

  it.skipIf(isWindows)('says a folder is not a file', async () => {
    const root = tempRoot('archive');
    mkdirSync(join(root, 'folder.tgz'));

    const error = await refusal(() => readArchiveFile(join(root, 'folder.tgz')));

    expect(error.code).toBe('not-a-file');
  });

  it.skipIf(isWindows)('does not open a FIFO to wait for a writer, and says it is not a file', async () => {
    const root = tempRoot('archive');
    execFileSync('mkfifo', [join(root, 'pipe.tgz')]);

    const error = await refusal(() => readArchiveFile(join(root, 'pipe.tgz')));

    expect(error.code).toBe('not-a-file');
  });

  it.skipIf(isWindows)('reads through a link to a file, as the folder reader does through a link to a folder', async () => {
    const { file, root } = fileWith('real.tgz', tgzOf(FILES));
    symlinkSync(file, join(root, 'link.tgz'));

    const read = await readArchiveFile(join(root, 'link.tgz'));

    expect(read.tree.entries).toHaveLength(2);
  });

  it('refuses a file that is too big for its kind without reading it', async () => {
    const root = tempRoot('archive');
    const big = join(root, 'sparse.tar');
    const fd = openSync(big, 'w');
    // A sparse file of 80 MiB: if it were read, the test would take a while and a lot of memory.
    ftruncateSync(fd, 80 * 1024 * 1024);
    closeSync(fd);

    const error = await refusal(() => readArchiveFile(big));

    expect(error.code).toBe('limit');
    expect(error.message).toMatch(/over 33554432 bytes/);
    expect(error.message).not.toContain(root);
  });

  it('holds a gzip file to the size of a download, and a plain one to the size of an expanded archive', async () => {
    const zipped = fileWith('a.tgz', tgzOf(FILES)).file;
    const plain = fileWith('a.tar', tarOf(FILES)).file;

    expect((await refusal(() => readArchiveFile(zipped, { limits: { maxCompressed: 20 } }))).message).toMatch(/compressed/);
    expect((await refusal(() => readArchiveFile(plain, { limits: { maxExpanded: 2000 } }))).code).toBe('limit');
    // The plain one is not held to the size of a download, nor the gzip one to that of an expanded archive.
    expect((await readArchiveFile(plain, { limits: { maxCompressed: 20 } })).tree.entries).toHaveLength(2);
  });

  it('refuses a file that is not an archive with the reader\'s phrase, not a system error', async () => {
    const { file } = fileWith('notes.txt', 'just some notes\n'.repeat(60));

    const error = await refusal(() => readArchiveFile(file));

    expect(error.code).toBe('not-a-tar');
  });

  it('refuses a zip file by name, whatever the file is called', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0]);

    const error = await refusal(() => readArchiveFile(fileWith('skill.tar.gz', zip).file));

    expect(error.code).toBe('not-a-tar');
    expect(error.message).toMatch(/zip/);
  });

  it('reads an empty file as an archive with nothing in it', async () => {
    const error = await refusal(() => readArchiveFile(fileWith('empty.tgz', new Uint8Array(0)).file));

    expect(error.code).toBe('empty');
  });

  it.skipIf(isWindows || isRoot)('says a file it may not read is unreadable, with the errno and without the path', async () => {
    const { file, root } = fileWith('locked.tgz', tgzOf(FILES));
    chmodSync(file, 0o000);

    const error = await refusal(() => readArchiveFile(file));

    expect(error.code).toBe('unreadable');
    expect(error.message).toContain('EACCES');
    expect(error.message).not.toContain(root);
  });

  it('passes the typed error of the reader on, and a gzip that is damaged is one', async () => {
    const whole = gzip(tarOf(FILES));
    const { file } = fileWith('cut.tgz', whole.subarray(0, whole.length - 10));

    expect((await refusal(() => readArchiveFile(file))).code).toBe('bad-gzip');
  });
});

describe('sourceTypeOf', () => {
  it('tells a folder from a file, which is what picks the reader', async () => {
    const { file, root } = fileWith('skill.tgz', tgzOf(FILES));

    expect(await sourceTypeOf(root)).toBe('dir');
    expect(await sourceTypeOf(file)).toBe('tarball');
  });

  it('says there is nothing at a path that is not there, with the phrase the folder reader uses', async () => {
    const { root } = fileWith('x', 'x');

    for (const path of [join(root, 'nothing'), '']) {
      const error = await sourceTypeOf(path).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ReadDirError);
      expect((error as ReadDirError).code).toBe('not-found');
      expect((error as ReadDirError).message).toBe('there is nothing at the path to read');
    }
  });

  it.skipIf(isWindows)('follows a link once, as the folder reader does, and says what is at the end', async () => {
    const { file, root } = fileWith('skill.tgz', tgzOf(FILES));
    symlinkSync(file, join(root, 'file-link'));
    symlinkSync(root, join(root, 'dir-link'));

    expect(await sourceTypeOf(join(root, 'file-link'))).toBe('tarball');
    expect(await sourceTypeOf(join(root, 'dir-link'))).toBe('dir');
  });

  it.skipIf(isWindows)('refuses a FIFO, which is neither, and does not open it', async () => {
    const root = tempRoot('archive');
    execFileSync('mkfifo', [join(root, 'pipe')]);

    const error = await sourceTypeOf(join(root, 'pipe')).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as ReadDirError).code).toBe('not-a-directory');
    expect((error as ReadDirError).message).toBe('the path is not a folder or a file');
  });
});
