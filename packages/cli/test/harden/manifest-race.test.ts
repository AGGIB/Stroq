import type { PathLike } from 'node:fs';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MANIFEST_BYTES, readManifest } from '../../src/harden/manifest.js';
import { entry, setup, thrownBy } from './manifest-fixtures.js';
import { removeTempDirs, tempDir } from './helpers.js';

/**
 * The race, made deterministic: right after the reader first looks at `race.path` (the check), the
 * file there is replaced by something else. That is what a process running beside Stroq could do
 * between the check and the read that trusts it. A reader that checks one handle and reads that
 * same handle never sees the swap; one that looks at a path and then reads it again by name reads
 * a file the check never looked at.
 *
 * The same shape as `check-then-read.test.ts`, which does this for the other readers.
 */
const race = vi.hoisted(() => ({ path: '', swap: undefined as (() => void) | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const lstatThenSwap = ((path: PathLike, ...rest: unknown[]) => {
    const result = (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
    const swap = race.swap;
    if (swap !== undefined && String(path) === race.path) {
      race.swap = undefined;
      swap();
    }
    return result;
  }) as typeof fs.lstatSync;
  return { ...fs, lstatSync: lstatThenSwap };
});

afterEach(() => {
  race.swap = undefined;
  removeTempDirs();
});

const onWindows = process.platform === 'win32';
const GOOD = JSON.stringify({ version: 1, files: {} });

/** A manifest in place, and a swap armed to run right after the reader looks at it. */
function armed(swap: (manifestFile: string) => void) {
  const made = setup();
  mkdirSync(join(made.manifestFile, '..'), { recursive: true });
  writeFileSync(made.manifestFile, GOOD);
  race.path = made.manifestFile;
  race.swap = () => swap(made.manifestFile);
  return made;
}

describe('a manifest replaced between the check and the read', () => {
  it('is judged by the file that was opened: a swap for one past the size bound is refused, not read', () => {
    const { env } = armed((file) => {
      unlinkSync(file);
      writeFileSync(file, ' '.repeat(MAX_MANIFEST_BYTES + 10));
    });

    const error = thrownBy(() => readManifest(env));

    expect(error).toMatchObject({ code: 'manifest-too-large' });
    // The swap ran, so the test raced the read rather than passing because it never did.
    expect(race.swap).toBeUndefined();
  });

  it.skipIf(onWindows)(
    'is never followed through a link that was put there after the check',
    () => {
      const elsewhere = join(tempDir('elsewhere'), 'other.json');
      writeFileSync(elsewhere, JSON.stringify({ version: 1, files: { '/x/y.json': [entry()] } }));
      const { env } = armed((file) => {
        unlinkSync(file);
        symlinkSync(elsewhere, file);
      });

      const error = thrownBy(() => readManifest(env));

      expect(error).toMatchObject({ code: 'manifest-unsafe' });
      expect(race.swap).toBeUndefined();
    },
  );

  it.skipIf(onWindows)('is refused when what was put there after the check is a directory', () => {
    const { env } = armed((file) => {
      unlinkSync(file);
      mkdirSync(file);
    });

    const error = thrownBy(() => readManifest(env));

    expect(error).toMatchObject({ code: 'manifest-unsafe' });
    expect(race.swap).toBeUndefined();
  });

  it('reads whole the file that is there when it is opened, never a mixture of the two', () => {
    const replacement = JSON.stringify({ version: 1, files: { '/a/b.json': [entry()] } });
    const { env } = armed((file) => {
      unlinkSync(file);
      writeFileSync(file, replacement);
    });

    const manifest = readManifest(env);

    expect(Object.keys(manifest.files)).toEqual(['/a/b.json']);
    expect(race.swap).toBeUndefined();
  });
});
