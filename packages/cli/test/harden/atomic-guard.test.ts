import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../../src/harden/atomic.js';
import type { Fs } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * `beforeRename` is the last moment the writer can look at the target again: the new content is
 * on disk in the temporary file, and the next step is the one that replaces the old file. A
 * caller that checks "is it still what I read?" there has narrowed the window in which the owner
 * can lose an edit to the time between that read and the rename. No portable call compares and
 * swaps a file, so the window is narrowed and not closed.
 */
describe('writeFileAtomic: the last look before the rename', () => {
  it('runs after the content is flushed and the handle is closed, and before the rename', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');
    const calls: string[] = [];
    const fs: Fs = {
      ...nodeFs,
      open: async (path, flags, mode) => {
        const handle = await nodeFs.open(path, flags, mode);
        return {
          writeFile: (data) => (calls.push('write'), handle.writeFile(data)),
          chmod: (m) => (calls.push('chmod'), handle.chmod(m)),
          sync: () => (calls.push('sync'), handle.sync()),
          close: () => (calls.push('close'), handle.close()),
        };
      },
      rename: (from, to) => (calls.push('rename'), nodeFs.rename(from, to)),
    };

    await writeFileAtomic(file, 'new', { fs, beforeRename: () => void calls.push('before') });

    expect(calls).toEqual(['write', 'chmod', 'sync', 'close', 'before', 'rename']);
  });

  it('can stop the replacement: the target is untouched and no temporary file is left', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');
    let renames = 0;
    const fs: Fs = { ...nodeFs, rename: (from, to) => (renames++, nodeFs.rename(from, to)) };

    await expect(
      writeFileAtomic(file, 'new', {
        fs,
        beforeRename: () => {
          throw new Error('not any more');
        },
      }),
    ).rejects.toThrow(/not any more/);

    expect(renames).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('is waited for when it is asynchronous, and its failure is the one reported', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');

    await expect(
      writeFileAtomic(file, 'new', {
        beforeRename: async () => {
          await Promise.resolve();
          throw new Error('late no');
        },
      }),
    ).rejects.toThrow(/late no/);

    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('lets the write through when it returns', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');

    await writeFileAtomic(file, 'new', { beforeRename: () => undefined });

    expect(readFileSync(file, 'utf8')).toBe('new');
  });
});
