import { mkdtempSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLock } from '../../src/util/lock.js';

describe('withLock', () => {
  it('serialises concurrent critical sections', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'x.lock');
    let counter = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(lock, async () => {
          const seen = counter;
          await new Promise((r) => setTimeout(r, 5));
          counter = seen + 1;
        }),
      ),
    );
    expect(counter).toBe(10);
  });
  it('releases the lock when the function throws', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'y.lock');
    await expect(
      withLock(lock, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withLock(lock, async () => 'ok')).resolves.toBe('ok');
  });
  it('times out when the lock is held too long', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'z.lock');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((r) => {
      acquired = r;
    });
    const holder = withLock(
      lock,
      async () => {
        acquired();
        await held;
      },
      { staleMs: 10_000 },
    );
    await acquiredPromise; // holder definitely owns the lock now
    await expect(
      withLock(lock, async () => 1, { timeoutMs: 100, staleMs: 10_000 }),
    ).rejects.toThrow(/timeout/);
    release();
    await holder;
  });
  it('preserves the original error when releasing the lock also fails', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'w.lock');
    const rm = async () => {
      throw new Error('release failed');
    };
    const err: unknown = await withLock(
      lock,
      async () => {
        throw new Error('boom');
      },
      { fs: { mkdir, rm: rm as typeof import('node:fs/promises').rm, stat } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    expect(((err as Error).cause as Error)?.message).toBe('release failed');
  });
  it('surfaces the release error when the function itself succeeds', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'v.lock');
    const rm = async () => {
      throw new Error('release failed');
    };
    await expect(
      withLock(lock, async () => 'ok', {
        fs: { mkdir, rm: rm as typeof import('node:fs/promises').rm, stat },
      }),
    ).rejects.toThrow('release failed');
  });
});
