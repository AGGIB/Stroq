import { mkdtempSync } from 'node:fs';
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
    const holder = withLock(lock, () => new Promise((r) => setTimeout(r, 300)), {
      staleMs: 10_000,
    });
    await expect(withLock(lock, async () => 1, { timeoutMs: 50, staleMs: 10_000 })).rejects.toThrow(
      /timeout/,
    );
    await holder;
  });
});
