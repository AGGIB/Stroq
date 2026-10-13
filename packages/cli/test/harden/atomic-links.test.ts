import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TARGET_BYTES,
  assertWriteAllowed,
  nodeFs,
  readTargetText,
  removeFile,
  resolveRealPath,
  writeFileAtomic,
} from '../../src/harden/atomic.js';
import { HardenError, type Fs } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const onWindows = process.platform === 'win32';

/** The file names in a directory, so a leftover temp file shows up in an assertion. */
const names = (dir: string): string[] => readdirSync(dir).sort();

/** An Fs that behaves as the real one except where `overrides` say otherwise. */
const fsWith = (overrides: Partial<Fs>): Fs => ({ ...nodeFs, ...overrides });

/** What `fn` throws, or undefined when it does not. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe.skipIf(onWindows)('writeFileAtomic: a symlinked dotfile', () => {
  it('stays a symlink and the file it points at is the one replaced', async () => {
    const dir = tempDir();
    const real = join(dir, 'dotfiles', 'settings.json');
    const link = join(dir, 'home', '.claude', 'settings.json');
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);

    const result = await writeFileAtomic(link, 'new\n');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(readFileSync(real, 'utf8')).toBe('new\n');
    expect(result.real).toBe(real);
  });

  it('puts the temporary file beside the real file, not beside the link', async () => {
    const dir = tempDir();
    const real = join(dir, 'dotfiles', 'settings.json');
    const link = join(dir, 'home', 'settings.json');
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);
    const opened: { path: string; flags: string }[] = [];
    const fs = fsWith({
      open: (path, flags, mode) => {
        opened.push({ path, flags });
        return nodeFs.open(path, flags, mode);
      },
    });

    await writeFileAtomic(link, 'new\n', { fs });

    expect(opened).toHaveLength(1);
    expect(dirname(opened[0]?.path ?? '')).toBe(dirname(real));
    // `wx`: the temporary name is never one that already exists.
    expect(opened[0]?.flags).toBe('wx');
  });

  it('follows a link to a directory as well, as dotfile managers leave them', async () => {
    const dir = tempDir();
    const realDir = join(dir, 'dotfiles', 'claude');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'settings.json'), 'old\n');
    const home = join(dir, 'home');
    mkdirSync(home);
    symlinkSync(realDir, join(home, '.claude'));

    await writeFileAtomic(join(home, '.claude', 'settings.json'), 'new\n', { root: dir });

    expect(readFileSync(join(realDir, 'settings.json'), 'utf8')).toBe('new\n');
    expect(lstatSync(join(home, '.claude')).isSymbolicLink()).toBe(true);
  });
});

describe.skipIf(onWindows)(
  'writeFileAtomic: a path that leads out of the tree it belongs to',
  () => {
    it('is refused with a typed error when it resolves outside the root the caller names', async () => {
      const dir = tempDir();
      const project = join(dir, 'project');
      const victim = join(dir, 'elsewhere', 'victim.json');
      mkdirSync(join(project, '.claude'), { recursive: true });
      mkdirSync(dirname(victim), { recursive: true });
      writeFileSync(victim, 'victim\n');
      symlinkSync(victim, join(project, '.claude', 'settings.json'));

      const attempt = writeFileAtomic(join(project, '.claude', 'settings.json'), 'x', {
        root: project,
      });

      await expect(attempt).rejects.toBeInstanceOf(HardenError);
      await expect(attempt).rejects.toMatchObject({ code: 'path-escapes-root' });
      expect(readFileSync(victim, 'utf8')).toBe('victim\n');
      expect(names(dirname(victim))).toEqual(['victim.json']);
    });

    it('is refused when the directory the file would go in is the link', async () => {
      const dir = tempDir();
      const project = join(dir, 'project');
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(project);
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(project, '.cursor'));

      await expect(
        writeFileAtomic(join(project, '.cursor', 'hooks.json'), 'x', { root: project }),
      ).rejects.toMatchObject({ code: 'path-escapes-root' });
      expect(names(elsewhere)).toEqual([]);
    });

    it('is allowed when the root is itself reached through a link', async () => {
      const dir = tempDir();
      const real = join(dir, 'real-project');
      mkdirSync(real);
      symlinkSync(real, join(dir, 'project-link'));

      await writeFileAtomic(join(dir, 'project-link', 'a.json'), 'x', {
        root: join(dir, 'project-link'),
      });

      expect(readFileSync(join(real, 'a.json'), 'utf8')).toBe('x');
    });

    it('applies the same rule `init` applies when the caller names no root', async () => {
      const dir = tempDir();
      const project = join(dir, 'home', 'code', 'repo');
      const victim = join(dir, 'home', '.config', 'tool.json');
      mkdirSync(join(project, '.claude'), { recursive: true });
      mkdirSync(dirname(victim), { recursive: true });
      writeFileSync(victim, 'victim\n');
      symlinkSync(victim, join(project, '.claude', 'settings.json'));
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      vi.stubEnv('HOME', join(dir, 'home'));

      await expect(
        writeFileAtomic(join(project, '.claude', 'settings.json'), 'x'),
      ).rejects.toMatchObject({ code: 'path-escapes-root' });

      expect(readFileSync(victim, 'utf8')).toBe('victim\n');
    });

    it('still writes a user-scope file that links elsewhere inside the home directory', async () => {
      const dir = tempDir();
      const home = join(dir, 'home');
      const real = join(home, 'dotfiles', 'claude', 'settings.json');
      mkdirSync(dirname(real), { recursive: true });
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(real, '{}\n');
      symlinkSync(real, join(home, '.claude', 'settings.json'));
      vi.spyOn(process, 'cwd').mockReturnValue(join(home, 'somewhere-else'));
      vi.stubEnv('HOME', home);

      await writeFileAtomic(join(home, '.claude', 'settings.json'), 'new\n');

      expect(readFileSync(real, 'utf8')).toBe('new\n');
    });

    // Stroq's own files (its manifest, its copies) live in a home that may be a link on purpose.
    // `init`'s rule is about agent configs a repository can point somewhere; for these the only rule
    // is the root the caller names.
    it('can leave `init`’s rule out, and then the root the caller names is the only rule', async () => {
      const dir = tempDir();
      const home = join(dir, 'home');
      const project = join(home, 'code', 'repo');
      const target = join(home, '.config', 'tool.json');
      mkdirSync(project, { recursive: true });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'old\n');
      symlinkSync(target, join(project, 'state.json'));
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      vi.stubEnv('HOME', home);

      await expect(writeFileAtomic(join(project, 'state.json'), 'x')).rejects.toMatchObject({
        code: 'path-escapes-root',
      });
      await writeFileAtomic(join(project, 'state.json'), 'new\n', { initRule: false, root: home });
      expect(readFileSync(target, 'utf8')).toBe('new\n');
      await expect(
        writeFileAtomic(join(project, 'state.json'), 'x', { initRule: false, root: project }),
      ).rejects.toMatchObject({ code: 'path-escapes-root' });
    });
  },
);

describe('a failure that is not a path leading out of its tree', () => {
  // `init`'s rule asks the working directory, which a test run, a shell or a build can have
  // deleted. That is a failure of the machine, and it should read as one.
  it('is not reported as a path that leaves the root', async () => {
    const dir = tempDir();
    const gone = Object.assign(new Error('ENOENT: no current directory'), { code: 'ENOENT' });
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw gone;
    });

    const error = await writeFileAtomic(join(dir, 'a.json'), 'x').catch((err: unknown) => err);

    expect(error).toBe(gone);
    expect(error).not.toBeInstanceOf(HardenError);
  });
});

describe('assertWriteAllowed', () => {
  it('returns the real path of an allowed target and touches nothing', () => {
    const dir = tempDir();

    expect(assertWriteAllowed(join(dir, 'new', 'a.json'), { root: dir })).toBe(
      join(dir, 'new', 'a.json'),
    );
    expect(names(dir)).toEqual([]);
  });

  it.skipIf(onWindows)('refuses a target a link carries out of the root', () => {
    const dir = tempDir();
    const project = join(dir, 'project');
    mkdirSync(project);
    symlinkSync(dir, join(project, 'out'));

    expect(
      thrownBy(() => assertWriteAllowed(join(project, 'out', 'a.json'), { root: project })),
    ).toMatchObject({ code: 'path-escapes-root' });
  });
});

describe('removeFile', () => {
  it('removes a file and says so', async () => {
    const dir = tempDir();
    const file = join(dir, '.cursorignore');
    writeFileSync(file, 'x');

    expect(await removeFile(file)).toBe(true);

    expect(existsSync(file)).toBe(false);
  });

  it('says so when there was nothing to remove', async () => {
    const dir = tempDir();

    expect(await removeFile(join(dir, 'nope'))).toBe(false);
  });

  it('refuses a directory', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'd'));

    await expect(removeFile(join(dir, 'd'))).rejects.toMatchObject({ code: 'not-regular-file' });
  });

  it.skipIf(onWindows)('refuses to remove through a link that leaves the root', async () => {
    const dir = tempDir();
    const project = join(dir, 'project');
    const victim = join(dir, 'victim.json');
    mkdirSync(project);
    writeFileSync(victim, 'victim');
    symlinkSync(victim, join(project, 'settings.json'));

    await expect(
      removeFile(join(project, 'settings.json'), { root: project }),
    ).rejects.toMatchObject({ code: 'path-escapes-root' });

    expect(readFileSync(victim, 'utf8')).toBe('victim');
  });
});

describe('resolveRealPath', () => {
  it('is the file itself for an ordinary path, and absolute for a relative one', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a'), 'x');

    expect(resolveRealPath(join(dir, 'a'))).toBe(join(dir, 'a'));
    expect(resolveRealPath(join(dir, '.', 'sub', '..', 'a'))).toBe(join(dir, 'a'));
  });

  it('resolves through the nearest directory that exists for a file not created yet', () => {
    const dir = tempDir();

    expect(resolveRealPath(join(dir, 'new', 'deeper', 'file.json'))).toBe(
      join(dir, 'new', 'deeper', 'file.json'),
    );
  });

  it.skipIf(onWindows)('resolves links, in the file and in the directories above it', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'f'), 'x');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    symlinkSync(join(dir, 'real', 'f'), join(dir, 'filelink'));

    expect(resolveRealPath(join(dir, 'link', 'f'))).toBe(join(dir, 'real', 'f'));
    expect(resolveRealPath(join(dir, 'filelink'))).toBe(join(dir, 'real', 'f'));
    expect(resolveRealPath(join(dir, 'link', 'not-yet.json'))).toBe(
      join(dir, 'real', 'not-yet.json'),
    );
  });
});

describe('readTargetText', () => {
  it('is null for a file that is not there', () => {
    const dir = tempDir();

    expect(readTargetText(join(dir, 'nope'))).toBeNull();
    expect(readTargetText(join(dir, 'nope', 'deeper'))).toBeNull();
  });

  it('is the text of a regular file, byte for byte through UTF-8', () => {
    const dir = tempDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"é":"\u{1f600}"}\r\n');

    expect(readTargetText(file)).toBe('{"é":"\u{1f600}"}\r\n');
  });

  // Windows names the failure of opening a directory differently, so the test is POSIX-only.
  it.skipIf(onWindows)('refuses something that is not a regular file', () => {
    const dir = tempDir();

    expect(thrownBy(() => readTargetText(dir))).toMatchObject({ code: 'not-regular-file' });
  });

  it('refuses a file larger than any agent config is', () => {
    const dir = tempDir();
    const file = join(dir, 'huge.json');
    writeFileSync(file, Buffer.alloc(MAX_TARGET_BYTES + 1, 0x20));

    expect(thrownBy(() => readTargetText(file))).toMatchObject({ code: 'target-too-large' });
  });
});
