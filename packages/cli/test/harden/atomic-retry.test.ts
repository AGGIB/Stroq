import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../../src/harden/atomic.js';
import type { Fs } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const failure = (code: string): Error => Object.assign(new Error(`simulated ${code}`), { code });

/** An Fs whose rename fails with `code` the first `times` times, and a record of what happened. */
function flaky(code: string, times: number) {
  const calls = { renames: 0, sleeps: [] as number[] };
  const fs: Fs = {
    ...nodeFs,
    rename: (from, to) =>
      (calls.renames += 1) <= times ? Promise.reject(failure(code)) : nodeFs.rename(from, to),
  };
  const sleep = (ms: number): Promise<void> => {
    calls.sleeps.push(ms);
    return Promise.resolve();
  };
  return { fs, sleep, calls };
}

/**
 * Windows refuses a rename onto a file that another handle (an editor, an indexer, a virus
 * scanner) holds for a moment, with EPERM or EBUSY, and the same call succeeds a moment later.
 * The writer waits a little and tries again, a few times, and no more.
 */
describe('writeFileAtomic: a rename that is refused for a moment', () => {
  it.each(['EPERM', 'EBUSY'])('tries again after %s, and the file gets written', async (code) => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, calls } = flaky(code, 2);

    await writeFileAtomic(file, 'new', { fs, sleep });

    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(calls.renames).toBe(3);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('waits a short, growing time between tries, through the sleep it was given', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, calls } = flaky('EBUSY', 2);

    await writeFileAtomic(file, 'new', { fs, sleep });

    expect(calls.sleeps).toHaveLength(2);
    expect(calls.sleeps.every((ms) => ms > 0 && ms <= 250)).toBe(true);
    expect(calls.sleeps[1]).toBeGreaterThan(calls.sleeps[0] ?? Infinity);
  });

  it('does not wait at all when the first try works', async () => {
    const dir = tempDir();
    const { fs, sleep, calls } = flaky('EBUSY', 0);

    await writeFileAtomic(join(dir, 'a.json'), 'x', { fs, sleep });

    expect(calls.renames).toBe(1);
    expect(calls.sleeps).toEqual([]);
  });

  it('gives up after three tries, reports the refusal, and leaves the file and the directory as they were', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, calls } = flaky('EPERM', 99);

    const error = await writeFileAtomic(file, 'new', { fs, sleep }).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'EPERM' });
    expect(calls.renames).toBe(3);
    expect(calls.sleeps).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it.each(['EXDEV', 'ENOSPC', 'EACCES', 'EIO'])('does not try again after %s', async (code) => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, calls } = flaky(code, 99);

    await expect(writeFileAtomic(file, 'new', { fs, sleep })).rejects.toMatchObject({ code });

    expect(calls.renames).toBe(1);
    expect(calls.sleeps).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('keeps the temporary file for every try, and removes it only when it is done', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const seen: string[] = [];
    let tries = 0;
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) => {
        seen.push(from);
        return (tries += 1) < 3 ? Promise.reject(failure('EBUSY')) : nodeFs.rename(from, to);
      },
    };

    await writeFileAtomic(file, 'new', { fs, sleep: () => Promise.resolve() });

    expect(new Set(seen).size).toBe(1);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });
});
