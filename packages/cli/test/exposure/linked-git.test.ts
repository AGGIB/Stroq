import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  folderSurface,
  repoFindings,
  repoSurface,
  type RepoSurface,
} from '../../src/exposure/repo-surface.js';
import { linkedGit, onePath, pointerPath, walkPlan } from '../../src/exposure/linked-git.js';
import { LEGACY_SURFACE_IO } from '../../src/exposure/surface-io.js';
import {
  newLab,
  newSubmodule,
  newWorktree,
  plant,
  plantedCommand,
  type Lab,
} from '../helpers/linked-git-lab.js';

/**
 * A `.git` file is what a cloned repository can use to point git at a bare repository it also
 * commits, and it is what git writes for every linked worktree and submodule on the machine. These
 * tests make real ones with real git, and the planted attacks by hand, and say which is which.
 *
 * Git is never run in a repository whose config names a command (see the helper), and every
 * command a test plants makes `lab.marker`, which no test may find.
 *
 * Skipped on Windows: the layouts need links and a user id, and git there writes paths in a
 * spelling these fixtures do not build.
 */
const posix = describe.skipIf(process.platform === 'win32');

/** Whether the disk of the temporary folder opens `A` as `a`. */
function foldsCase(): boolean {
  const probe = newLab();
  try {
    writeFileSync(join(probe.root, 'a'), '');
    return existsSync(join(probe.root, 'A'));
  } finally {
    probe.remove();
  }
}

let lab: Lab;
beforeEach(() => {
  lab = newLab();
});
afterEach(() => {
  // Whatever a test planted or made unreadable, the folder goes.
  lab.remove();
});

const lines = (surface: RepoSurface): string[] =>
  surface.preTrust.map((h) => `${h.kind} ${h.file} ${h.what}`);
const POINTS = 'a .git file, which points git at the folder of another repository';
const UNREAD = 'git-config-exec .git/config a line the check could not read (the file)';
/** A key whose value git would run as a command during an index refresh; it makes the marker. */
const planted = () => `[core]\n\tfsmonitor = touch ${lab.marker}\n`;

posix('a linked worktree made by git', () => {
  it('is not reported in the folder that holds it, beside the repository or under .claude/worktrees', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(lab.work, 'wt'));
    lab.git(main, 'worktree', 'add', '-q', '.claude/worktrees/x');
    // The `.git` folder of an ordinary repository was reported here for being there; it is judged
    // by what it runs now (see ordinary-clones.test.ts), and this one runs nothing.
    expect(lines(folderSurface(lab.work))).toEqual([]);
  });

  it('is not reported in the folder Claude Code keeps its worktrees in', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(main, '.claude', 'worktrees', 'x'));
    newWorktree(lab, join(lab.work, 'other'), join(main, '.claude', 'worktrees', 'y'));
    expect(folderSurface(join(main, '.claude', 'worktrees')).preTrust).toEqual([]);
  });

  it('is read at its root: no unreadable config, and nothing runs', () => {
    const { wt } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    const surface = repoSurface(wt);
    expect(surface.isRepo).toBe(true);
    expect(surface.preTrust).toEqual([]);
  });

  it('is judged by the config of its repository: a command there is reported with the real path', () => {
    const { main, wt } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    plant(join(main, '.git', 'config'), planted());
    const surface = repoSurface(wt);
    expect(surface.preTrust).toEqual([
      { kind: 'git-config-exec', file: join(main, '.git', 'config'), what: 'core.fsmonitor' },
    ]);
    expect(repoFindings(surface)[0]?.detail).toContain(join(main, '.git', 'config'));
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('is judged by that config in a folder too: under .claude/worktrees, and beside the repository', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(main, '.claude', 'worktrees', 'x'));
    plant(join(main, '.git', 'config'), planted());
    // The repository is outside the folder: its config is read here, once, by its real path.
    expect(lines(folderSurface(join(main, '.claude', 'worktrees')))).toEqual([
      `git-config-exec ${join(main, '.git', 'config')} core.fsmonitor`,
    ]);
    // Inside the folder, the walk of the `.git` folder reports it, and the file adds nothing.
    newWorktree(lab, join(lab.work, 'again'), join(lab.work, 'wt'));
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-config-exec main/.git/config core.fsmonitor',
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('is judged once for a repository with many worktrees', () => {
    const main = join(lab.work, 'main');
    for (const name of ['x', 'y', 'z']) {
      if (name === 'x') newWorktree(lab, main, join(main, '.claude', 'worktrees', name));
      else lab.git(main, 'worktree', 'add', '-q', join('.claude', 'worktrees', name));
    }
    plant(join(main, '.git', 'config'), planted());
    expect(lines(folderSurface(join(main, '.claude', 'worktrees')))).toEqual([
      `git-config-exec ${join(main, '.git', 'config')} core.fsmonitor`,
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  // Git takes `extensions.worktreeConfig` as a boolean, and a boolean may be any integer (`2`, `1k`,
  // `-1`) as well as yes, on and true. Whether git reads config.worktree is not worked out here: it
  // is read whenever it is there, whatever the flag says, so no spelling of the flag hides it.
  it.each([
    ['no flag at all', ''],
    ['true', 'true'],
    ['yes', 'yes'],
    ['1', '1'],
    ['2', '2'],
    ['1k', '1k'],
    ['-1', '-1'],
    [' true', ' true'],
    ['"true"', '"true"'],
    ['false', 'false'],
  ])('reads config.worktree whatever extensions.worktreeConfig says: %s', (_name, flag) => {
    const { main, wt, admin } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    writeFileSync(join(admin, 'config.worktree'), `[core]\n\tsshCommand = touch ${lab.marker}\n`);
    if (flag !== '')
      plant(join(main, '.git', 'config'), `[extensions]\n\tworktreeConfig = ${flag}\n`);
    expect(repoSurface(wt).preTrust).toEqual([
      { kind: 'git-config-exec', file: join(admin, 'config.worktree'), what: 'core.sshcommand' },
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('reads nothing of a config.worktree that is not there', () => {
    const { wt } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    expect(repoSurface(wt).preTrust).toEqual([]);
  });

  it('is judged by the hooks of its repository too, by their real paths', () => {
    const { main, wt } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    const hook = join(main, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${lab.marker}\n`);
    chmodSync(hook, 0o755);
    expect(lines(repoSurface(wt))).toEqual([`git-hook-routine ${hook} post-checkout`]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('is read the same with the relative paths git writes under worktree.useRelativePaths', () => {
    const { wt, admin } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    writeFileSync(join(wt, '.git'), `gitdir: ${relative(wt, admin)}\n`);
    writeFileSync(join(admin, 'gitdir'), `${relative(admin, join(wt, '.git'))}\n`);
    expect(linkedGit(join(wt, '.git'), LEGACY_SURFACE_IO)?.kind).toBe('worktree');
    expect(folderSurface(lab.work).preTrust).toEqual([]);
    expect(repoSurface(wt).preTrust).toEqual([]);
  });

  // A disk that ignores letter case opens the folder under any spelling of its name; the backlink
  // holds the one git wrote, and the two are the same file.
  it.skipIf(!foldsCase())('is told apart under another spelling of its name', () => {
    newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    expect(repoSurface(join(lab.work, 'WT')).preTrust).toEqual([]);
  });

  it('is told apart by what the file leads to, and only for a plain read of the disk', () => {
    const { main, wt, admin } = newWorktree(lab, join(lab.work, 'main'), join(lab.work, 'wt'));
    expect(linkedGit(join(wt, '.git'), LEGACY_SURFACE_IO)).toEqual({
      kind: 'worktree',
      gitdir: admin,
      common: join(main, '.git'),
    });
    expect(linkedGit(join(wt, '.git'), { ...LEGACY_SURFACE_IO, plainDisk: false })).toBeUndefined();
    // A `.git` folder is not a `.git` file, and a file of another name is not one.
    expect(linkedGit(join(main, '.git'), LEGACY_SURFACE_IO)).toBeUndefined();
    writeFileSync(join(wt, 'dotgit'), readFileSync(join(wt, '.git')));
    expect(linkedGit(join(wt, 'dotgit'), LEGACY_SURFACE_IO)).toBeUndefined();
  });
});

posix('a repository a worktree leads to, and what the walk judged of it', () => {
  it('has the hooks of its .git folder judged when that folder lies in the folder', () => {
    const main = join(lab.work, 'main');
    newWorktree(lab, main, join(lab.work, 'wt'));
    const hook = join(main, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${lab.marker}\n`);
    chmodSync(hook, 0o755);
    expect(lines(folderSurface(lab.work))).toEqual([
      'git-hook-routine main/.git/hooks/post-checkout post-checkout',
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('is judged directly when it lies where the walk does not go', () => {
    // `x` has the shape of a bare repository, so the walk reports it and goes no further: the
    // repository inside it is not read by the walk, though it lies in the folder.
    const x = join(lab.work, 'x');
    for (const name of ['objects', 'refs']) mkdirSync(join(x, name), { recursive: true });
    writeFileSync(join(x, 'HEAD'), 'ref: refs/heads/main\n');
    const { main } = newWorktree(lab, join(x, 'main'), join(lab.work, 'wt'));
    plant(join(main, '.git', 'config'), planted());
    expect(lines(folderSurface(lab.work)).sort()).toEqual([
      'git-config-exec x/main/.git/config core.fsmonitor',
      'nested-bare-repo x HEAD, objects, refs',
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('has the config.worktree of each worktree judged, though the repository was judged once', () => {
    const main = join(lab.work, 'main');
    const first = newWorktree(lab, main, join(lab.work, 'one'));
    lab.git(main, 'worktree', 'add', '-q', join('..', 'three'));
    for (const admin of [first.admin, join(main, '.git', 'worktrees', 'three')])
      writeFileSync(join(admin, 'config.worktree'), `[core]\n\tsshCommand = touch ${lab.marker}\n`);
    expect(
      lines(folderSurface(lab.work))
        .filter((l) => l.startsWith('git-config-exec'))
        .sort(),
    ).toEqual([
      'git-config-exec main/.git/worktrees/one/config.worktree core.sshcommand',
      'git-config-exec main/.git/worktrees/three/config.worktree core.sshcommand',
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });
});

posix('a repository’s own config.worktree', () => {
  it('is read at the root of a repository, as it is for a worktree', () => {
    const repo = join(lab.work, 'plain');
    newWorktree(lab, repo, join(lab.work, 'wt'));
    writeFileSync(
      join(repo, '.git', 'config.worktree'),
      `[core]\n\tsshCommand = touch ${lab.marker}\n`,
    );
    expect(lines(repoSurface(repo))).toEqual([
      'git-config-exec .git/config.worktree core.sshcommand',
    ]);
  });
});

posix('a submodule made by git', () => {
  const make = () => newSubmodule(lab, join(lab.root, 'source'), join(lab.work, 'super'));

  it('is not reported in the folder that holds it', () => {
    make();
    expect(lines(folderSurface(lab.work))).toEqual([]);
  });

  it('is read at its root, and a hostile key in the config of its module is reported', () => {
    const { sub, module } = make();
    expect(linkedGit(join(sub, '.git'), LEGACY_SURFACE_IO)).toEqual({
      kind: 'submodule',
      gitdir: module,
      common: module,
    });
    expect(repoSurface(sub).preTrust).toEqual([]);
    plant(join(module, 'config'), planted());
    expect(repoSurface(sub).preTrust).toEqual([
      { kind: 'git-config-exec', file: join(module, 'config'), what: 'core.fsmonitor' },
    ]);
    // In a folder that holds the submodule but not the repository, the module is read there too.
    expect(lines(folderSurface(join(sub, '..')))).toEqual([
      `git-config-exec ${join(module, 'config')} core.fsmonitor`,
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('is told apart in a real clone, where git sets the work tree of every module', () => {
    const { superproject } = make();
    lab.git(superproject, 'add', '-A');
    lab.git(superproject, 'commit', '-q', '-m', 'sub');
    const clone = join(lab.root, 'clone');
    lab.git(lab.root, 'clone', '-q', '--recurse-submodules', `file://${superproject}`, clone);
    expect(linkedGit(join(clone, 'lib', 'sub', '.git'), LEGACY_SURFACE_IO)?.kind).toBe('submodule');
    expect(repoSurface(join(clone, 'lib', 'sub')).preTrust).toEqual([]);
  });
});

/**
 * What must stay a finding. Each case starts from a worktree git made, with its repository outside
 * the folder, and breaks one thing; the file is then reported where it lies, and a root that has
 * it reads as before (an unreadable config, which is the check failing closed).
 */
posix('a .git file that is not git’s own', () => {
  const folderOf = () => join(lab.work, 'folder');
  const make = () => newWorktree(lab, join(lab.work, 'main'), join(folderOf(), 'wt'));
  const stays = (wt: string) => {
    expect(lines(folderSurface(folderOf()))).toEqual([`nested-bare-repo wt/.git ${POINTS}`]);
    expect(lines(repoSurface(wt))).toEqual([UNREAD]);
    expect(existsSync(lab.marker)).toBe(false);
  };
  const point = (wt: string, text: string) => writeFileSync(join(wt, '.git'), text);

  const BREAKS: readonly (readonly [string, (w: ReturnType<typeof make>) => void])[] = [
    ['a backlink that is missing', (w) => rmSync(join(w.admin, 'gitdir'))],
    [
      'a backlink that names another file',
      (w) => {
        mkdirSync(join(lab.work, 'else'));
        writeFileSync(join(lab.work, 'else', '.git'), 'gitdir: x\n');
        writeFileSync(join(w.admin, 'gitdir'), `${join(lab.work, 'else', '.git')}\n`);
      },
    ],
    [
      'a backlink that is a link to the right text',
      (w) => {
        const real = join(lab.root, 'real-gitdir');
        writeFileSync(real, readFileSync(join(w.admin, 'gitdir')));
        rmSync(join(w.admin, 'gitdir'));
        symlinkSync(real, join(w.admin, 'gitdir'));
      },
    ],
    ['a commondir that is missing', (w) => rmSync(join(w.admin, 'commondir'))],
    [
      'a commondir that names another folder',
      (w) => writeFileSync(join(w.admin, 'commondir'), '../../..\n'),
    ],
    [
      'a worktrees folder that is a link',
      (w) => {
        const git = join(w.main, '.git');
        renameSync(join(git, 'worktrees'), join(git, 'real-worktrees'));
        symlinkSync('real-worktrees', join(git, 'worktrees'));
      },
    ],
    [
      'a worktree folder that is a link',
      (w) => {
        renameSync(w.admin, `${w.admin}-real`);
        symlinkSync(`${w.admin}-real`, w.admin);
      },
    ],
    [
      'a .git folder that is a link',
      (w) => {
        renameSync(join(w.main, '.git'), join(w.main, 'dotgit'));
        symlinkSync('dotgit', join(w.main, '.git'));
      },
    ],
    ['a repository with no HEAD', (w) => rmSync(join(w.main, '.git', 'HEAD'))],
    [
      'a repository with no objects',
      (w) => rmSync(join(w.main, '.git', 'objects'), { recursive: true }),
    ],
    ['a repository with no refs', (w) => rmSync(join(w.main, '.git', 'refs'), { recursive: true })],
    [
      'a repository that is itself a worktree of another (it has a commondir)',
      (w) => writeFileSync(join(w.main, '.git', 'commondir'), '../other\n'),
    ],
    [
      'a folder for worktrees that is not named worktrees, though everything else is right',
      (w) => {
        const git = join(w.main, '.git');
        renameSync(join(git, 'worktrees'), join(git, 'trees'));
        point(w.wt, `gitdir: ${join(git, 'trees', 'wt')}\n`);
      },
    ],
    [
      'a path with a link in it',
      (w) => {
        symlinkSync(lab.work, join(lab.root, 'alias'));
        point(w.wt, `gitdir: ${join(lab.root, 'alias', 'main', '.git', 'worktrees', 'wt')}\n`);
      },
    ],
    ['a path with a second line', (w) => point(w.wt, `gitdir: ${w.admin}\nmore\n`)],
    ['a path with a NUL', (w) => point(w.wt, `gitdir: ${w.admin}\0\n`)],
    ['a path with blanks after it', (w) => point(w.wt, `gitdir: ${w.admin} \n`)],
    ['a file with no gitdir: before the path', (w) => point(w.wt, `${w.admin}\n`)],
    [
      'a path of more names than git writes, though it leads there',
      (w) => point(w.wt, `gitdir: ${'../'.repeat(100)}${w.admin.slice(1)}\n`),
    ],
    ['a file larger than a path', (w) => point(w.wt, `gitdir: ${'a'.repeat(5000)}\n`)],
    [
      'a .git file that is a link to the right text',
      (w) => {
        renameSync(join(w.wt, '.git'), join(w.wt, 'dotgit'));
        symlinkSync('dotgit', join(w.wt, '.git'));
      },
    ],
    [
      'a .git file that points at the folder of another worktree',
      (w) => {
        newWorktree(lab, join(lab.work, 'again'), join(lab.work, 'folder', 'other'));
        point(w.wt, `gitdir: ${join(lab.work, 'again', '.git', 'worktrees', 'other')}\n`);
      },
    ],
  ];

  it.each(BREAKS)('keeps the finding for %s', (_name, breakIt) => {
    const w = make();
    breakIt(w);
    stays(w.wt);
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps the finding for a .git file that cannot be read',
    () => {
      const w = make();
      chmodSync(join(w.wt, '.git'), 0o000);
      stays(w.wt);
    },
  );

  it('keeps the finding for the committed attack: a .git file, and the bare repository it also commits', () => {
    const files = {
      'evil/HEAD': 'ref: refs/heads/main\n',
      'evil/objects/x': '',
      'evil/refs/x': '',
      'evil/config': planted(),
      'evil/worktrees/y/commondir': '../..\n',
    };
    const atk = join(lab.work, 'atk');
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(atk, name)), { recursive: true });
      writeFileSync(join(atk, name), text);
    }
    mkdirSync(join(atk, 'wt'));
    writeFileSync(join(atk, 'wt', '.git'), 'gitdir: ../evil/worktrees/y\n');
    // Both spellings of a backlink that leads back to the file.
    for (const back of ['../../../wt/.git\n', `${join(atk, 'wt', '.git')}\n`]) {
      writeFileSync(join(atk, 'evil/worktrees/y/gitdir'), back);
      expect(lines(folderSurface(atk))).toEqual([
        'nested-bare-repo evil HEAD, objects, refs',
        'git-config-exec evil/config core.fsmonitor',
        `nested-bare-repo wt/.git ${POINTS}`,
      ]);
      expect(lines(repoSurface(join(atk, 'wt')))).toEqual([UNREAD]);
    }
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('keeps the finding for a .. that climbs out to a folder with a worktree layout and no backlink', () => {
    const outside = join(lab.work, 'outside', '.git', 'worktrees', 'y');
    for (const name of ['objects', 'refs'])
      mkdirSync(join(outside, '..', '..', name), { recursive: true });
    writeFileSync(join(outside, '..', '..', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'commondir'), '../..\n');
    const wt = join(lab.work, 'inner', 'deeper', 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: ../../../outside/.git/worktrees/y\n');
    expect(lines(folderSurface(join(lab.work, 'inner')))).toEqual([
      `nested-bare-repo deeper/wt/.git ${POINTS}`,
    ]);
    expect(lines(repoSurface(wt))).toEqual([UNREAD]);
  });

  it('keeps the finding for a bare repository named like a worktree, under a real-looking .git', () => {
    const fake = join(lab.work, 'x', '.git', 'worktrees', 'wt');
    for (const name of ['objects', 'refs']) mkdirSync(join(fake, name), { recursive: true });
    writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(fake, 'config'), planted());
    mkdirSync(join(lab.work, 'folder', 'wt'), { recursive: true });
    writeFileSync(join(lab.work, 'folder', 'wt', '.git'), `gitdir: ${fake}\n`);
    expect(lines(folderSurface(folderOf()))).toEqual([`nested-bare-repo wt/.git ${POINTS}`]);
    expect(existsSync(lab.marker)).toBe(false);
  });

  it('does not take the .git folder of an archive for git’s own: what the file leads to is read', () => {
    // An archive can hold whole `.git` folders, here under `node_modules`, where the walk does not
    // look. The file is shaped as git writes it; the config it leads to is read, and reported.
    const atk = join(lab.work, 'atk');
    const git = join(atk, 'node_modules', 'm', '.git');
    const admin = join(git, 'worktrees', 'wt');
    for (const dir of [join(git, 'objects'), join(git, 'refs'), admin, join(atk, 'wt')])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(git, 'config'), planted());
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'gitdir'), `${join(atk, 'wt', '.git')}\n`);
    writeFileSync(join(atk, 'wt', '.git'), `gitdir: ${admin}\n`);
    expect(linkedGit(join(atk, 'wt', '.git'), LEGACY_SURFACE_IO)?.kind).toBe('worktree');
    expect(lines(folderSurface(atk))).toEqual([
      'git-config-exec node_modules/m/.git/config core.fsmonitor',
    ]);
    expect(lines(repoSurface(join(atk, 'wt')))).toEqual([
      `git-config-exec ${join(git, 'config')} core.fsmonitor`,
    ]);
    expect(existsSync(lab.marker)).toBe(false);
  });
});

posix('a submodule’s .git file that is not git’s own', () => {
  const make = () => newSubmodule(lab, join(lab.root, 'source'), join(lab.work, 'super'));
  const config = (m: ReturnType<typeof make>) => join(m.module, 'config');
  const edit = (file: string, change: (text: string) => string) =>
    writeFileSync(file, change(readFileSync(file, 'utf8')));

  const BREAKS: readonly (readonly [string, (m: ReturnType<typeof make>) => void])[] = [
    [
      'a module with no core.worktree',
      (m) => edit(config(m), (t) => t.replace(/\tworktree = .*\n/, '')),
    ],
    [
      'a module whose core.worktree names another folder',
      (m) => edit(config(m), (t) => t.replace(/worktree = .*\n/, 'worktree = ../../../../lib\n')),
    ],
    [
      'a modules folder that is a link',
      (m) => {
        const git = join(m.superproject, '.git');
        renameSync(join(git, 'modules'), join(git, 'real-modules'));
        symlinkSync('real-modules', join(git, 'modules'));
      },
    ],
    ['a module with a config that git would refuse', (m) => plant(config(m), '[core\n')],
    ['a module with no HEAD', (m) => rmSync(join(m.module, 'HEAD'))],
  ];

  it.each(BREAKS)('keeps the finding for %s', (_name, breakIt) => {
    const m = make();
    breakIt(m);
    expect(lines(folderSurface(dirname(m.sub)))).toEqual([`nested-bare-repo sub/.git ${POINTS}`]);
    expect(lines(repoSurface(m.sub))).toEqual([UNREAD]);
  });

  it('keeps the finding for a module that is not under a .git folder’s modules', () => {
    // The shape of a submodule, committed: no `.git` folder holds it, so git did not make it.
    const atk = join(lab.work, 'atk');
    const module = join(atk, 'gitstuff', 'modules', 'sub');
    for (const dir of [join(module, 'objects'), join(module, 'refs'), join(atk, 'sub')])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(module, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(module, 'config'), `[core]\n\tworktree = ../../../sub\n${planted()}`);
    const sub = join(atk, 'sub');
    writeFileSync(join(sub, '.git'), 'gitdir: ../gitstuff/modules/sub\n');
    // Beside the file, the folder it names is reported on its own, as the bare repository it is.
    expect(lines(folderSurface(atk))).toContain(`nested-bare-repo sub/.git ${POINTS}`);
    expect(lines(repoSurface(sub))).toEqual([UNREAD]);
    // The same, under a folder that is only called something like `.git`.
    renameSync(join(atk, 'gitstuff'), join(atk, 'dotgit'));
    writeFileSync(join(sub, '.git'), 'gitdir: ../dotgit/modules/sub\n');
    expect(lines(folderSurface(atk))).toContain(`nested-bare-repo sub/.git ${POINTS}`);
    expect(lines(repoSurface(sub))).toEqual([UNREAD]);
    expect(existsSync(lab.marker)).toBe(false);
  });
});

describe('the text of a .git file', () => {
  it('is gitdir: and a path, with at most a final line break', () => {
    expect(pointerPath('gitdir: /a/b\n')).toBe('/a/b');
    expect(pointerPath('gitdir: /a/b\r\n')).toBe('/a/b');
    expect(pointerPath('gitdir: /a b/c')).toBe('/a b/c');
    for (const text of [
      '',
      'gitdir:',
      'gitdir: ',
      'gitdir:/a',
      'GITDIR: /a',
      '﻿gitdir: /a',
      'gitdir: /a\n\n',
      'gitdir: /a\nb',
      'gitdir: /a\r',
      'gitdir: /a\0',
      'gitdir:  /a',
      'gitdir: /a ',
    ])
      expect(pointerPath(text), JSON.stringify(text)).toBeUndefined();
  });

  it('is a path of one line, for the files that hold nothing else', () => {
    expect(onePath('../..\n')).toBe('../..');
    expect(onePath('')).toBeUndefined();
    expect(onePath('\n')).toBeUndefined();
    expect(onePath('a\nb\n')).toBeUndefined();
  });

  it('is walked from the folder it is in, or from its root, with . dropped and .. kept', () => {
    expect(walkPlan('../a/./b//c', '/x/y')).toEqual({
      start: '/x/y',
      parts: ['..', 'a', 'b', 'c'],
    });
    expect(walkPlan('/a/b', '/x/y')).toEqual({ start: '/', parts: ['a', 'b'] });
    expect(walkPlan('a/'.repeat(64), '/x')?.parts).toHaveLength(64);
    expect(walkPlan('a/'.repeat(65), '/x')).toBeUndefined();
  });
});
