import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderSurface, repoSurface, type RepoSurface } from '../../src/exposure/repo-surface.js';
import { newLab, newRepo, type Lab } from '../helpers/linked-git-lab.js';

/**
 * A `.git` folder that looks like git's own (HEAD, objects, refs, owned by the user) is also what an
 * extracted zip or tarball produces, and its hooks run on the agent's next git command. So in a
 * folder that is not itself a repository, every executable hook of such a folder is a finding, a
 * commit hook too. Two kinds of file are not hooks of anyone's making: git's `*.sample` files, which
 * git never runs, and the four hooks Git LFS installs when a hook is exactly the script it writes.
 *
 * Real git makes the clones and real `tar` the archive. A hook is only ever text: it makes
 * `lab.marker` if anything runs it, and no test may find that file. Skipped on Windows (modes, links).
 */
const posix = describe.skipIf(process.platform === 'win32');

let lab: Lab;
beforeEach(() => {
  lab = newLab();
});
afterEach(() => {
  expect(existsSync(lab.marker)).toBe(false);
  lab.remove();
});

const lines = (surface: RepoSurface): string[] =>
  surface.preTrust.map((h) => `${h.kind} ${h.file} ${h.what.split(',')[0]}`);

const hookOf = (repo: string, name: string, text: string, mode = 0o755): string => {
  const file = join(repo, '.git', 'hooks', name);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

/** The hook Git LFS writes today, and the one it wrote before (both from git-lfs's lfs/hook.go). */
const LFS_MESSAGE = (hook: string) =>
  `This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '${hook}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').`;
const lfsNow = (hook: string): string =>
  `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "${LFS_MESSAGE(hook)}"; exit 2; }\ngit lfs ${hook} "$@"\n`;
const lfsBefore = (hook: string): string =>
  `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\n${LFS_MESSAGE(hook)}\\n"; exit 2; }\ngit lfs ${hook} "$@"\n`;
const LFS_HOOKS = ['post-checkout', 'post-commit', 'post-merge', 'pre-push'];

/** A clone made by git, in `lab.work/<name>`. */
function clone(name: string): string {
  const source = join(lab.root, 'source');
  if (!existsSync(source)) newRepo(lab, source);
  lab.git(lab.work, 'clone', '-q', `file://${source}`, name);
  return join(lab.work, name);
}

posix('the hooks of a .git folder in a folder that is not a repository', () => {
  it('reports an executable commit hook of an extracted archive, which no clone brings', () => {
    // A repository with a pre-commit hook that makes the marker, packed and unpacked by tar.
    const pack = join(lab.root, 'pack');
    mkdirSync(pack);
    const made = clone('made');
    renameSync(made, join(pack, 'repo'));
    hookOf(join(pack, 'repo'), 'pre-commit', `#!/bin/sh\ntouch ${lab.marker}\n`);
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    const archive = join(lab.root, 'repo.tar');
    execFileSync('tar', ['-cf', archive, '-C', pack, 'repo'], { env });
    execFileSync('tar', ['-xf', archive, '-C', lab.work], { env });
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-hook-routine repo/.git/hooks/pre-commit pre-commit',
    ]);
  });

  it('reports nothing for the same repository made by git clone: no hooks but the samples', () => {
    clone('made');
    expect(
      readFileSync(join(lab.work, 'made', '.git', 'hooks', 'pre-commit.sample'), 'utf8'),
    ).toMatch(/^#!/);
    expect(folderSurface(lab.work).preTrust).toEqual([]);
  });

  it('reports every executable hook, the commit hooks and the others', () => {
    const repo = clone('r');
    for (const name of ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'pre-push', 'post-merge'])
      hookOf(repo, name, `#!/bin/sh\ntouch ${lab.marker}\n`);
    expect(lines(folderSurface(lab.work)).sort()).toEqual(
      ['commit-msg', 'post-merge', 'pre-commit', 'pre-push', 'prepare-commit-msg'].map(
        (name) => `git-hook-routine r/.git/hooks/${name} ${name}`,
      ),
    );
  });

  it('does not report a hook git cannot run: not executable, or a sample', () => {
    const repo = clone('r');
    hookOf(repo, 'pre-commit', `#!/bin/sh\ntouch ${lab.marker}\n`, 0o644);
    hookOf(repo, 'pre-push.sample', `#!/bin/sh\ntouch ${lab.marker}\n`, 0o755);
    expect(folderSurface(lab.work).preTrust).toEqual([]);
  });

  it('does not report the hooks Git LFS installs, in the text it writes, either way it wrote it', () => {
    const repo = clone('lfs');
    LFS_HOOKS.forEach((name, i) =>
      hookOf(repo, name, i % 2 === 0 ? lfsNow(name) : lfsBefore(name)),
    );
    expect(folderSurface(lab.work).preTrust).toEqual([]);
    for (const name of LFS_HOOKS) hookOf(repo, name, lfsNow(name).replace(/\n/g, '\r\n'));
    expect(folderSurface(lab.work).preTrust).toEqual([]);
    for (const name of LFS_HOOKS) hookOf(repo, name, lfsNow(name).trimEnd());
    expect(folderSurface(lab.work).preTrust).toEqual([]);
  });

  it('reports a stock LFS hook that was edited, however little', () => {
    const repo = clone('lfs');
    const edits: [string, (text: string) => string][] = [
      ['a line added', (t) => `${t}touch ${lab.marker}\n`],
      ['a line added before', (t) => t.replace('#!/bin/sh\n', `#!/bin/sh\ntouch ${lab.marker}\n`)],
      ['a blank line at the end', (t) => `${t}\n`],
      ['another exit code', (t) => t.replace('exit 2', 'exit 0')],
      ['another program', (t) => t.replace('git lfs', 'git-lfs')],
      ['a blank at the end of a line', (t) => t.replace('/dev/null 2>&1', '/dev/null 2>&1 ')],
    ];
    for (const [name, edit] of edits) {
      for (const hook of LFS_HOOKS) hookOf(repo, hook, edit(lfsNow(hook)));
      expect(lines(folderSurface(lab.work)).length, name).toBe(LFS_HOOKS.length);
    }
  });

  it('reports a stock LFS script under the name of another hook, and as a link', () => {
    const repo = clone('lfs');
    hookOf(repo, 'pre-commit', lfsNow('post-checkout'));
    hookOf(repo, 'post-commit', lfsNow('pre-push'));
    const real = join(lab.root, 'real-hook');
    writeFileSync(real, lfsNow('post-merge'));
    chmodSync(real, 0o755);
    symlinkSync(real, join(repo, '.git', 'hooks', 'post-merge'));
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'git-hook-routine lfs/.git/hooks/post-commit post-commit',
      'git-hook-routine lfs/.git/hooks/post-merge post-merge',
      'git-hook-routine lfs/.git/hooks/pre-commit pre-commit',
    ]);
  });

  it('judges the hooks of a repository a worktree leads to the same way', () => {
    const repo = clone('r');
    lab.git(repo, 'worktree', 'add', '-q', join('..', 'wt'));
    hookOf(repo, 'pre-commit', `#!/bin/sh\ntouch ${lab.marker}\n`);
    hookOf(repo, 'pre-push', lfsNow('pre-push'));
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-hook-routine r/.git/hooks/pre-commit pre-commit',
    ]);
  });

  it('is unchanged at the root of a repository, where a commit hook is an ordinary one', () => {
    const repo = newRepo(lab, join(lab.work, 'repo'));
    hookOf(repo, 'pre-commit', `#!/bin/sh\ntouch ${lab.marker}\n`);
    const surface = repoSurface(repo);
    expect(surface.preTrust).toEqual([]);
    expect(surface.onOpen.map((h) => `${h.kind} ${h.file}`)).toEqual([
      'git-hook .git/hooks/pre-commit',
    ]);
  });
});
