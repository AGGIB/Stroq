import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRemoteReader } from '../../src/sent/git-remote.js';

/** A remote's URL, read from `.git/config` as a file: no git process is started. */

function repo(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sent-git-'));
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), config);
  return root;
}

const CONFIG = [
  '[core]',
  '\tbare = false',
  '[remote "origin"]',
  '\turl = git@github.com:acme/app.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[remote "mirror"]',
  '\turl = https://git.mirror.example/acme/app.git',
].join('\n');

describe('gitRemoteReader', () => {
  it('reads a remote by name, from the folder or a folder inside the repository', () => {
    const root = repo(CONFIG);
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    const read = gitRemoteReader();
    expect(read(root, 'origin')).toBe('git@github.com:acme/app.git');
    expect(read(join(root, 'packages', 'cli'), 'mirror')).toBe(
      'https://git.mirror.example/acme/app.git',
    );
    expect(read(root, 'nope')).toBeNull();
  });

  it('follows a worktree’s .git file to the main repository’s config', () => {
    const main = repo(CONFIG);
    const gitdir = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    const tree = mkdtempSync(join(tmpdir(), 'stroq-sent-git-wt-'));
    writeFileSync(join(tree, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitRemoteReader()(tree, 'origin')).toBe('git@github.com:acme/app.git');
  });

  it('answers null with no folder, or outside any repository', () => {
    const read = gitRemoteReader();
    expect(read(null, 'origin')).toBeNull();
    expect(read(mkdtempSync(join(tmpdir(), 'stroq-sent-nogit-')), 'origin')).toBeNull();
  });
});
