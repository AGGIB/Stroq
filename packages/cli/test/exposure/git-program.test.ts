import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * Every git call of `stroq inspect --changed-from` starts in the folder it checks, and that
 * folder's files are the change. A program named `git` there must never be the one that runs:
 * Windows looks in the folder a program starts in before PATH, and so does POSIX for an empty or
 * relative part of PATH, and a PATH can name a folder inside the checkout (`node_modules/.bin`).
 */

const dirs: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const posixOnly = it.skipIf(process.platform === 'win32');
const realGitDir = (): string =>
  dirname(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());

/** Puts a program named git in `folder` that leaves `marker` behind when it runs. */
function plantGit(folder: string, marker: string): void {
  mkdirSync(folder, { recursive: true });
  const fake = join(folder, 'git');
  writeFileSync(fake, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`);
  chmodSync(fake, 0o755);
}

describe('the git that stroq inspect runs', () => {
  posixOnly.each([
    ['an empty part of PATH', (_dir: string, real: string) => `:${real}`],
    ['a relative part of PATH', (_dir: string, real: string) => `.:${real}`],
    [
      'a part of PATH inside the checkout',
      (dir: string, real: string) => `${join(dir, 'node_modules', '.bin')}:${real}`,
    ],
    // A folder named `..x` is inside the checkout, though its relative path starts with `..`.
    [
      'a part of PATH in a folder of the checkout named ..x',
      (dir: string, real: string) => `${join(dir, '..x')}:${real}`,
    ],
  ])('is never one in the checkout, through %s', (_name, pathOf) => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, { 'README.md': 'y\n' });
    const marker = join(dirname(dir), `${dir.split('/').pop() ?? 'x'}-ran`);
    dirs.push(marker);
    plantGit(dir, marker);
    plantGit(join(dir, 'node_modules', '.bin'), marker);
    plantGit(join(dir, '..x'), marker);
    const real = realGitDir();
    process.env.PATH = pathOf(dir, real);
    const changes = agentChanges(dir, base);
    process.env.PATH = savedPath;
    expect(existsSync(marker)).toBe(false);
    expect(changes.hits).toEqual([]);
  });
});
