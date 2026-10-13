import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import {
  emptyManifest,
  readManifest,
  withManifestLock,
  writeManifest,
  type Manifest,
} from '../../src/harden/manifest.js';
import type { Fs } from '../../src/harden/types.js';
import { entry, plant, setup } from './manifest-fixtures.js';
import { fakeEnv, removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

describe('readManifest', () => {
  it('is an empty manifest when there is none yet', () => {
    const { env } = setup();

    expect(readManifest(env)).toEqual(emptyManifest());
    expect(emptyManifest()).toEqual({ version: 1, files: {} });
  });

  it('reads what writeManifest wrote', async () => {
    const { env, file } = setup();
    const manifest: Manifest = {
      version: 1,
      files: { [file]: [entry(), entry({ created: true })] },
    };

    await writeManifest(env, manifest);

    expect(readManifest(env)).toEqual(manifest);
  });

  it('reads an entry for a file Stroq made, which has no copy and no sha before', () => {
    const { env, file, manifestFile } = setup();
    const made = entry({ created: true, shaBefore: null, backup: null });
    plant(manifestFile, { version: 1, files: { [file]: [made] } });

    expect(readManifest(env).files[file]).toEqual([made]);
  });

  it('reads a manifest without createdDirs', () => {
    const { env, file, manifestFile } = setup();
    const older = entry({ created: true });
    plant(manifestFile, { version: 1, files: { [file]: [older] } });

    const manifest = readManifest(env);
    expect(manifest.files[file]?.[0]?.createdDirs).toBeUndefined();
  });

  it('refuses a manifest where createdDirs is present but created is false', () => {
    const { env, file, manifestFile } = setup();
    const bad = entry({
      real: file,
      root: join(file, '../..'),
      created: false,
      createdDirs: [join(file, '..')],
    });
    plant(manifestFile, { version: 1, files: { [file]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });

  it('refuses a manifest where createdDirs contains a path that is not above the file', () => {
    const { env, file, manifestFile } = setup();
    const bad = entry({
      real: file,
      root: join(file, '../..'),
      created: true,
      createdDirs: ['/completely/unrelated/path'],
    });
    plant(manifestFile, { version: 1, files: { [file]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });

  it('refuses a manifest where createdDirs contains a path outside the recorded root', () => {
    const { env, file, manifestFile } = setup();
    const projectDir = join(file, '..');
    const bad = entry({
      real: file,
      root: projectDir,
      created: true,
      createdDirs: [join(projectDir, '..')],
    });
    plant(manifestFile, { version: 1, files: { [file]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });

  it('refuses a manifest where createdDirs contains the recorded root itself', () => {
    const { env, file, manifestFile } = setup();
    const projectDir = join(file, '..');
    const bad = entry({
      real: file,
      root: projectDir,
      created: true,
      createdDirs: [projectDir],
    });
    plant(manifestFile, { version: 1, files: { [file]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });

  it('refuses a manifest where createdDirs is non-empty but root is null', () => {
    const { env, file, manifestFile } = setup();
    const bad = entry({
      real: file,
      root: null,
      created: true,
      createdDirs: [join(file, '..')],
    });
    plant(manifestFile, { version: 1, files: { [file]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });

  it('refuses a manifest where createdDirs exceeds the cap of 32 folders', () => {
    const { env, home, manifestFile } = setup();
    const parts = Array.from({ length: 35 }, (_, i) => `dir${i}`);
    const deepFile = join(home, ...parts, 'settings.json');
    const dirs: string[] = [];
    let cur = dirname(deepFile);
    while (cur !== home) {
      dirs.push(cur);
      cur = dirname(cur);
    }
    const bad = entry({
      real: deepFile,
      root: home,
      created: true,
      createdDirs: dirs.slice(0, 33),
    });
    plant(manifestFile, { version: 1, files: { [deepFile]: [bad] } });

    expect(() => readManifest(env)).toThrow(expect.objectContaining({ code: 'manifest-invalid' }));
  });
});

describe('writeManifest', () => {
  it('writes readable JSON with the files in order and a newline at the end', async () => {
    const { env, manifestFile } = setup();
    const second = join(tempDir('b'), 'b.json');
    const first = join(tempDir('a'), 'a.json');

    await writeManifest(env, { version: 1, files: { [second]: [entry()], [first]: [entry()] } });

    const text = readFileSync(manifestFile, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "version": 1,');
    expect(Object.keys((JSON.parse(text) as Manifest).files)).toEqual([first, second].sort());
  });

  it.skipIf(onWindows)('keeps it private: the directory 0700, the file 0600', async () => {
    const { env, home, manifestFile } = setup();

    const previous = process.umask(0);
    try {
      await writeManifest(env, emptyManifest());
    } finally {
      process.umask(previous);
    }

    expect(statSync(join(home, 'harden')).mode & 0o777).toBe(0o700);
    expect(statSync(manifestFile).mode & 0o777).toBe(0o600);
  });

  it('replaces a manifest that is there', async () => {
    const { env, file } = setup();
    await writeManifest(env, emptyManifest());

    await writeManifest(env, { version: 1, files: { [file]: [entry()] } });

    expect(Object.keys(readManifest(env).files)).toEqual([file]);
  });

  it('leaves the manifest it had, byte for byte, and no temporary file, when the write fails', async () => {
    const { env, home, file, manifestFile } = setup();
    await writeManifest(env, { version: 1, files: { [file]: [entry()] } });
    const before = readFileSync(manifestFile);
    const fs: Fs = { ...nodeFs, rename: () => Promise.reject(new Error('simulated EXDEV')) };

    await expect(writeManifest({ ...env, fs }, emptyManifest())).rejects.toThrow(/EXDEV/);

    expect([...readFileSync(manifestFile)]).toEqual([...before]);
    expect(readdirSync(join(home, 'harden')).sort()).toEqual(['manifest.json']);
  });

  // Whatever is handed to it, the manifest on disk stays one that can be read back.
  it.each([
    ['a sha that is not a sha', entry({ shaAfter: 'nope' })],
    ['a copy id that climbs out', entry({ backup: '../../etc/passwd' })],
    [
      'an edit with no path',
      entry({
        edits: [
          { kind: 'json-set', path: [], value: 1, previous: { present: false }, createdFrom: 0 },
        ],
      }),
    ],
  ])('will not write %s, and keeps the manifest it had', async (_name, bad) => {
    const { env, file, manifestFile } = setup();
    await writeManifest(env, { version: 1, files: { [file]: [entry()] } });
    const before = readFileSync(manifestFile, 'utf8');

    await expect(
      writeManifest(env, { version: 1, files: { [file]: [bad] } }),
    ).rejects.toMatchObject({ code: 'manifest-invalid' });

    expect(readFileSync(manifestFile, 'utf8')).toBe(before);
  });

  it('will not write what it would refuse to read', async () => {
    const { env, manifestFile } = setup();
    const many = Array.from({ length: 4_000 }, () => entry());

    await expect(
      writeManifest(env, { version: 1, files: { [join(tempDir('big'), 'a.json')]: many } }),
    ).rejects.toMatchObject({ code: 'manifest-too-large' });

    expect(existsSync(manifestFile)).toBe(false);
  });

  describe.skipIf(onWindows)('where a link is in the way', () => {
    it('does not write through a link planted where the manifest goes', async () => {
      const { env, manifestFile } = setup();
      const victim = join(tempDir('victim'), 'precious.txt');
      writeFileSync(victim, 'PRECIOUS\n');
      mkdirSync(join(manifestFile, '..'), { recursive: true });
      symlinkSync(victim, manifestFile);

      await expect(writeManifest(env, emptyManifest())).rejects.toMatchObject({
        code: 'manifest-unsafe',
      });

      expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS\n');
    });

    it('does not write through a harden directory that is a link out of the home', async () => {
      const { env, home } = setup();
      const outside = tempDir('outside');
      symlinkSync(outside, join(home, 'harden'));

      await expect(writeManifest(env, emptyManifest())).rejects.toMatchObject({
        code: 'path-escapes-root',
      });

      expect(readdirSync(outside)).toEqual([]);
    });

    it('works in a home that is itself a link, as a dotfile manager leaves it', async () => {
      const target = tempDir('target');
      const link = join(tempDir('links'), 'stroq-home');
      symlinkSync(target, link);
      const env = fakeEnv(link);

      await writeManifest(env, emptyManifest());

      expect(readManifest(env)).toEqual(emptyManifest());
      expect(existsSync(join(target, 'harden', 'manifest.json'))).toBe(true);
    });
  });
});

describe('withManifestLock', () => {
  it('lets one writer at a time through, so that no update is lost', async () => {
    const { env } = setup();
    const keys = Array.from({ length: 20 }, (_, i) => join(tempDir('k'), `f${i}.json`));

    await Promise.all(
      keys.map((key) =>
        withManifestLock(env, async () => {
          const manifest = readManifest(env);
          // A pause between the read and the write: without the lock, writers overlap here.
          await new Promise((resolve) => setTimeout(resolve, 5));
          await writeManifest(env, { ...manifest, files: { ...manifest.files, [key]: [entry()] } });
        }),
      ),
    );

    expect(Object.keys(readManifest(env).files).sort()).toEqual([...keys].sort());
  });

  it('hands back what the function returned, and lets go of the lock', async () => {
    const { env, home } = setup();

    const value = await withManifestLock(env, () => Promise.resolve(42));

    expect(value).toBe(42);
    expect(readdirSync(join(home, 'harden'))).toEqual([]);
  });

  it('lets go of the lock when the function fails, and says what failed', async () => {
    const { env, home } = setup();

    await expect(withManifestLock(env, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      /boom/,
    );

    expect(readdirSync(join(home, 'harden'))).toEqual([]);
    await expect(withManifestLock(env, () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it.skipIf(onWindows)('makes the directory it needs private', async () => {
    const { env, home } = setup();

    const previous = process.umask(0);
    try {
      await withManifestLock(env, () => Promise.resolve());
    } finally {
      process.umask(previous);
    }

    expect(statSync(join(home, 'harden')).mode & 0o777).toBe(0o700);
  });
});
