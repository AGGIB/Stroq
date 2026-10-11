import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../../src/harden/atomic.js';
import { assertUnchanged } from '../../src/harden/recheck.js';
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

  it('waits with the real clock when it is not given a sleep of its own', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs } = flaky('EBUSY', 1);

    await writeFileAtomic(file, 'new', { fs });

    expect(readFileSync(file, 'utf8')).toBe('new');
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

/**
 * The last look at the target is only worth anything if it comes right before the file is
 * replaced. A rename that is tried again comes after a wait, and a wait is exactly when whoever
 * holds the file (an editor, an indexer) is likely to be saving it: the look has to be taken again.
 */
describe('writeFileAtomic: the last look comes before every try', () => {
  /** An Fs that fails the first `failures` renames with EBUSY, and a log of what happened. */
  function logged(failures: number, whileWaiting: () => void = () => undefined) {
    const events: string[] = [];
    let renames = 0;
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) => {
        events.push('rename');
        return (renames += 1) <= failures
          ? Promise.reject(failure('EBUSY'))
          : nodeFs.rename(from, to);
      },
    };
    const sleep = (): Promise<void> => {
      events.push('sleep');
      whileWaiting();
      return Promise.resolve();
    };
    const look = (): void => {
      events.push('look');
    };
    return { fs, sleep, look, events };
  }

  it('looks before the first try and again before each try that follows a wait', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, look, events } = logged(2);

    await writeFileAtomic(file, 'new', { fs, sleep, beforeRename: look });

    expect(events).toEqual([
      'look',
      'rename',
      'sleep',
      'look',
      'rename',
      'sleep',
      'look',
      'rename',
    ]);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('does not replace a file that was saved while it waited, and leaves the saved text', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep } = logged(1, () => writeFileSync(file, 'the owner saved this'));

    const error = await writeFileAtomic(file, 'new', {
      fs,
      sleep,
      beforeRename: () => assertUnchanged(file, file, Buffer.from('old')),
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'stale-plan' });
    expect(readFileSync(file, 'utf8')).toBe('the owner saved this');
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('does not try the rename again once a look fails, and reports that failure', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const { fs, sleep, events } = logged(99);
    let looks = 0;

    const error = await writeFileAtomic(file, 'new', {
      fs,
      sleep,
      beforeRename: () => {
        if ((looks += 1) === 2) throw new Error('changed under us');
      },
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ message: 'changed under us' });
    expect(events.filter((event) => event === 'rename')).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });
});
