import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderSurface, type RepoSurface } from '../../src/exposure/repo-surface.js';
import { newLab, newRepo, newWorktree, plant, type Lab } from '../helpers/linked-git-lab.js';

/**
 * A hook that is exactly the script Git LFS writes runs `git lfs …`, and that obeys the git-lfs keys
 * that run a program: a custom transfer agent's `path`, a standalone transfer agent, an extension's
 * `clean` and `smudge`. An archive can keep the hook byte for byte and plant such a key in the config
 * of its `.git` folder or in the `.lfsconfig` at the top of its working tree. So those keys are
 * findings of their own, wherever a config is judged, and a stock LFS hook is let through only while
 * neither the config nor `.lfsconfig` sets one.
 *
 * Real git makes the clones and real `tar` the archive; keys are planted with the file system. Every
 * planted command makes `lab.marker` if anything runs it, and no test may find that file. Skipped on
 * Windows (modes).
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

const MESSAGE = (hook: string) =>
  `This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '${hook}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').`;
const lfsHook = (hook: string): string =>
  `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "${MESSAGE(hook)}"; exit 2; }\ngit lfs ${hook} "$@"\n`;
const LFS_HOOKS = ['post-checkout', 'post-commit', 'post-merge', 'pre-push'];

/** A clone made by git with the four hooks Git LFS installs, in `lab.work/<name>`. */
function lfsClone(name: string, base = lab.work): string {
  const source = join(lab.root, 'source');
  if (!existsSync(source)) newRepo(lab, source);
  lab.git(base, 'clone', '-q', `file://${source}`, name);
  const repo = join(base, name);
  for (const hook of LFS_HOOKS) {
    const file = join(repo, '.git', 'hooks', hook);
    writeFileSync(file, lfsHook(hook));
    chmodSync(file, 0o755);
  }
  return repo;
}

const hooksOf = (repo: string): string[] =>
  LFS_HOOKS.map((hook) => `git-hook-routine ${repo}/.git/hooks/${hook} ${hook}`);

/** Each key a program can be named by, as a config section and as the key it is read as. */
const KEYS: readonly (readonly [text: string, key: string])[] = [
  ['[lfs "customtransfer.x"]', 'lfs.customtransfer.x.path'],
  ['[lfs "customTransfer.Evil"]', 'lfs.customTransfer.Evil.path'],
  ['[lfs]\n\tstandalonetransferagent = x', 'lfs.standalonetransferagent'],
  [
    '[lfs "https://example.invalid/repo"]',
    'lfs.https://example.invalid/repo.standalonetransferagent',
  ],
  ['[lfs "extension.x"]', 'lfs.extension.x.clean'],
  ['[LFS "extension.x"]', 'lfs.extension.x.smudge'],
];
/** A section with its variable, given a command. */
const keyText = (section: string, key: string): string => {
  const variable = key.split('.').at(-1) ?? '';
  return section.includes(' = ')
    ? `${section}\n`
    : `${section}\n\t${variable} = touch ${lab.marker}\n`;
};

posix('the git-lfs keys that run a program', () => {
  it('lets stock LFS hooks through when nothing sets such a key, whatever other lfs keys are set', () => {
    const repo = lfsClone('a');
    plant(
      join(repo, '.git', 'config'),
      '[lfs]\n\turl = https://example.invalid/lfs\n\tconcurrenttransfers = 4\n',
    );
    writeFileSync(
      join(repo, '.lfsconfig'),
      '[lfs]\n\turl = https://example.invalid/lfs\n[lfs "customtransfer.x"]\n\targs = --verbose\n',
    );
    expect(folderSurface(lab.work).preTrust).toEqual([]);
  });

  it.each(KEYS)(
    'reports %j in the config of the .git folder, and the stock hooks with it',
    (section, key) => {
      const repo = lfsClone('a');
      plant(join(repo, '.git', 'config'), keyText(section, key));
      expect(lines(folderSurface(lab.work)).sort()).toEqual(
        [`git-config-exec a/.git/config ${key}`, ...hooksOf('a')].sort(),
      );
    },
  );

  it.each(KEYS)(
    'reports %j in the .lfsconfig of the working tree, and the stock hooks with it',
    (section, key) => {
      const repo = lfsClone('a');
      writeFileSync(join(repo, '.lfsconfig'), keyText(section, key));
      expect(lines(folderSurface(lab.work)).sort()).toEqual(
        [`git-config-exec a/.lfsconfig ${key}`, ...hooksOf('a')].sort(),
      );
    },
  );

  it('reports it for an archive that keeps the hooks byte for byte', () => {
    const pack = join(lab.root, 'pack');
    mkdirSync(pack);
    const made = lfsClone('made');
    renameSync(made, join(pack, 'repo'));
    plant(
      join(pack, 'repo', '.git', 'config'),
      keyText('[lfs "customtransfer.x"]', 'lfs.customtransfer.x.path'),
    );
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    execFileSync('tar', ['-cf', join(lab.root, 'repo.tar'), '-C', pack, 'repo'], { env });
    execFileSync('tar', ['-xf', join(lab.root, 'repo.tar'), '-C', lab.work], { env });
    expect(lines(folderSurface(lab.work)).sort()).toEqual(
      ['git-config-exec repo/.git/config lfs.customtransfer.x.path', ...hooksOf('repo')].sort(),
    );
  });

  it('reports a .lfsconfig it cannot read or parse, and does not take the stock hooks for LFS’s then', () => {
    const repo = lfsClone('a');
    writeFileSync(join(repo, '.lfsconfig'), '[lfs\n');
    const found = lines(folderSurface(lab.work));
    expect(found).toContain(
      'git-config-exec a/.lfsconfig a line the check could not read (line 1)',
    );
    expect(found).toEqual(expect.arrayContaining(hooksOf('a')));
    writeFileSync(join(repo, '.lfsconfig'), `#${'x'.repeat(300 * 1024)}\n`);
    expect(lines(folderSurface(lab.work))).toEqual(
      expect.arrayContaining([
        'git-config-exec a/.lfsconfig a line the check could not read (the file)',
        ...hooksOf('a'),
      ]),
    );
  });

  it.each([101, 5_000])('reports a key whose subsection is %i characters long', (size) => {
    const sub = `${'a'.repeat(size - 4)}.b.c`;
    const repo = lfsClone('a');
    plant(
      join(repo, '.git', 'config'),
      `[lfs "customtransfer.${sub}"]\n\tpath = touch ${lab.marker}\n`,
    );
    writeFileSync(
      join(repo, '.lfsconfig'),
      `[lfs "https://example.invalid/${sub}"]\n\tstandalonetransferagent = x\n`,
    );
    const found = lines(folderSurface(lab.work));
    expect(found.filter((line) => line.startsWith('git-config-exec')).length).toBe(2);
    expect(found).toEqual(expect.arrayContaining(hooksOf('a')));
  });

  it('does not take the stock hooks for LFS’s while the config includes a file that is not read', () => {
    const repo = lfsClone('a');
    plant(join(repo, '.git', 'config'), '[include]\n\tpath = /somewhere/else.cfg\n');
    expect(lines(folderSurface(lab.work)).sort()).toEqual(
      ['git-config-include a/.git/config include.path', ...hooksOf('a')].sort(),
    );
  });

  it('reads the .lfsconfig at the top of each worktree of a repository it leads to', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(lab.work, 'one'));
    lab.git(main, 'worktree', 'add', '-q', join('..', 'two'));
    for (const hook of LFS_HOOKS) {
      const file = join(main, '.git', 'hooks', hook);
      writeFileSync(file, lfsHook(hook));
      chmodSync(file, 0o755);
    }
    expect(folderSurface(lab.work).preTrust).toEqual([]);
    writeFileSync(
      join(lab.work, 'two', '.lfsconfig'),
      keyText('[lfs "customtransfer.x"]', 'lfs.customtransfer.x.path'),
    );
    expect(lines(folderSurface(lab.work)).sort()).toEqual(
      ['git-config-exec two/.lfsconfig lfs.customtransfer.x.path', ...hooksOf('main')].sort(),
    );
  });

  it('judges the config of a repository a worktree leads to even where the walk does not go', () => {
    const outside = lfsClone('main', lab.root);
    plant(
      join(outside, '.git', 'config'),
      keyText('[lfs]\n\tstandalonetransferagent = x', 'lfs.standalonetransferagent'),
    );
    lab.git(
      join(lab.root, 'main'),
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-q',
      join(lab.work, 'wt'),
    );
    expect(lines(folderSurface(lab.work)).sort()).toEqual(
      [
        `git-config-exec ${outside}/.git/config lfs.standalonetransferagent`,
        ...LFS_HOOKS.map((hook) => `git-hook-routine ${outside}/.git/hooks/${hook} ${hook}`),
      ].sort(),
    );
  });
});
