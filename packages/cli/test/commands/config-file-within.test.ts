import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWriteAllowed, resolveRealPath } from '../../src/harden/atomic.js';
import { assertStaysInside, realTarget, within } from '../../src/commands/config-file.js';

/**
 * `stroq init` and the harden engine both decide whether a write stays inside its tree, and they
 * have to give one answer: the engine uses the very functions `init` does.
 */
describe('within', () => {
  it('is true for the root itself and for anything under it', () => {
    expect(within('/r', '/r')).toBe(true);
    expect(within('/r/a', '/r')).toBe(true);
    expect(within('/r/a/b/c.json', '/r')).toBe(true);
  });

  it('is false for a parent, a sibling and a path that goes up and out', () => {
    expect(within('/', '/r')).toBe(false);
    expect(within('/s/a', '/r')).toBe(false);
    expect(within('/r/../s', '/r')).toBe(false);
    expect(within('/r/..', '/r')).toBe(false);
  });

  // `..x` is a directory name. Read as the start of `..`, it made a file in such a directory look
  // like it was outside the tree, and the rule that is meant to follow links out of a tree was
  // skipped for it.
  it('counts a directory whose name only starts with two dots as inside', () => {
    expect(within('/r/..x/a.json', '/r')).toBe(true);
    expect(within('/r/...', '/r')).toBe(true);
    expect(within('/r/..hidden/deep/a', '/r')).toBe(true);
  });
});

describe('realTarget', () => {
  it('is the same function the harden engine resolves paths with', () => {
    expect(resolveRealPath).toBe(realTarget);
  });
});

describe.skipIf(process.platform === 'win32')('assertStaysInside: a directory named ..x', () => {
  let dir = '';
  let home = '';
  let project = '';

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-within-')));
    home = join(dir, 'home');
    project = join(home, 'code', 'repo');
    mkdirSync(project, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function linkOutOfProject(): string {
    const victim = join(home, '.config', 'tool.json');
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(victim, '{"keep":"me"}\n');
    mkdirSync(join(project, '..x'), { recursive: true });
    const link = join(project, '..x', 'settings.json');
    symlinkSync(victim, link);
    return link;
  }

  it('still refuses a link that leaves the project, for `init`', () => {
    expect(() => assertStaysInside(linkOutOfProject())).toThrow(/outside/);
  });

  it('still refuses a link that leaves the project, for the engine', () => {
    expect(() => assertWriteAllowed(linkOutOfProject())).toThrow(/outside/);
  });
});
