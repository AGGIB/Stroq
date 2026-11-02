import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autorunOf } from '../../src/card/autorun.js';
import { runInspect } from '../../src/commands/inspect.js';
import { folderSurface, repoSurface, type RepoSurface } from '../../src/exposure/repo-surface.js';
import { newLab, newRepo, plant, type Lab } from '../helpers/linked-git-lab.js';

/**
 * A folder that holds ordinary cloned repositories (a projects folder, the folders an agent has
 * been opened in) runs nothing because each child has a `.git` folder: git made it. What counts is
 * what git would run from it, as for a repository, so that is what is judged: the commands its
 * config names, the drivers its attributes route through them, the hooks git runs on its own.
 * What a clone or an archive plants and git would not make still counts by being there: a bare
 * repository under any other name, a `.git` that is a link or a file nobody can vouch for.
 *
 * Real git makes the clones; the planted parts are written by hand after the last git command, and
 * every planted command makes `lab.marker`, which no test may find. Skipped on Windows (links,
 * modes and a user id).
 */
const posix = describe.skipIf(process.platform === 'win32');

let lab: Lab;
beforeEach(() => {
  lab = newLab();
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(existsSync(lab.marker)).toBe(false);
  lab.remove();
});

const lines = (surface: RepoSurface): string[] =>
  surface.preTrust.map((h) => `${h.kind} ${h.file} ${h.what}`);
const planted = () => `[core]\n\tfsmonitor = touch ${lab.marker}\n`;

/** Two clean clones, `a` and `b`, of one repository, in `lab.work`. */
function twoClones(): { a: string; b: string; source: string } {
  const source = newRepo(lab, join(lab.root, 'source'));
  for (const name of ['a', 'b']) lab.git(lab.work, 'clone', '-q', `file://${source}`, name);
  return { a: join(lab.work, 'a'), b: join(lab.work, 'b'), source };
}

const plantBare = (dir: string): void => {
  for (const name of ['objects', 'refs']) mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), planted());
};

posix('a folder of ordinary clones', () => {
  it('reports nothing for two clean clones, and the card counts nothing', () => {
    twoClones();
    expect(folderSurface(lab.work).preTrust).toEqual([]);
    expect(autorunOf(lab.work)).toBeNull();
  });

  it('reports a clone whose config names a command, by its real path, once', () => {
    const { b } = twoClones();
    plant(join(b, '.git', 'config'), planted());
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-config-exec b/.git/config core.fsmonitor',
    ]);
    expect(autorunOf(lab.work)?.items).toEqual([
      { kind: 'git-config-exec', file: 'b/.git/config', name: 'core.fsmonitor' },
    ]);
  });

  it('reports a config.worktree, an include and a hook git runs on checkout', () => {
    const { a, b } = twoClones();
    writeFileSync(
      join(a, '.git', 'config.worktree'),
      `[core]\n\tsshCommand = touch ${lab.marker}\n`,
    );
    plant(join(a, '.git', 'config'), '[include]\n\tpath = /somewhere/else.cfg\n');
    const hook = join(b, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${lab.marker}\n`);
    chmodSync(hook, 0o755);
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'git-config-exec a/.git/config.worktree core.sshcommand',
      'git-config-include a/.git/config include.path',
      'git-hook-routine b/.git/hooks/post-checkout post-checkout',
    ]);
  });

  it('reports a driver the attributes route through a command its config defines', () => {
    const { a } = twoClones();
    writeFileSync(join(a, '.gitattributes'), '* filter=evil\n');
    plant(join(a, '.git', 'config'), `[filter "evil"]\n\tsmudge = touch ${lab.marker}\n`);
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'git-config-exec a/.git/config filter.evil.smudge',
      'gitattributes-driver a/.gitattributes filter.evil',
    ]);
  });

  it('judges a clone the same wherever it is in the folder', () => {
    const { a } = twoClones();
    mkdirSync(join(lab.work, 'deep', 'er'), { recursive: true });
    renameSync(a, join(lab.work, 'deep', 'er', 'a'));
    plant(join(lab.work, 'deep', 'er', 'a', '.git', 'config'), planted());
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-config-exec deep/er/a/.git/config core.fsmonitor',
    ]);
  });

  it('still reports what a clone or an archive plants and git would not make', () => {
    twoClones();
    plantBare(join(lab.work, 'x.git'));
    // A folder with a HEAD, a config and refs is taken for a repository by git, objects or not.
    mkdirSync(join(lab.work, 'dir', 'refs'), { recursive: true });
    writeFileSync(join(lab.work, 'dir', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(lab.work, 'dir', 'config'), planted());
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'git-config-exec dir/config core.fsmonitor',
      'git-config-exec x.git/config core.fsmonitor',
      'nested-bare-repo dir HEAD, objects, refs',
      'nested-bare-repo x.git HEAD, objects, refs',
    ]);
  });

  it('still reports a .git that is a link, or a file nobody vouches for', () => {
    const { a } = twoClones();
    mkdirSync(join(lab.work, 'linked'));
    symlinkSync(join(a, '.git'), join(lab.work, 'linked', '.git'));
    mkdirSync(join(lab.work, 'filed'));
    writeFileSync(join(lab.work, 'filed', '.git'), 'gitdir: ../a/.git\n');
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'nested-bare-repo filed/.git a .git file, which points git at the folder of another repository',
      'nested-bare-repo linked/.git a .git file, which points git at the folder of another repository',
    ]);
  });

  it('still reports a .git folder that is not shaped as git makes it', () => {
    twoClones();
    // No objects folder; a commondir that leads elsewhere; HEAD and refs but no objects.
    const odd = (name: string, files: Record<string, string>) => {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(lab.work, name, '.git', file)), { recursive: true });
        writeFileSync(join(lab.work, name, '.git', file), text);
      }
    };
    odd('noobjects', { HEAD: 'ref: refs/heads/main\n', config: '[core]\n', 'refs/x': '' });
    odd('common', {
      HEAD: 'ref: refs/heads/main\n',
      'objects/x': '',
      'refs/x': '',
      commondir: '../a\n',
    });
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'nested-bare-repo common/.git HEAD, objects, refs',
      'nested-bare-repo noobjects/.git HEAD, objects, refs',
    ]);
  });
});

posix('stroq inspect on a folder of clones, and on a repository with clones in it', () => {
  const run = (dir: string, flag: string): { code: number; out: string } => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const code = runInspect([dir, flag]);
    vi.restoreAllMocks();
    return { code, out: chunks.join('') };
  };

  it('passes a folder of clean clones, and fails on the one that names a command', () => {
    const { a, b } = twoClones();
    expect(run(lab.work, '--json').code).toBe(0);
    const sarifClean = JSON.parse(run(lab.work, '--sarif').out) as {
      runs: { results: unknown[] }[];
    };
    expect(sarifClean.runs[0]?.results).toEqual([]);
    plant(join(b, '.git', 'config'), planted());
    const failed = run(lab.work, '--sarif');
    expect(failed.code).toBe(1);
    const sarif = JSON.parse(failed.out) as { runs: { results: { ruleId: string }[] }[] };
    expect(sarif.runs[0]?.results.map((r) => r.ruleId)).toEqual(['stroq/git-config-exec']);
    expect(existsSync(a)).toBe(true);
  });

  // By design (see `nestedBareRepos`): git checks no `.git` out, so one below the root of a
  // repository was made on this machine and is not read there. This says what is, not what must be.
  it('does not read a clone under the root of a repository, as before', () => {
    const repo = newRepo(lab, join(lab.work, 'repo'));
    const nested = newRepo(lab, join(repo, 'vendor', 'lib'));
    plant(join(nested, '.git', 'config'), planted());
    expect(lines(repoSurface(repo))).toEqual([]);
  });
});
