import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCheckError } from '../../src/live/errors.js';
import {
  THROWAWAY_MARKER,
  assertThrowaway,
  createThrowawayRoot,
  removeThrowawayRoot,
  type Throwaway,
} from '../../src/live/throwaway.js';

/**
 * The live check deletes and overwrites files in directories its caller names. A past test of this
 * project deleted its owner's configuration with a real `rm -rf ~`, so every such step first asks
 * whether the directory is one the check made for itself and marked as disposable.
 */
let made: Throwaway;
const plain: string[] = [];

/** A directory in the temporary directory that was not made by `createThrowawayRoot`. */
const plainTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-live-plain-'));
  plain.push(dir);
  return dir;
};

/** The error a refusal throws; anything else a call throws, or no error at all, fails the test. */
const refusal = (run: () => unknown): LiveCheckError => {
  try {
    run();
  } catch (err) {
    if (err instanceof LiveCheckError) return err;
    throw err;
  }
  throw new Error('expected the directory to be refused');
};

beforeEach(() => {
  made = createThrowawayRoot('stroq-live-throwaway-test-');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeThrowawayRoot(made.root);
  for (const dir of plain.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createThrowawayRoot', () => {
  it('makes a directory of its own in the temporary directory, with a marker and three subdirectories', () => {
    expect(dirname(realpathSync(made.root))).toBe(realpathSync(tmpdir()));
    expect(readdirSync(made.root).sort()).toEqual([
      THROWAWAY_MARKER,
      'home',
      'project',
      'stroq-home',
    ]);
    expect(made.project).toBe(join(made.root, 'project'));
    expect(made.home).toBe(join(made.root, 'home'));
    expect(made.stroqHome).toBe(join(made.root, 'stroq-home'));
    expect(lstatSync(join(made.root, THROWAWAY_MARKER)).isFile()).toBe(true);
    for (const dir of [made.project, made.home, made.stroqHome])
      expect(statSync(dir).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps all of it to its owner', () => {
    for (const dir of [made.root, made.project, made.home, made.stroqHome])
      expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('makes a different root each time', () => {
    const other = createThrowawayRoot('stroq-live-throwaway-test-');
    try {
      expect(other.root).not.toBe(made.root);
    } finally {
      removeThrowawayRoot(other.root);
    }
  });

  it.each([
    '',
    '../escape',
    'a/b',
    'a\\b',
    '/abs',
    '.',
    '..',
    'x'.repeat(41),
    'with space',
    'tab\t',
  ])(
    'will not use %j as a prefix, which would put the root somewhere else or hide it',
    (prefix) => {
      expect(refusal(() => createThrowawayRoot(prefix)).code).toBe('invalid-option');
    },
  );
});

describe('assertThrowaway', () => {
  // The test setup keeps the fake home and Stroq home inside the temporary directory, which would be
  // refused first, for being what they are. Out of the way, so that each rule is seen on its own.
  beforeEach(() => {
    const nowhere = join(parse(process.cwd()).root, 'stroq-live-no-such-home');
    for (const name of ['HOME', 'USERPROFILE', 'STROQ_HOME']) vi.stubEnv(name, nowhere);
  });

  it('lets through the root and each directory made in it', () => {
    for (const dir of [made.root, made.project, made.home, made.stroqHome])
      expect(() => assertThrowaway(dir)).not.toThrow();
  });

  it('lets through a directory below them that is not there yet', () => {
    expect(() => assertThrowaway(join(made.project, 'a', 'b', 'c'))).not.toThrow();
  });

  it('lets through a directory below them, however the path is spelled', () => {
    expect(() => assertThrowaway(join(made.project, 'x', '..', 'y'))).not.toThrow();
  });

  it('refuses with the typed error unsafe-directory, and says why in plain characters', () => {
    const error = refusal(() => assertThrowaway(plainTemp()));
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('unsafe-directory');
    expect(error.name).toBe('LiveCheckError');
    expect(error.message).toMatch(/^[\x20-\x7e]+$/);
  });

  it('does not repeat control characters from the path it refuses', () => {
    const error = refusal(() => assertThrowaway('/nowhere/\u001b[2Jevil\nline'));
    expect(error.message).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each([
    ['nothing', ''],
    ['a relative path', 'project'],
    ['a relative path that looks like a root', './stroq-live-x'],
    ['a path with a NUL in it', '/tmp/a\u0000b'],
  ])('refuses %s', (_name, dir) => {
    expect(refusal(() => assertThrowaway(dir)).code).toBe('unsafe-directory');
  });

  it('refuses a value that is not a string', () => {
    expect(refusal(() => assertThrowaway(undefined as unknown as string)).code).toBe(
      'unsafe-directory',
    );
  });

  it('refuses the root of the file system', () => {
    const root = parse(process.cwd()).root;
    const error = refusal(() => assertThrowaway(root));
    expect(error.code).toBe('unsafe-directory');
    expect(error.message).toMatch(/root of the file system/);
  });

  it("refuses the temporary directory itself, which holds everyone else's files", () => {
    expect(refusal(() => assertThrowaway(tmpdir())).message).toMatch(/temporary directory/);
  });

  it('refuses a directory in the temporary directory that carries no marker', () => {
    const dir = plainTemp();
    mkdirSync(join(dir, 'project'));
    expect(refusal(() => assertThrowaway(dir)).message).toMatch(/marker/);
    expect(refusal(() => assertThrowaway(join(dir, 'project'))).message).toMatch(/marker/);
  });

  it('refuses a directory outside the temporary directory', () => {
    // Below the directory the tests run from, so that it does not hold the working directory.
    const outside = join(process.cwd(), 'packages');
    expect(refusal(() => assertThrowaway(outside)).message).toMatch(/temporary directory/);
  });

  it('refuses a marker that is a directory, and a marker that is not in the root itself', () => {
    const asDirectory = plainTemp();
    mkdirSync(join(asDirectory, THROWAWAY_MARKER));
    expect(refusal(() => assertThrowaway(asDirectory)).message).toMatch(/marker/);

    const deeper = plainTemp();
    mkdirSync(join(deeper, 'sub'));
    writeFileSync(join(deeper, 'sub', THROWAWAY_MARKER), 'x');
    expect(refusal(() => assertThrowaway(join(deeper, 'sub'))).message).toMatch(/marker/);
  });

  it.skipIf(process.platform === 'win32')('refuses a marker that is a link', () => {
    const linked = plainTemp();
    writeFileSync(join(linked, 'real-marker'), 'x');
    symlinkSync(join(linked, 'real-marker'), join(linked, THROWAWAY_MARKER));
    expect(refusal(() => assertThrowaway(linked)).message).toMatch(/marker/);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a directory in the root that is a link to somewhere else',
    () => {
      // A decoy made for the purpose: a link in a tree that is removed whole is never to lead to anything
      // of anyone's, the checkout least of all.
      symlinkSync(plainTemp(), join(made.root, 'link'));
      expect(refusal(() => assertThrowaway(join(made.root, 'link'))).code).toBe('unsafe-directory');
      expect(refusal(() => assertThrowaway(join(made.root, 'link', 'below'))).code).toBe(
        'unsafe-directory',
      );
    },
  );

  it('refuses a path that climbs out of the root', () => {
    const escape = join(made.project, '..', '..', 'stroq-live-not-ours');
    expect(refusal(() => assertThrowaway(escape)).code).toBe('unsafe-directory');
  });

  describe('the places that matter more than any temporary directory', () => {
    // Each of these is a throwaway directory with a marker, so only the rule under test can refuse it.
    it('refuses the real Stroq home, and the directory that holds it', () => {
      vi.stubEnv('STROQ_HOME', made.stroqHome);
      expect(refusal(() => assertThrowaway(made.stroqHome)).message).toMatch(/Stroq home/);
      expect(refusal(() => assertThrowaway(made.root)).message).toMatch(/Stroq home/);
      // A neighbour of it is fine.
      expect(() => assertThrowaway(made.project)).not.toThrow();
    });

    it('refuses the home of the user, and the directory that holds it', () => {
      vi.stubEnv('HOME', made.home);
      vi.stubEnv('USERPROFILE', made.home);
      expect(homedir()).toBe(made.home);
      expect(refusal(() => assertThrowaway(made.home)).message).toMatch(/home directory/);
      expect(refusal(() => assertThrowaway(made.root)).message).toMatch(/home directory/);
      expect(() => assertThrowaway(made.project)).not.toThrow();
    });

    it('refuses the working directory, and the directory that holds it', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(made.project);
      expect(refusal(() => assertThrowaway(made.project)).message).toMatch(/working directory/);
      expect(refusal(() => assertThrowaway(made.root)).message).toMatch(/working directory/);
      expect(() => assertThrowaway(made.home)).not.toThrow();
    });

    it('goes on without the working directory when there is none to ask about', () => {
      vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' });
      });
      expect(() => assertThrowaway(made.project)).not.toThrow();
    });

    it.skipIf(process.platform === 'win32')(
      'compares what the file system says and not what was typed: a link to the home is the home',
      () => {
        vi.stubEnv('HOME', made.home);
        vi.stubEnv('USERPROFILE', made.home);
        symlinkSync(made.home, join(made.root, 'alias'));
        expect(refusal(() => assertThrowaway(join(made.root, 'alias'))).message).toMatch(
          /home directory/,
        );
      },
    );
  });
});

describe('removeThrowawayRoot', () => {
  it('removes the root and everything in it', () => {
    const other = createThrowawayRoot('stroq-live-throwaway-test-');
    writeFileSync(join(other.project, 'a.txt'), 'x');
    removeThrowawayRoot(other.root);
    expect(existsSync(other.root)).toBe(false);
  });

  it('is content with a root that is already gone', () => {
    const other = createThrowawayRoot('stroq-live-throwaway-test-');
    rmSync(other.root, { recursive: true });
    expect(() => removeThrowawayRoot(other.root)).not.toThrow();
  });

  it('refuses a directory that is not marked, and leaves it as it was', () => {
    const dir = plainTemp();
    writeFileSync(join(dir, 'precious.txt'), 'x');
    expect(refusal(() => removeThrowawayRoot(dir)).code).toBe('unsafe-directory');
    expect(existsSync(join(dir, 'precious.txt'))).toBe(true);
  });

  it('refuses a directory inside a root: only a whole root goes', () => {
    expect(refusal(() => removeThrowawayRoot(made.project)).message).toMatch(/whole root/);
    expect(existsSync(made.project)).toBe(true);
  });

  it('refuses a root that holds the working directory', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(made.project);
    expect(refusal(() => removeThrowawayRoot(made.root)).code).toBe('unsafe-directory');
    expect(existsSync(made.root)).toBe(true);
  });
});
