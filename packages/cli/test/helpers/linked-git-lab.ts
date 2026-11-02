import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/**
 * Real repositories, linked worktrees and submodules for the tests of `.git` files, each lab in a
 * temporary folder of its own. Every git command of a lab runs with no system or global config,
 * HOME inside the lab, no hooks and no prompt, so nothing of the machine reaches it.
 *
 * Planted configuration is written to the files with the file system, after the last git command
 * that needs the repository: git is never run in a repository whose config names a command, and
 * the command a test plants is a `touch` of `marker`, which the test then asserts was not made.
 */
export interface Lab {
  /** The real path of the lab (a temporary folder is reached through a link on macOS). */
  readonly root: string;
  /** Where the repositories are: the folder a test inspects, or the folders in it. */
  readonly work: string;
  /** A file a planted command would make; no test may find it. */
  readonly marker: string;
  git(cwd: string, ...args: string[]): string;
  remove(): void;
}

export function newLab(): Lab {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-linked-')));
  const home = join(root, 'home');
  const hooks = join(root, 'no-hooks');
  const work = join(root, 'work');
  for (const dir of [home, hooks, work]) mkdirSync(dir);
  // A git that runs the tests (a hook, a rebase) must not decide which repository these are.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          'GIT_DIR',
          'GIT_WORK_TREE',
          'GIT_INDEX_FILE',
          'GIT_COMMON_DIR',
          'GIT_OBJECT_DIRECTORY',
        ].includes(name),
    ),
  );
  const env = {
    ...inherited,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const base = [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    'protocol.file.allow=always',
    '-c',
    'commit.gpgsign=false',
  ];
  return {
    root,
    work,
    marker: join(root, 'marker'),
    git: (cwd, ...args) =>
      execFileSync('git', [...base, ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }),
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** A repository on `main` with one commit, at `dir`. */
export function newRepo(lab: Lab, dir: string): string {
  mkdirSync(dir, { recursive: true });
  lab.git(dir, 'init', '-q', '-b', 'main', '.');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  lab.git(dir, 'add', '-A');
  lab.git(dir, 'commit', '-q', '-m', 'c');
  return dir;
}

export interface Worktree {
  readonly main: string;
  readonly wt: string;
  /** `<main>/.git/worktrees/<name>`, the folder the `.git` file of `wt` names. */
  readonly admin: string;
}

/** A repository at `main` and a linked worktree of it at `wt`, made by `git worktree add`. */
export function newWorktree(lab: Lab, main: string, wt: string, ...config: string[]): Worktree {
  newRepo(lab, main);
  mkdirSync(dirname(wt), { recursive: true });
  lab.git(main, ...config, 'worktree', 'add', '-q', relative(main, wt));
  return { main, wt, admin: join(main, '.git', 'worktrees', wt.split('/').at(-1) ?? 'wt') };
}

export interface Submodule {
  readonly source: string;
  readonly superproject: string;
  /** The checkout of the submodule, with a `.git` file. */
  readonly sub: string;
  /** `<superproject>/.git/modules/lib/sub`, the folder that file names. */
  readonly module: string;
}

/** A superproject at `superproject` with the repository at `source` added as `lib/sub`. */
export function newSubmodule(lab: Lab, source: string, superproject: string): Submodule {
  newRepo(lab, source);
  newRepo(lab, superproject);
  lab.git(superproject, 'submodule', 'add', '-q', `file://${source}`, 'lib/sub');
  return {
    source,
    superproject,
    sub: join(superproject, 'lib', 'sub'),
    module: join(superproject, '.git', 'modules', 'lib', 'sub'),
  };
}

/** The command a planted key names: it makes `marker` if anything ever runs it. */
export const plantedCommand = (lab: Lab): string => `touch ${lab.marker}`;

/** Appends a config section to a git config file, with the file system and not with git. */
export function plant(file: string, text: string): void {
  appendFileSync(file, text);
}
