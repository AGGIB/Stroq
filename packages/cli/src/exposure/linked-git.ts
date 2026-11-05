import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { MAX_CONFIG_BYTES, parseGitConfig } from './git-config.js';
import type { SurfaceReadContext } from './surface-io.js';

/**
 * The `.git` file git itself makes: a linked worktree's (`git worktree add`) or a submodule's.
 *
 * A `.git` file points git at a folder of another repository, and a repository that commits one
 * (beside a bare repository it also commits) makes git read an attacker's config. That is a
 * finding. The same file is also what git writes for every worktree and submodule on the
 * machine, and those must not be one. What tells them apart is where the file points. Git never
 * writes checkout content inside a `.git` folder: `git clone` and `git checkout` refuse any path
 * with a `.git` part, whatever its letter case (and the spellings an NTFS or HFS disk reads as
 * one). So a cloned repository cannot hold a `.git/worktrees/<name>/gitdir` backlink or a
 * `.git/modules/<name>` folder, and a `.git` file that points into a real `.git` folder, which
 * points back at it, was made by git on this machine. A bare repository committed into the
 * checkout has no `.git` in its path, however well it is laid out, and is not accepted.
 *
 * Everything below fails closed: a file that is not exactly what git writes, a link anywhere on
 * the way, a folder someone else owns, a read that fails, all mean "not git's own", and the
 * caller keeps its finding. An archive (a zip, a tarball) can hold whole `.git` folders, so a
 * caller that passes a verified file still reads the folder it names (see `repo-surface.ts`).
 */

export type LinkedGitKind = 'worktree' | 'submodule';

export interface LinkedGit {
  readonly kind: LinkedGitKind;
  /** The folder the `.git` file names: `<common>/worktrees/<name>`, or the module's folder. */
  readonly gitdir: string;
  /** The folder whose `config`, `hooks` and `info/attributes` git reads for this checkout. */
  readonly common: string;
}

/** A `.git` file is a line with a path; a path longer than this is not one. */
const POINTER_BYTES = 4096;
/** A path of more names than this is not one git wrote, and is not walked. */
const MAX_PARTS = 64;
const SEPARATORS = sep === '\\' ? /[\\/]/ : '/';
const PREFIX = 'gitdir: ';

/**
 * The path a one-line file holds: at most a final newline, no other line break, no NUL, no blanks
 * at either end (git trims them, so the path it takes would not be the one read here).
 */
export function onePath(text: string): string | undefined {
  const end = text.endsWith('\r\n') ? text.length - 2 : text.endsWith('\n') ? text.length - 1 : -1;
  const value = end === -1 ? text : text.slice(0, end);
  if (value === '' || value !== value.trim() || /[\r\n\0]/.test(value)) return undefined;
  return value;
}

/** The path in the text of a `.git` file, which is `gitdir: <path>`; undefined for any other text. */
export function pointerPath(text: string): string | undefined {
  return text.startsWith(PREFIX) ? onePath(text.slice(PREFIX.length)) : undefined;
}

/**
 * Where to start and which names to walk for `value`: from `from` if it is relative, from its
 * root if it is not. `.` and empty parts are dropped; `..` is kept, for `walk` to take a step up.
 */
export function walkPlan(
  value: string,
  from: string,
): { readonly start: string; readonly parts: readonly string[] } | undefined {
  const root = isAbsolute(value) ? parse(value).root : '';
  const parts = value
    .slice(root.length)
    .split(SEPARATORS)
    .filter((part) => part !== '' && part !== '.');
  return parts.length > MAX_PARTS ? undefined : { start: root === '' ? from : root, parts };
}

/** Thrown for anything that is not git's own: caught once, by `linkedGit`. */
class NotGits extends Error {}
const refuse = (): never => {
  throw new NotGits();
};

/**
 * The folder `value` names, taking one name at a time and refusing a link at any of them: the OS
 * would follow it, and what it leads to is not what the names say. A `..` after names that are
 * all plain folders is a step back to a folder already seen, so it is taken as one. A name that
 * is not there makes `lstat` throw, which ends the walk.
 */
function resolveIn(value: string, from: string, io: SurfaceReadContext): string {
  const plan = walkPlan(value, from) ?? refuse();
  let at = plan.start;
  for (const part of plan.parts) {
    if (part === '..') {
      at = dirname(at);
      continue;
    }
    at = join(at, part);
    if (io.lstat(at).isSymbolicLink()) refuse();
  }
  return at;
}

const ownedByMe = (stat: Stats): boolean =>
  process.getuid === undefined || stat.uid === process.getuid();

/** A real folder (not a link) that this user owns: nobody else's work, and not a planted one. */
function ownedFolder(path: string, io: SurfaceReadContext): boolean {
  const stat = io.lstat(path);
  return stat.isDirectory() && ownedByMe(stat);
}

const isFile = (path: string, io: SurfaceReadContext): boolean => io.lstat(path).isFile();
const isFolder = (path: string, io: SurfaceReadContext): boolean => io.lstat(path).isDirectory();
const absent = (path: string, io: SurfaceReadContext): boolean => {
  try {
    io.lstat(path);
    return false;
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT';
  }
};

/** A folder git takes for a repository of its own: `HEAD`, `objects/` and `refs/`, no `commondir`. */
const isGitFolder = (path: string, io: SurfaceReadContext): boolean =>
  ownedFolder(path, io) &&
  isFile(join(path, 'HEAD'), io) &&
  isFolder(join(path, 'objects'), io) &&
  isFolder(join(path, 'refs'), io) &&
  absent(join(path, 'commondir'), io);

/** One entry or another name for it (a case-insensitive disk, a hard link): the same inode. */
function same(a: string, b: string, io: SurfaceReadContext): boolean {
  if (a === b) return true;
  const x = io.lstat(a);
  const y = io.lstat(b);
  return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
}

/** The text of a small regular file (not a link) beside the `.git` file, or a refusal. */
function smallText(path: string, bytes: number, io: SurfaceReadContext): string {
  if (!isFile(path, io)) refuse();
  const read = io.read(path, bytes);
  return read.kind === 'text' ? read.text : refuse();
}

const insideDotGit = (path: string): boolean => path.split(SEPARATORS).includes('.git');

/** `<common>/worktrees/<name>`, with a `gitdir` file that points back at this `.git` file. */
function asWorktree(self: string, gitdir: string, io: SurfaceReadContext): LinkedGit | undefined {
  const admin = dirname(gitdir);
  const common = dirname(admin);
  if (basename(admin) !== 'worktrees' || !insideDotGit(common)) return undefined;
  if (!ownedFolder(gitdir, io) || !ownedFolder(admin, io) || !isGitFolder(common, io))
    return undefined;
  const back = onePath(smallText(join(gitdir, 'gitdir'), POINTER_BYTES, io));
  if (back === undefined || !same(resolveIn(back, gitdir, io), self, io)) return undefined;
  // Without a `commondir` file git takes the folder itself for the repository, and reads its config.
  const declared = onePath(smallText(join(gitdir, 'commondir'), POINTER_BYTES, io));
  if (declared === undefined || !same(resolveIn(declared, gitdir, io), common, io))
    return undefined;
  return { kind: 'worktree', gitdir, common };
}

/** The `.git` folder that holds `modules/` above a module's folder: `<R>/.git/modules/<name>`. */
function modulesHome(module: string): string | undefined {
  for (let up = dirname(module); dirname(up) !== up; up = dirname(up))
    if (basename(up) === 'modules' && basename(dirname(up)) === '.git') return dirname(up);
  return undefined;
}

const under = (path: string, base: string): boolean =>
  path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);

/**
 * `<R>/.git/modules/<name>` of a repository that holds this folder, whose own `config` says the
 * work tree is this folder: git writes `core.worktree` there for every submodule it sets up.
 */
function asSubmodule(
  folder: string,
  module: string,
  io: SurfaceReadContext,
): LinkedGit | undefined {
  const home = modulesHome(module);
  if (home === undefined || !under(folder, dirname(home))) return undefined;
  if (!ownedFolder(home, io) || !isGitFolder(module, io)) return undefined;
  const config = parseGitConfig(smallText(join(module, 'config'), MAX_CONFIG_BYTES, io));
  const worktree = config.entries.filter((e) => e.key === 'core.worktree').at(-1)?.value;
  if (config.unplaced.length > 0 || worktree === undefined) return undefined;
  if (!same(resolveIn(worktree, module, io), folder, io)) return undefined;
  return { kind: 'submodule', gitdir: module, common: module };
}

function verified(pointer: string, io: SurfaceReadContext): LinkedGit | undefined {
  if (!isFile(pointer, io)) return undefined;
  const value = pointerPath(smallText(pointer, POINTER_BYTES, io));
  if (value === undefined) return undefined;
  const folder = io.realpath(dirname(pointer));
  const gitdir = resolveIn(value, folder, io);
  return asWorktree(join(folder, '.git'), gitdir, io) ?? asSubmodule(folder, gitdir, io);
}

/**
 * Whether the `.git` file at `pointer` is the one git made for a linked worktree or a submodule
 * here, and where it leads. Undefined when it is anything else, or when that cannot be told: a
 * context that is not a plain read of the disk never follows it.
 */
export function linkedGit(pointer: string, io: SurfaceReadContext): LinkedGit | undefined {
  if (io.plainDisk !== true || basename(pointer) !== '.git') return undefined;
  try {
    return verified(pointer, io);
  } catch {
    // A link, a missing or unreadable file, a name that is not as git writes it: not git's own.
    return undefined;
  }
}

/**
 * Whether `path` is a `.git` folder as git makes it: named exactly `.git`, a real folder this user
 * owns, with `HEAD`, `objects/` and `refs/` and no `commondir`. Only for a plain read of the disk.
 * Anything else, and any read that fails, is not one.
 */
export function ordinaryGitFolder(path: string, io: SurfaceReadContext): boolean {
  if (io.plainDisk !== true || basename(path) !== '.git') return false;
  try {
    return isGitFolder(path, io);
  } catch {
    return false;
  }
}
