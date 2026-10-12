import {
  chmodSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadDirError, readDirTree, type ReadDirErrorCode } from '../../src/install/read-dir.js';
import { LIMITS } from '../../src/install/types.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';

afterEach(removeTempRoots);

const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** What a read refuses with, or a failure of the test when it does not refuse. */
async function refusal(run: () => Promise<unknown>): Promise<ReadDirError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ReadDirError) return error;
    throw error;
  }
  throw new Error('expected a ReadDirError, and nothing was thrown');
}

const codeOf = async (run: () => Promise<unknown>): Promise<ReadDirErrorCode> =>
  (await refusal(run)).code;

describe('readDirTree: limits are typed errors and never a partial tree', () => {
  it('refuses a file over the size a file may be, without reading it', async () => {
    const root = tempRoot();
    writeFiles(root, { 'small.txt': 'ok' });
    // A hole in a file costs nothing to make and reads as zeros: only its size is looked at.
    const huge = join(root, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, LIMITS.maxFileBytes + 1);

    const error = await refusal(() => readDirTree(root));

    expect(error.code).toBe('limit');
    expect(error.treeCode).toBe('limit');
    expect(error.message).toContain('huge.bin');
  });

  it('takes a file of exactly the largest size', async () => {
    const root = tempRoot();
    const exact = join(root, 'exact.bin');
    writeFileSync(exact, '');
    truncateSync(exact, 1024);

    const { tree } = await readDirTree(root, { limits: { maxFileBytes: 1024 } });

    expect(tree.entries[0]?.size).toBe(1024);
  });

  it('refuses a tree of more bytes than all the files may be together', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'x'.repeat(600), 'b.txt': 'y'.repeat(600) });

    expect(await codeOf(() => readDirTree(root, { limits: { maxExpanded: 1000 } }))).toBe('limit');
  });

  it('refuses a tree of more entries than a tree may have, as it counts them', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4' });

    const error = await refusal(() => readDirTree(root, { limits: { maxEntries: 3 } }));

    expect(error.code).toBe('limit');
    expect(error.message).toContain('3');
  });

  it.skipIf(isWindows)('counts a link as an entry too', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': '1', 'b.txt': '2' });
    symlinkSync('a.txt', join(root, 'link'));

    expect(await codeOf(() => readDirTree(root, { limits: { maxEntries: 2 } }))).toBe('limit');
  });

  it('stops listing a folder of far more names than a tree could hold', async () => {
    const root = tempRoot();
    for (let i = 0; i < 30; i += 1) mkdirSync(join(root, `d${i}`));

    expect(await codeOf(() => readDirTree(root, { limits: { maxEntries: 5 } }))).toBe('limit');
  });

  it('accepts a path of the most components a path may have', async () => {
    const root = tempRoot();
    const parts = Array.from({ length: LIMITS.maxDepth - 1 }, (_, i) => `d${i}`);
    writeFiles(root, { [`${parts.join('/')}/leaf.txt`]: 'leaf' });

    const { tree } = await readDirTree(root);

    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.path.split('/')).toHaveLength(LIMITS.maxDepth);
  });

  it('refuses a folder nested deeper than a path may go, and does not walk down it', async () => {
    const root = tempRoot();
    const parts = Array.from({ length: LIMITS.maxDepth + 1 }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...parts), { recursive: true });
    writeFiles(root, { [`${parts.join('/')}/leaf.txt`]: 'leaf' });

    expect(await codeOf(() => readDirTree(root))).toBe('limit');
  });

  it('refuses a deep folder even when nothing is in it, because it will not walk that far', async () => {
    const root = tempRoot();
    const parts = Array.from({ length: LIMITS.maxDepth + 5 }, (_, i) => `d${i}`);
    mkdirSync(join(root, ...parts), { recursive: true });

    expect(await codeOf(() => readDirTree(root))).toBe('limit');
  });
});

describe('readDirTree: the options cannot raise a limit', () => {
  it('uses the limit of the contract when asked for more', async () => {
    const root = tempRoot();
    const huge = join(root, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, LIMITS.maxFileBytes + 1);

    const outcome = await codeOf(() =>
      readDirTree(root, { limits: { maxFileBytes: LIMITS.maxFileBytes * 4 } }),
    );

    expect(outcome).toBe('limit');
  });
});

describe('readDirTree: names are checked by the tree, and are never echoed raw', () => {
  const nameTest = it.skipIf(isWindows);

  nameTest('refuses a name with a control character and writes it out in the message', async () => {
    const root = tempRoot();
    writeFiles(root, { 'bad\u001b[31mname.txt': 'x' });

    const error = await refusal(() => readDirTree(root));

    expect(error.code).toBe('refused');
    expect(error.treeCode).toBe('bad-path');
    expect(error.message).not.toContain('\u001b');
    expect(error.message).toContain('\\u001b');
  });

  nameTest('refuses a name with a direction override and does not print it', async () => {
    const root = tempRoot();
    writeFiles(root, { 'evil‮txt.exe': 'x' });

    const error = await refusal(() => readDirTree(root));

    expect(error.treeCode).toBe('bad-path');
    expect(error.message).not.toContain('‮');
  });

  nameTest('refuses a name longer than a path may be, and clips it in the message', async () => {
    const root = tempRoot();
    const long = `${'n'.repeat(250)}.txt`;
    writeFiles(root, { [long]: 'x' });

    const error = await refusal(() => readDirTree(root));

    expect(error.code).toBe('refused');
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).not.toContain(long);
  });

  nameTest('refuses a name with a colon, a stream on some disks', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a:b.txt': 'x' });

    expect(await codeOf(() => readDirTree(root))).toBe('refused');
  });

  nameTest('refuses a name that is a Windows device', async () => {
    const root = tempRoot();
    writeFiles(root, { 'nul.txt': 'x' });

    expect(await codeOf(() => readDirTree(root))).toBe('refused');
  });

  nameTest(
    'refuses two names a disk that ignores case would merge, where the disk keeps both',
    async () => {
      const root = tempRoot();
      writeFiles(root, { README: 'one', readme: 'two' });
      // A disk that ignores case (the default on macOS) keeps only one of them, and there is nothing to refuse.
      const kept = readdirSync(root);

      const outcome = await readDirTree(root).then(
        () => 'read',
        (error: unknown) => (error instanceof ReadDirError ? (error.treeCode ?? 'none') : 'other'),
      );

      expect(outcome).toBe(kept.length === 2 ? 'path-collision' : 'read');
    },
  );
});

describe('readDirTree: the path it is given', () => {
  it('says not-found for a path that is not there', async () => {
    const root = tempRoot();

    expect(await codeOf(() => readDirTree(join(root, 'missing')))).toBe('not-found');
  });

  it('says not-a-directory for a file', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'a' });

    expect(await codeOf(() => readDirTree(join(root, 'a.txt')))).toBe('not-a-directory');
  });

  it('says not-found for an empty path', async () => {
    expect(await codeOf(() => readDirTree(''))).toBe('not-found');
  });
});

describe.skipIf(isWindows || isRoot)('readDirTree: what cannot be read', () => {
  it('says unreadable for a folder it may not list, and names it safely', async () => {
    const root = tempRoot();
    writeFiles(root, { 'locked/a.txt': 'a', 'ok.txt': 'ok' });
    const locked = join(root, 'locked');
    chmodSync(locked, 0o000);
    try {
      const error = await refusal(() => readDirTree(root));

      expect(error.code).toBe('unreadable');
      expect(error.message).toContain('locked');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('says unreadable for a file it may not open', async () => {
    const root = tempRoot();
    writeFiles(root, { 'secret.txt': 'x' });
    const file = join(root, 'secret.txt');
    chmodSync(file, 0o000);
    try {
      expect(await codeOf(() => readDirTree(root))).toBe('unreadable');
    } finally {
      chmodSync(file, 0o644);
    }
  });
});
