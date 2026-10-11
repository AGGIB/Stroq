import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, writeFileAtomic } from '../../src/harden/atomic.js';
import type { Fs } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const MINUTE = 60_000;
/** One fixed "now", so that the age of a file is a number the test chose and not a race. */
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function plant(dir: string, name: string, ageMs: number, content = 'left by a hard stop'): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  const when = new Date(NOW - ageMs);
  utimesSync(path, when, when);
  return path;
}

const STALE = '.settings.json.stroq-4242-aabbccddeeff.tmp';

/**
 * A hard stop (a power cut, a SIGKILL) between "the new content is written" and "it replaces the
 * old file" leaves the temporary file behind: a complete copy of the content that was about to be
 * written, in the owner's own directory, where nothing would ever clean it up.
 */
describe('writeFileAtomic: temporary files that a hard stop left behind', () => {
  it('removes one of its own kind that is older than an hour, before it writes', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    plant(dir, STALE, 61 * MINUTE);

    await writeFileAtomic(file, 'new', { now: () => NOW });

    expect(readdirSync(dir).sort()).toEqual(['settings.json']);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('sweeps for a file that does not exist yet as well', async () => {
    const dir = tempDir();
    plant(dir, STALE, 3 * 60 * MINUTE);

    await writeFileAtomic(join(dir, 'settings.json'), 'new', { now: () => NOW });

    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('leaves a young one alone: another writer may be using it right now', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const young = plant(dir, '.settings.json.stroq-4243-001122334455.tmp', 59 * MINUTE);

    await writeFileAtomic(file, 'new', { now: () => NOW });

    expect(existsSync(young)).toBe(true);
  });

  // Only the exact shape the engine itself makes: this directory is the owner's, and a file that
  // is not Stroq's is not Stroq's to delete.
  it.each([
    ['a different file’s temporary file', '.other.json.stroq-4242-aabbccddeeff.tmp'],
    ['a name without the leading dot', 'settings.json.stroq-4242-aabbccddeeff.tmp'],
    ['a process id that is not a number', '.settings.json.stroq-abc-aabbccddeeff.tmp'],
    ['a random part that is too short', '.settings.json.stroq-4242-aabbcc.tmp'],
    ['a random part in capitals', '.settings.json.stroq-4242-AABBCCDDEEFF.tmp'],
    ['a random part that is not hex', '.settings.json.stroq-4242-gghhiijjkkll.tmp'],
    ['another suffix', '.settings.json.stroq-4242-aabbccddeeff.bak'],
    ['text after the suffix', '.settings.json.stroq-4242-aabbccddeeff.tmp.keep'],
    ['the owner’s own backup', 'settings.json.bak'],
  ])('leaves %s alone, however old it is', async (_name, name) => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const other = plant(dir, name, 48 * 60 * MINUTE, 'precious');

    await writeFileAtomic(file, 'new', { now: () => NOW });

    expect(readFileSync(other, 'utf8')).toBe('precious');
  });

  it('leaves a directory with such a name alone', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    mkdirSync(join(dir, STALE));
    const when = new Date(NOW - 5 * 60 * MINUTE);
    utimesSync(join(dir, STALE), when, when);

    await writeFileAtomic(file, 'new', { now: () => NOW });

    expect(existsSync(join(dir, STALE))).toBe(true);
  });

  it('does not let a file it cannot remove stop the write', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const stale = plant(dir, STALE, 2 * 60 * MINUTE);
    const fs: Fs = {
      ...nodeFs,
      unlink: (path) =>
        path === stale ? Promise.reject(new Error('simulated EPERM')) : nodeFs.unlink(path),
    };

    await writeFileAtomic(file, 'new', { fs, now: () => NOW });

    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(existsSync(stale)).toBe(true);
  });

  it('does not let a directory it cannot list stop the write', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    const fs: Fs = { ...nodeFs, readdir: () => Promise.reject(new Error('simulated EACCES')) };

    await writeFileAtomic(file, 'new', { fs, now: () => NOW });

    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('sweeps before it makes its own temporary file, so that it can never remove that one', async () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    plant(dir, STALE, 2 * 60 * MINUTE);
    const order: string[] = [];
    const fs: Fs = {
      ...nodeFs,
      unlink: (path) => (order.push('unlink'), nodeFs.unlink(path)),
      open: (path, flags, mode) => (order.push('open'), nodeFs.open(path, flags, mode)),
    };

    await writeFileAtomic(file, 'new', { fs, now: () => NOW });

    expect(order).toEqual(['unlink', 'open']);
  });
});
