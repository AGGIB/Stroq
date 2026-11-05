import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderSurface, repoSurface, type RepoSurface } from '../../src/exposure/repo-surface.js';
import { newLab, newRepo, newWorktree, plant, type Lab } from '../helpers/linked-git-lab.js';

/**
 * `core.hooksPath` in the config of a `.git` folder routes git to a folder of hooks, and in a folder
 * that is not a repository (an archive, a download, a folder of clones) that folder is the checkout's
 * or the archive's own. So the key is a finding unless it names the repository's own `.git/hooks`,
 * and the executable hooks of the folder it names are judged as those of `.git/hooks` are: all of
 * them, a commit hook too, but not the scripts Git LFS writes and not `*.sample` files. The root of a
 * repository is read as it was (husky, `.githooks`).
 *
 * Real git makes the clones and worktrees and real `tar` the archive; the key is planted with the file
 * system after the last git command. A hook is only text: it makes `lab.marker` if anything runs it, and
 * no test may find that file. Skipped on Windows (modes, links).
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
const hooksPath = (value: string) => `[core]\n\thooksPath = ${value}\n`;
const hook = (path: string, text = `#!/bin/sh\ntouch ${lab.marker}\n`, mode = 0o755): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
};
const LFS_POST_CHECKOUT = `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the 'post-checkout' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks')."; exit 2; }\ngit lfs post-checkout "$@"\n`;

/** A clone made by git, in `lab.work/<name>`. */
function clone(name: string): string {
  const source = join(lab.root, 'source');
  if (!existsSync(source)) newRepo(lab, source);
  lab.git(lab.work, 'clone', '-q', `file://${source}`, name);
  return join(lab.work, name);
}

const ROUTES = 'git-hook-routine';

posix('core.hooksPath in a .git folder in a folder that is not a repository', () => {
  it('is a finding, and so are the executable hooks of the folder it names', () => {
    const repo = clone('b');
    plant(join(repo, '.git', 'config'), hooksPath('.githooks'));
    hook(join(repo, '.githooks', 'pre-commit'));
    hook(join(repo, '.githooks', 'notes.txt'), 'text\n', 0o644);
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec b/.git/config core.hookspath`,
      `${ROUTES} b/.githooks/pre-commit pre-commit`,
    ]);
  });

  it('is reported for an archive of such a repository, which is how it arrives', () => {
    const pack = join(lab.root, 'pack');
    mkdirSync(pack);
    const made = clone('made');
    renameSync(made, join(pack, 'repo'));
    plant(join(pack, 'repo', '.git', 'config'), hooksPath('.githooks'));
    hook(join(pack, 'repo', '.githooks', 'pre-commit'));
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    execFileSync('tar', ['-cf', join(lab.root, 'repo.tar'), '-C', pack, 'repo'], { env });
    execFileSync('tar', ['-xf', join(lab.root, 'repo.tar'), '-C', lab.work], { env });
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec repo/.git/config core.hookspath`,
      `${ROUTES} repo/.githooks/pre-commit pre-commit`,
    ]);
  });

  it.each([['.git/hooks'], ['./.git/hooks/'], ['.git/../.git/hooks'], ['ABSOLUTE']])(
    'is not one when it names the own hooks folder of the repository: %s',
    (value) => {
      const repo = clone('b');
      plant(
        join(repo, '.git', 'config'),
        hooksPath(value === 'ABSOLUTE' ? join(repo, '.git', 'hooks') : value),
      );
      expect(folderSurface(lab.work).preTrust).toEqual([]);
      // The hooks of that folder are judged as ever.
      hook(join(repo, '.git', 'hooks', 'pre-commit'));
      expect(lines(folderSurface(lab.work))).toEqual([
        `${ROUTES} b/.git/hooks/pre-commit pre-commit`,
      ]);
    },
  );

  it.each([
    ['another folder of the checkout', '.husky/_', 'b/.husky/_/pre-commit pre-commit'],
    ['a folder above it', '../shared', 'shared/pre-commit pre-commit'],
    ['an absolute path', 'SHARED', 'shared/pre-commit pre-commit'],
  ])('is one when it names %s', (_name, value, expectedHook) => {
    const repo = clone('b');
    const shared = join(lab.work, 'shared');
    plant(join(repo, '.git', 'config'), hooksPath(value === 'SHARED' ? shared : value));
    hook(join(repo, '.husky', '_', 'pre-commit'));
    hook(join(shared, 'pre-commit'));
    const found = lines(folderSurface(lab.work)).sort();
    expect(found).toContain(`git-config-exec b/.git/config core.hookspath`);
    expect(found).toContain(`${ROUTES} ${expectedHook}`);
  });

  it('is one when it names a home folder or a folder that is not there, and judges nothing past it', () => {
    const repo = clone('b');
    plant(join(repo, '.git', 'config'), hooksPath('~/hooks'));
    expect(lines(folderSurface(lab.work))).toEqual([
      `git-config-exec b/.git/config core.hookspath`,
    ]);
    const other = clone('c');
    plant(join(other, '.git', 'config'), hooksPath('nowhere'));
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec b/.git/config core.hookspath`,
      `git-config-exec c/.git/config core.hookspath`,
    ]);
  });

  it('judges the hooks it names by the same rules: Git LFS’s own and samples are not findings', () => {
    const repo = clone('b');
    plant(join(repo, '.git', 'config'), hooksPath('.githooks'));
    hook(join(repo, '.githooks', 'post-checkout'), LFS_POST_CHECKOUT);
    hook(join(repo, '.githooks', 'pre-commit.sample'));
    expect(lines(folderSurface(lab.work))).toEqual([
      `git-config-exec b/.git/config core.hookspath`,
    ]);
    hook(join(repo, '.githooks', 'post-checkout'), `${LFS_POST_CHECKOUT}touch ${lab.marker}\n`);
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec b/.git/config core.hookspath`,
      `${ROUTES} b/.githooks/post-checkout post-checkout`,
    ]);
  });

  it('is read from config.worktree too, and a folder named by a link is judged', () => {
    const repo = clone('b');
    writeFileSync(join(repo, '.git', 'config.worktree'), hooksPath('linked'));
    mkdirSync(join(lab.root, 'elsewhere'));
    hook(join(lab.root, 'elsewhere', 'pre-push'));
    symlinkSync(join(lab.root, 'elsewhere'), join(repo, 'linked'));
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec b/.git/config.worktree core.hookspath`,
      `${ROUTES} b/linked/pre-push pre-push`,
    ]);
  });

  it('is judged for each worktree of a repository, since a relative path starts at its checkout', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(lab.work, 'one'));
    lab.git(main, 'worktree', 'add', '-q', join('..', 'two'));
    plant(join(main, '.git', 'config'), hooksPath('.githooks'));
    hook(join(lab.work, 'one', '.githooks', 'pre-commit'));
    hook(join(lab.work, 'two', '.githooks', 'pre-push'));
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      `git-config-exec main/.git/config core.hookspath`,
      `${ROUTES} one/.githooks/pre-commit pre-commit`,
      `${ROUTES} two/.githooks/pre-push pre-push`,
    ]);
  });

  it('stops at a count of hook files, and says so, in a folder with many', () => {
    const repo = clone('b');
    plant(join(repo, '.git', 'config'), hooksPath('.githooks'));
    for (let i = 0; i < 230; i += 1)
      hook(join(repo, '.githooks', `h${String(i).padStart(2, '0')}`));
    const found = lines(folderSurface(lab.work));
    expect(found.length).toBeLessThan(215);
    expect(found.some((line) => line.includes('more hook files'))).toBe(true);
  });

  it('is read at the root of a repository as it was: the key is a finding, the hooks are listed', () => {
    const repo = newRepo(lab, join(lab.work, 'repo'));
    plant(join(repo, '.git', 'config'), hooksPath('.githooks'));
    hook(join(repo, '.githooks', 'pre-commit'));
    const surface = repoSurface(repo);
    expect(lines(surface)).toEqual(['git-config-exec .git/config core.hookspath']);
    expect(surface.onOpen.map((h) => `${h.kind} ${h.file}`)).toEqual([
      'git-hook .githooks/pre-commit',
    ]);
  });
});
