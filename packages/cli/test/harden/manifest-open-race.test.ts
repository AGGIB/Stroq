import type { PathLike } from 'node:fs';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManifest } from '../../src/harden/manifest.js';
import { entry, setup, signedText, thrownBy } from './manifest-fixtures.js';
import { removeTempDirs, tempDir } from './helpers.js';

const race = vi.hoisted(() => ({
  path: '',
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  afterLstat: undefined as (() => void) | undefined,
  unknownIdentity: false,
  reads: 0,
  closes: 0,
}));

// Model a platform without O_NOFOLLOW. No bytes may be read until the opened descriptor
// has been matched to a regular, non-link entry at the manifest path.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    constants: { ...fs.constants, O_NOFOLLOW: 0 },
    openSync: ((path: PathLike, ...rest: unknown[]) => {
      if (String(path) === race.path) race.beforeOpen?.();
      const fd = (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
      if (String(path) === race.path) race.afterOpen?.();
      return fd;
    }) as typeof fs.openSync,
    lstatSync: ((path: PathLike, ...rest: unknown[]) => {
      const found = (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
      if (String(path) === race.path) race.afterLstat?.();
      if (race.unknownIdentity && found !== undefined) {
        Object.defineProperty(found, 'ino', { value: 0n });
      }
      return found;
    }) as typeof fs.lstatSync,
    fstatSync: ((...args: unknown[]) => {
      const found = (fs.fstatSync as (...args: unknown[]) => object)(...args);
      if (race.unknownIdentity) Object.defineProperty(found, 'ino', { value: 0n });
      return found;
    }) as typeof fs.fstatSync,
    readSync: ((...args: unknown[]) => {
      race.reads += 1;
      return (fs.readSync as (...args: unknown[]) => number)(...args);
    }) as typeof fs.readSync,
    closeSync: (fd: number) => {
      race.closes += 1;
      fs.closeSync(fd);
    },
  };
});

afterEach(() => {
  race.beforeOpen = undefined;
  race.afterOpen = undefined;
  race.afterLstat = undefined;
  race.unknownIdentity = false;
  race.reads = 0;
  race.closes = 0;
  removeTempDirs();
});

function planted() {
  const made = setup();
  mkdirSync(join(made.manifestFile, '..'), { recursive: true });
  writeFileSync(made.manifestFile, signedText(made.home, {}));
  // Making the key opened, read and closed a file of its own: count only what the reader does.
  race.reads = 0;
  race.closes = 0;
  race.path = made.manifestFile;
  return made;
}

describe('manifest descriptor validation without O_NOFOLLOW', () => {
  it('refuses an unavailable inode instead of accepting matching unknown identities', () => {
    const { env } = planted();
    race.unknownIdentity = true;

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
    expect(race.reads).toBe(0);
    expect(race.closes).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a link swapped in as open begins, before reading its target',
    () => {
      const { env, manifestFile } = planted();
      const target = join(tempDir('elsewhere'), 'manifest.json');
      writeFileSync(target, JSON.stringify({ version: 1, files: { '/x/y.json': [entry()] } }));
      race.beforeOpen = () => {
        unlinkSync(manifestFile);
        symlinkSync(target, manifestFile);
      };

      expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
      expect(race.reads).toBe(0);
      expect(race.closes).toBe(1);
    },
  );

  it('refuses a different regular file placed at the path after open, before reading', () => {
    const { env, manifestFile } = planted();
    race.afterOpen = () => {
      unlinkSync(manifestFile);
      writeFileSync(manifestFile, JSON.stringify({ version: 1, files: {} }));
    };

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
    expect(race.reads).toBe(0);
    expect(race.closes).toBe(1);
  });

  it('refuses a path removed after open instead of accepting an unlinked manifest', () => {
    const { env, manifestFile } = planted();
    race.afterOpen = () => unlinkSync(manifestFile);

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
    expect(race.reads).toBe(0);
    expect(race.closes).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'still reads the validated descriptor if the path becomes a link afterwards',
    () => {
      const { env, manifestFile } = planted();
      const target = join(tempDir('elsewhere'), 'manifest.json');
      writeFileSync(target, JSON.stringify({ version: 1, files: { '/x/y.json': [entry()] } }));
      race.afterLstat = () => {
        unlinkSync(manifestFile);
        symlinkSync(target, manifestFile);
      };

      expect(readManifest(env)).toEqual({ version: 2, files: {} });
      // One read of the validated manifest descriptor, and one of the key that checks it.
      expect(race.reads).toBe(2);
      expect(race.closes).toBe(2);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a dangling link rather than treating it as an absent manifest',
    () => {
      const { env, manifestFile } = planted();
      unlinkSync(manifestFile);
      symlinkSync(join(tempDir('elsewhere'), 'missing.json'), manifestFile);

      expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
      expect(race.reads).toBe(0);
      expect(race.closes).toBe(0);
    },
  );
});
