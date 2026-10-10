import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegularFile } from '@stroq/core';
import { readSmallRegularFile, writePrivateFileAtomic } from '../../src/live/private-file.js';
import { inChild } from './child.js';

// The real reader, counted: what these tests are about is which reader is asked.
vi.mock('@stroq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stroq/core')>();
  return { ...actual, readRegularFile: vi.fn(actual.readRegularFile) };
});

/**
 * The two things the stored result and the ledger both do with a file: read it when it may have been
 * put there by someone else, and write it so that it is whole or not there. Neither is allowed to
 * wait on a FIFO, follow a link, read a device or leave half a file.
 */
let dir: string;
const SOURCE = fileURLToPath(new URL('../../src/live/private-file.ts', import.meta.url));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-live-private-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the one reader', () => {
  // `readRegularFile` of @stroq/core is where a path somebody else chose is opened without waiting,
  // looked at through the handle that is read, and sized from it. A second copy of that here would be
  // a second chance to get it wrong, so this module asks core and keeps only what core does not do.
  it('reads through the reader of @stroq/core', () => {
    writeFileSync(join(dir, 'a'), 'hello');
    vi.mocked(readRegularFile).mockClear();
    expect(readSmallRegularFile(join(dir, 'a'), 100)).toEqual({ kind: 'text', text: 'hello' });
    expect(readRegularFile).toHaveBeenCalledTimes(1);
    expect(readRegularFile).toHaveBeenCalledWith(join(dir, 'a'), 100);
  });

  it('opens and reads nothing itself', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source).not.toMatch(/\b(openSync|fstatSync|readSync|createReadStream|readFileSync)\b/);
  });

  it('does not ask core about a path that is not there', () => {
    vi.mocked(readRegularFile).mockClear();
    expect(readSmallRegularFile(join(dir, 'missing'), 100)).toEqual({ kind: 'absent' });
    expect(readRegularFile).not.toHaveBeenCalled();
  });
});

describe('readSmallRegularFile', () => {
  it('reads a regular file', () => {
    writeFileSync(join(dir, 'a'), 'hello');
    expect(readSmallRegularFile(join(dir, 'a'), 100)).toEqual({ kind: 'text', text: 'hello' });
  });

  it('reads an empty file as empty text, which is not the same as no file', () => {
    writeFileSync(join(dir, 'a'), '');
    expect(readSmallRegularFile(join(dir, 'a'), 100)).toEqual({ kind: 'text', text: '' });
  });

  it('says a file that is not there is absent, whether the path ends there or runs through a file', () => {
    expect(readSmallRegularFile(join(dir, 'missing'), 100)).toEqual({ kind: 'absent' });
    writeFileSync(join(dir, 'a'), 'x');
    expect(readSmallRegularFile(join(dir, 'a', 'below'), 100)).toEqual({ kind: 'absent' });
  });

  it('takes exactly the size it is given and refuses one byte more', () => {
    writeFileSync(join(dir, 'a'), '12345');
    expect(readSmallRegularFile(join(dir, 'a'), 5)).toEqual({ kind: 'text', text: '12345' });
    expect(readSmallRegularFile(join(dir, 'a'), 4)).toEqual({ kind: 'refused', why: 'too large' });
  });

  it('refuses a directory', () => {
    mkdirSync(join(dir, 'd'));
    expect(readSmallRegularFile(join(dir, 'd'), 100)).toEqual({
      kind: 'refused',
      why: 'not a regular file',
    });
  });

  it('reads bytes that are not text without throwing', () => {
    writeFileSync(join(dir, 'a'), Buffer.from([0xff, 0xfe, 0x41]));
    expect(readSmallRegularFile(join(dir, 'a'), 100).kind).toBe('text');
  });

  it.skipIf(process.platform === 'win32')('refuses a link, even to a file that would do', () => {
    writeFileSync(join(dir, 'real'), 'hello');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(readSmallRegularFile(join(dir, 'link'), 100)).toEqual({
      kind: 'refused',
      why: 'not a regular file',
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a device a link leads to', () => {
    symlinkSync('/dev/zero', join(dir, 'link'));
    expect(readSmallRegularFile(join(dir, 'link'), 100).kind).toBe('refused');
  });

  // Opening a FIFO for reading waits for a writer. In a child, a read that waits is a failure with a
  // time limit and not a hang.
  it.skipIf(process.platform === 'win32')('does not wait for a FIFO', () => {
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    expect(inChild(SOURCE, 'readSmallRegularFile', [join(dir, 'fifo'), 100])).toEqual({
      kind: 'refused',
      why: 'not a regular file',
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says a file it may not read is unreadable',
    () => {
      writeFileSync(join(dir, 'a'), 'x');
      chmodSync(join(dir, 'a'), 0o000);
      try {
        expect(readSmallRegularFile(join(dir, 'a'), 100)).toEqual({
          kind: 'refused',
          why: 'unreadable',
        });
      } finally {
        chmodSync(join(dir, 'a'), 0o600);
      }
    },
  );
});

describe('writePrivateFileAtomic', () => {
  it('writes the file and makes the directories it needs', () => {
    const file = join(dir, 'a', 'b', 'c.json');
    writePrivateFileAtomic(file, '{"x":1}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"x":1}\n');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the directories to their owner and the file to its owner',
    () => {
      const file = join(dir, 'a', 'b', 'c.json');
      writePrivateFileAtomic(file, 'x');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
    },
  );

  it('replaces a file whole', () => {
    const file = join(dir, 'a.json');
    writePrivateFileAtomic(file, 'first, and longer than the second');
    writePrivateFileAtomic(file, 'second');
    expect(readFileSync(file, 'utf8')).toBe('second');
  });

  it('leaves nothing but the file behind', () => {
    writePrivateFileAtomic(join(dir, 'a.json'), 'x');
    writePrivateFileAtomic(join(dir, 'a.json'), 'y');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('throws, and leaves no temporary file, when the place of the file is a directory', () => {
    mkdirSync(join(dir, 'a.json'));
    expect(() => writePrivateFileAtomic(join(dir, 'a.json'), 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['a.json']);
    expect(existsSync(join(dir, 'a.json', 'x'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the previous file when the new one cannot be made',
    () => {
      const file = join(dir, 'a.json');
      writePrivateFileAtomic(file, 'previous');
      chmodSync(dir, 0o500);
      try {
        expect(() => writePrivateFileAtomic(file, 'next')).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readFileSync(file, 'utf8')).toBe('previous');
    },
  );
});
