import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withConfigurationLock } from '../src/config-lock.js';

const made: string[] = [];
const tempDir = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `stroq-config-lock-${label}-`)));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const onWindows = process.platform === 'win32';

describe('withConfigurationLock', () => {
  it('lets one writer at a time through, so that no update is lost', async () => {
    const home = tempDir('home');
    const env = { home };
    let inside = 0;
    let overlapped = false;
    let total = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        withConfigurationLock(env, async () => {
          inside += 1;
          if (inside > 1) overlapped = true;
          const seen = total;
          // A pause between the read and the write: without the lock, writers overlap here.
          await new Promise((resolve) => setTimeout(resolve, 5));
          total = seen + 1;
          inside -= 1;
        }),
      ),
    );

    expect(overlapped).toBe(false);
    expect(total).toBe(20);
  });

  it('hands back what the function returned, and lets go of the lock', async () => {
    const home = tempDir('home');

    const value = await withConfigurationLock({ home }, () => Promise.resolve(42));

    expect(value).toBe(42);
    expect(readdirSync(join(home, 'harden'))).toEqual([]);
  });

  it('lets go of the lock when the function fails, and says what failed', async () => {
    const home = tempDir('home');

    await expect(
      withConfigurationLock({ home }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow(/boom/);

    expect(readdirSync(join(home, 'harden'))).toEqual([]);
    await expect(withConfigurationLock({ home }, () => Promise.resolve('again'))).resolves.toBe(
      'again',
    );
  });

  it('times out with a lock-timeout error while another writer holds it', async () => {
    const home = tempDir('home');
    let release: () => void = () => undefined;
    const held = withConfigurationLock(
      { home },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      withConfigurationLock({ home }, () => Promise.resolve(), { timeoutMs: 50 }),
    ).rejects.toThrow(/^lock timeout:/);

    release();
    await held;
  });

  it.skipIf(onWindows)('makes the directory it needs private', async () => {
    const home = tempDir('home');

    const previous = process.umask(0);
    try {
      await withConfigurationLock({ home }, () => Promise.resolve());
    } finally {
      process.umask(previous);
    }

    expect(statSync(join(home, 'harden')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(onWindows)('refuses a lock directory that is a link out of the home', async () => {
    const home = tempDir('home');
    const outside = tempDir('outside');
    mkdirSync(home, { recursive: true });
    symlinkSync(outside, join(home, 'harden'));

    await expect(withConfigurationLock({ home }, () => Promise.resolve())).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});
