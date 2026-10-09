import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../../src/harden/atomic.js';
import type { Fs } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

/** The file names in a directory, so a leftover temp file shows up in an assertion. */
const names = (dir: string): string[] => readdirSync(dir).sort();

/** An Fs that behaves as the real one except where `overrides` say otherwise. */
const fsWith = (overrides: Partial<Fs>): Fs => ({ ...nodeFs, ...overrides });

describe('writeFileAtomic', () => {
  it('replaces the content of an existing file and leaves nothing else behind', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old\n');

    const result = await writeFileAtomic(file, 'new\n');

    expect(readFileSync(file, 'utf8')).toBe('new\n');
    expect(result).toEqual({ real: file, created: false });
    expect(names(dir)).toEqual(['settings.json']);
  });

  it('creates a file that is not there yet, and the directory it goes in', async () => {
    const dir = tempDir();
    const file = join(dir, '.claude', 'settings.json');

    const result = await writeFileAtomic(file, '{}\n');

    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(result.created).toBe(true);
  });

  it('writes bytes exactly as given', async () => {
    const dir = tempDir();
    const file = join(dir, 'blob');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0d, 0x0a]);

    await writeFileAtomic(file, bytes);

    expect([...readFileSync(file)]).toEqual([...bytes]);
  });

  describe.skipIf(onWindows)('file modes', () => {
    it('keeps the mode of the file it replaces', async () => {
      const dir = tempDir();
      const file = join(dir, 'a.json');
      writeFileSync(file, 'x');
      chmodSync(file, 0o640);

      await writeFileAtomic(file, 'y');

      expect(statSync(file).mode & 0o777).toBe(0o640);
    });

    it('makes a new file private unless told otherwise', async () => {
      const dir = tempDir();
      const file = join(dir, 'new.json');

      await writeFileAtomic(file, 'y');

      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('uses the mode it is told for a new file, and ignores it for an existing one', async () => {
      const dir = tempDir();
      const fresh = join(dir, 'fresh');
      const existing = join(dir, 'existing');
      writeFileSync(existing, 'x');
      chmodSync(existing, 0o600);

      await writeFileAtomic(fresh, 'y', { mode: 0o644 });
      await writeFileAtomic(existing, 'y', { mode: 0o644 });

      expect(statSync(fresh).mode & 0o777).toBe(0o644);
      expect(statSync(existing).mode & 0o777).toBe(0o600);
    });

    // A mode passed to open() is cut by the umask; the engine sets the bits itself, so that the
    // mode a file had is the mode it keeps whatever shell the user happens to run in.
    it('keeps the mode exactly even under a strict umask', async () => {
      const dir = tempDir();
      const file = join(dir, 'a.json');
      writeFileSync(file, 'x');
      chmodSync(file, 0o644);

      const previous = process.umask(0o077);
      try {
        await writeFileAtomic(file, 'y');
      } finally {
        process.umask(previous);
      }

      expect(statSync(file).mode & 0o777).toBe(0o644);
    });
  });

  it('names the temporary file after the real one, the process and a random part', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const opened: string[] = [];
    const fs = fsWith({
      open: (path, flags, mode) => {
        opened.push(path);
        return nodeFs.open(path, flags, mode);
      },
    });

    await writeFileAtomic(file, 'new', { fs });
    await writeFileAtomic(file, 'newer', { fs });

    const [first, second] = opened.map((path) => basename(path));
    const shape = new RegExp(`^\\.settings\\.json\\.stroq-${process.pid}-[0-9a-f]{8,}\\.tmp$`);
    expect(first).toMatch(shape);
    expect(second).toMatch(shape);
    expect(first).not.toBe(second);
  });

  it('writes, sets the mode, flushes to disk and only then renames', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');
    const calls: string[] = [];
    const fs = fsWith({
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
    });

    await writeFileAtomic(file, 'new', { fs });

    expect(calls).toEqual(['write', 'chmod', 'sync', 'close', 'rename']);
  });

  describe('when a step fails', () => {
    it('leaves the target byte-identical and no temporary file when the rename fails', async () => {
      const dir = tempDir();
      const file = join(dir, 'settings.json');
      const original = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x0a, 0xc3, 0xa9]);
      writeFileSync(file, original);
      const fs = fsWith({
        rename: () =>
          Promise.reject(Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' })),
      });

      await expect(writeFileAtomic(file, 'completely different', { fs })).rejects.toThrow(
        /simulated EXDEV/,
      );

      expect([...readFileSync(file)]).toEqual([...original]);
      expect(names(dir)).toEqual(['settings.json']);
    });

    it('removes the temporary file and closes the handle when the write fails half way', async () => {
      const dir = tempDir();
      const file = join(dir, 'settings.json');
      writeFileSync(file, 'original');
      let closed = false;
      const fs = fsWith({
        open: async (path, flags, mode) => {
          const handle = await nodeFs.open(path, flags, mode);
          return {
            writeFile: () => Promise.reject(new Error('simulated ENOSPC')),
            chmod: (m) => handle.chmod(m),
            sync: () => handle.sync(),
            close: () => ((closed = true), handle.close()),
          };
        },
      });

      await expect(writeFileAtomic(file, 'new', { fs })).rejects.toThrow(/simulated ENOSPC/);

      expect(closed).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('original');
      expect(names(dir)).toEqual(['settings.json']);
    });

    it('leaves nothing behind when the flush fails', async () => {
      const dir = tempDir();
      const file = join(dir, 'a.json');
      const fs = fsWith({
        open: async (path, flags, mode) => {
          const handle = await nodeFs.open(path, flags, mode);
          return {
            writeFile: (data) => handle.writeFile(data),
            chmod: (m) => handle.chmod(m),
            sync: () => Promise.reject(new Error('simulated EIO')),
            close: () => handle.close(),
          };
        },
      });

      await expect(writeFileAtomic(file, 'new', { fs })).rejects.toThrow(/simulated EIO/);

      expect(existsSync(file)).toBe(false);
      expect(names(dir)).toEqual([]);
    });

    it('reports the failure that happened, not the failure to clean up after it', async () => {
      const dir = tempDir();
      const file = join(dir, 'a.json');
      writeFileSync(file, 'original');
      const fs = fsWith({
        rename: () => Promise.reject(new Error('first problem')),
        unlink: () => Promise.reject(new Error('second problem')),
      });

      await expect(writeFileAtomic(file, 'new', { fs })).rejects.toThrow(/first problem/);
    });
  });

  describe('what it refuses to replace', () => {
    it('refuses a directory', async () => {
      const dir = tempDir();
      const file = join(dir, 'settings.json');
      mkdirSync(file);

      await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'not-regular-file' });
      expect(statSync(file).isDirectory()).toBe(true);
    });

    // The owner took the write bit off. Replacing the file by rename would get past it silently.
    it.skipIf(onWindows)('refuses a file whose owner cannot write to it', async () => {
      const dir = tempDir();
      const file = join(dir, 'settings.json');
      writeFileSync(file, 'precious');
      chmodSync(file, 0o444);

      await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'read-only-target' });

      expect(readFileSync(file, 'utf8')).toBe('precious');
      expect(names(dir)).toEqual(['settings.json']);
    });
  });

  it('keeps writers apart: concurrent writes leave one whole version and no temporary files', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'start');
    const versions = Array.from({ length: 25 }, (_, i) => `version ${i}\n`.repeat(200));

    await Promise.all(versions.map((content) => writeFileAtomic(file, content)));

    expect(versions).toContain(readFileSync(file, 'utf8'));
    expect(names(dir)).toEqual(['settings.json']);
  });
});
