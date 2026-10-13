// A folder on this machine, read into the in-memory tree of Safe Install (`stroq vet --from <dir>`).
//
// The folder is somebody else's, so it is read as a hostile input and nothing in it is trusted to be
// what it says it is:
//
//  - The path it is given is resolved once, and from then on every name is looked at with `lstat` and
//    never followed. A link becomes a `symlink` entry with the text it points at; the thing it points
//    at is not opened, so a link to `~/.ssh/id_rsa` puts a path in the tree and not a key.
//  - A regular file is opened once, with `O_NOFOLLOW` where the platform has it and `O_NONBLOCK` so that
//    a FIFO swapped in at the last moment does not wait for a writer, and read through that one
//    descriptor into a buffer the size of what `fstat` said. The size and the hash are those of the
//    bytes that were read. A file that is not the size it said it was, or that is not a file by the
//    time it is open, is an error and not a guess.
//  - A pipe, a socket or a device is never opened. It is counted, and the count is a blind spot.
//  - `.git` (a folder, or the file that a submodule has) and `node_modules` are not entered: a clone
//    carries a `.git` that the path rules refuse, and a `node_modules` is somebody else's code that is
//    fetched, not shipped. Both are blind spots.
//  - The walk cannot loop: it never follows a link, and it stops at the depth a path may have.
//
// A limit that is passed is an error and never a partial tree: a source that needs more than the
// limits allow is not a skill or a server, or is an attack on the person who looks. A name that the
// tree refuses is an error too, and its text is written out, clipped and quoted (`quotePath`) in the
// message, never repeated as it is.
//
// Reading is one entry at a time, in the order of the names, so that what fails first does not depend
// on the order the disk lists them. The digest does not depend on that order either: the tree sorts.
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { nameKey } from './path-collision.js';
import { checkEntryPath, quotePath } from './safe-path.js';
import { buildTree, fileDigestOf, TreeError, type TreeErrorCode } from './tree.js';
import { LIMITS, type Tree, type TreeEntry } from './types.js';

// ---------------------------------------------------------------------------------------------
// What is said
// ---------------------------------------------------------------------------------------------

/** The fixed phrases of the blind spots this reader adds, for the tests and for a caller that matches on them. */
export const READ_DIR_BLIND_SPOTS = Object.freeze({
  gitLeftOut: 'a .git entry was left out',
  noExecutableBit: 'executable bit not available on this platform',
});

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const nodeModulesSpot = (count: number): string =>
  `${plural(count, 'node_modules entry was', 'node_modules entries were')} left out, and what is in ${count === 1 ? 'it' : 'them'} was not looked at`;

const specialSpot = (count: number): string =>
  `${plural(count, 'special file (a pipe, a socket or a device) was', 'special files (pipes, sockets or devices) were')} not opened`;

export type ReadDirErrorCode =
  /** The path names nothing. */
  | 'not-found'
  /** The path names something that is not a folder. */
  | 'not-a-directory'
  /** A folder or a file that the operating system will not let this process read. */
  | 'unreadable'
  /** A name that was listed is gone by the time it is looked at. */
  | 'vanished'
  /** A name is not what it was a moment ago: a link where a file was, a file that grew or shrank. */
  | 'changed'
  /** Over a limit of `LIMITS`. */
  | 'limit'
  /** The tree refuses what was read: a name that is not safe, two names that are one name on some disks. */
  | 'refused';

/**
 * Why a folder could not be read. `message` is a fixed phrase with the name of the thing quoted and
 * written out, so it is safe to print. `treeCode` is the code of the `TreeError` behind a refusal or a
 * limit, when there is one.
 */
export class ReadDirError extends Error {
  readonly code: ReadDirErrorCode;
  readonly treeCode: TreeErrorCode | null;

  constructor(code: ReadDirErrorCode, message: string, treeCode: TreeErrorCode | null = null) {
    super(message);
    this.name = 'ReadDirError';
    this.code = code;
    this.treeCode = treeCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

/** The limits a read is held to. A caller may ask for less than `LIMITS`, never more. */
export interface ReadDirLimits {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxExpanded?: number;
}

export interface ReadDirOptions {
  readonly limits?: ReadDirLimits;
  /** The platform to read as; `win32` has no executable bit. Only the tests need to say. */
  readonly platform?: NodeJS.Platform;
  /** Installing must not silently omit a repository nested inside the source. */
  readonly rejectNestedRepositories?: boolean;
}

export interface DirRead {
  readonly tree: Tree;
  /** What was not looked at, sorted and without repeats. */
  readonly blindSpots: readonly string[];
}

interface Held {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxExpanded: number;
  /** Names seen in all, folders and skipped ones too: a folder of a million empty folders is not a tree either. */
  readonly maxVisited: number;
}

/** The smaller of what was asked for and what the contract allows. */
const held = (limits: ReadDirLimits = {}): Held => {
  const least = (asked: number | undefined, allowed: number): number =>
    asked === undefined || !(asked >= 0) ? allowed : Math.min(asked, allowed);
  const maxEntries = least(limits.maxEntries, LIMITS.maxEntries);
  return {
    maxEntries,
    maxDepth: least(limits.maxDepth, LIMITS.maxDepth),
    maxFileBytes: least(limits.maxFileBytes, LIMITS.maxFileBytes),
    maxExpanded: least(limits.maxExpanded, LIMITS.maxExpanded),
    maxVisited: 2 * maxEntries,
  };
};

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/** What a walk collects as it goes; local to one read. */
interface Walk {
  readonly limits: Held;
  readonly canExec: boolean;
  readonly rejectNestedRepositories: boolean;
  readonly entries: TreeEntry[];
  visited: number;
  expanded: number;
  gitLeftOut: boolean;
  nodeModules: number;
  special: number;
}

/**
 * `O_NOFOLLOW` fails the open on a link, and `O_NONBLOCK` makes the open of a FIFO return at once, to
 * be refused below as not a regular file. On a regular file neither changes anything. Windows has
 * neither constant, and 0 leaves the open as it was (the check of the identity does the work there).
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const OWNER_EXECUTE = 0o100;

const where = (rel: string): string => (rel === '' ? 'the folder' : quotePath(rel));
export const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  // Only a code written like an errno is repeated: the rest of an error may hold a path.
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,15}$/.test(code) ? code : 'ERR';
};

/** The refusal for a failed call of the file system on `rel`. */
function failure(error: unknown, rel: string, what: string): ReadDirError {
  if (error instanceof ReadDirError) return error;
  const errno = errnoOf(error);
  if (errno === 'ENOENT' || errno === 'ENOTDIR') {
    return new ReadDirError('vanished', `${what} ${where(rel)} is gone, or is no longer one`);
  }
  if (errno === 'ELOOP') {
    return new ReadDirError('changed', `${what} ${where(rel)} became a link while it was read`);
  }
  return new ReadDirError('unreadable', `${what} ${where(rel)} could not be read (${errno})`);
}

const overLimit = (message: string): ReadDirError => new ReadDirError('limit', message, 'limit');

/** The names in a folder, sorted, stopping at the number of names a tree could have. */
async function namesIn(abs: string, rel: string, walk: Walk): Promise<string[]> {
  const names: string[] = [];
  try {
    const dir = await opendir(abs);
    try {
      for await (const dirent of dir) {
        walk.visited += 1;
        if (walk.visited > walk.limits.maxVisited) {
          throw overLimit(`there are more than ${walk.limits.maxVisited} names to look at`);
        }
        names.push(dirent.name);
      }
    } finally {
      // The loop closes the folder when it ends; an early exit leaves it to us, and a second close complains.
      await dir.close().catch(() => undefined);
    }
  } catch (error) {
    throw failure(error, rel, 'folder');
  }
  return names.sort();
}

/** `.git` as a disk that ignores case and Unicode form would open it: the folding of the path rules. */
const isGitName = (name: string): boolean => nameKey(name) === '.git';
const isNodeModules = (name: string): boolean => name.toLowerCase() === 'node_modules';

/** Throws when one more entry would be over the limit; asked before a file is read, so the limit stops the reading. */
function ensureRoom(walk: Walk): void {
  if (walk.entries.length >= walk.limits.maxEntries) {
    throw overLimit(`the tree has more than ${walk.limits.maxEntries} entries`);
  }
}

function addEntry(walk: Walk, entry: TreeEntry): void {
  ensureRoom(walk);
  walk.entries.push(entry);
}

/** The error for a path the tree would refuse, found before a byte of it is read. */
function checkName(rel: string): void {
  const checked = checkEntryPath(rel);
  if (!checked.ok) {
    throw new ReadDirError(
      'refused',
      `entry ${quotePath(rel)}: path refused: ${checked.reason}`,
      'bad-path',
    );
  }
}

/** Whether a name on the disk is the same one that was looked at. Both ino and dev are 0 where unknown. */
const sameFile = (before: BigIntStats, after: BigIntStats): boolean =>
  before.ino === 0n || after.ino === 0n || (before.ino === after.ino && before.dev === after.dev);

/** One regular file, read once through one descriptor. */
async function readFileEntry(
  abs: string,
  rel: string,
  seen: BigIntStats,
  walk: Walk,
): Promise<TreeEntry> {
  let handle: FileHandle;
  try {
    handle = await open(abs, OPEN_FLAGS);
  } catch (error) {
    throw failure(error, rel, 'file');
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(seen, opened)) {
      throw new ReadDirError('changed', `file ${where(rel)} is no longer the file that was listed`);
    }
    if (opened.size > BigInt(walk.limits.maxFileBytes)) {
      throw overLimit(
        `file ${where(rel)} is over the ${walk.limits.maxFileBytes} bytes a file may be`,
      );
    }
    const size = Number(opened.size);
    if (walk.expanded + size > walk.limits.maxExpanded) {
      throw overLimit(`the tree is over ${walk.limits.maxExpanded} bytes in all`);
    }
    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    // One byte past the end: a file that has grown is not the file that was measured.
    const extra = filled === size ? await handle.read(new Uint8Array(1), 0, 1, size) : null;
    if (filled !== size || (extra?.bytesRead ?? 0) > 0) {
      throw new ReadDirError('changed', `file ${where(rel)} changed size while it was read`);
    }
    walk.expanded += size;
    const exec = walk.canExec && (Number(opened.mode) & OWNER_EXECUTE) !== 0;
    return { path: rel, kind: 'file', exec, size, sha256: fileDigestOf(bytes), bytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function symlinkEntry(abs: string, rel: string): Promise<TreeEntry> {
  let target: string;
  try {
    target = await readlink(abs);
  } catch (error) {
    throw failure(error, rel, 'link');
  }
  const text = Buffer.from(target, 'utf8');
  return {
    path: rel,
    kind: 'symlink',
    exec: false,
    size: text.byteLength,
    sha256: fileDigestOf(text),
    target,
  };
}

/** Looks at one name, and records what it is, enters it or leaves it out. */
async function visitName(abs: string, rel: string, depth: number, walk: Walk): Promise<void> {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  if (isGitName(name)) {
    if (walk.rejectNestedRepositories && rel.includes('/'))
      throw new ReadDirError('refused', 'a source with nested repositories cannot be installed');
    walk.gitLeftOut = true;
    return;
  }
  if (isNodeModules(name)) {
    walk.nodeModules += 1;
    return;
  }
  let seen: BigIntStats;
  try {
    seen = await lstat(abs, { bigint: true });
  } catch (error) {
    throw failure(error, rel, 'entry');
  }
  if (seen.isSymbolicLink()) {
    checkName(rel);
    addEntry(walk, await symlinkEntry(abs, rel));
  } else if (seen.isDirectory()) {
    await walkFolder(abs, rel, depth + 1, walk);
  } else if (seen.isFile()) {
    checkName(rel);
    ensureRoom(walk);
    addEntry(walk, await readFileEntry(abs, rel, seen, walk));
  } else {
    walk.special += 1;
  }
}

/** The folder `rel`, which has `depth` components; its names are in the order of their text. */
async function walkFolder(abs: string, rel: string, depth: number, walk: Walk): Promise<void> {
  // What is in a folder of `maxDepth` components has more than that, so it cannot be a path of the tree.
  if (depth >= walk.limits.maxDepth) {
    throw overLimit(`a folder is nested ${walk.limits.maxDepth} components deep or more`);
  }
  for (const name of await namesIn(abs, rel, walk)) {
    await visitName(join(abs, name), rel === '' ? name : `${rel}/${name}`, depth, walk);
  }
}

// ---------------------------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------------------------

/** The blind spots a walk adds, in the words they are shown with. */
function blindSpotsOf(walk: Walk): string[] {
  const spots: string[] = [];
  if (walk.gitLeftOut) spots.push(READ_DIR_BLIND_SPOTS.gitLeftOut);
  if (walk.nodeModules > 0) spots.push(nodeModulesSpot(walk.nodeModules));
  if (walk.special > 0) spots.push(specialSpot(walk.special));
  if (!walk.canExec) spots.push(READ_DIR_BLIND_SPOTS.noExecutableBit);
  return spots.sort();
}

/** The folder to read, resolved once, and known to be a folder. */
async function resolveRoot(dir: string): Promise<string> {
  // `realpath('')` is the current folder, which is not what an empty path means.
  if (typeof dir !== 'string' || dir === '') {
    throw new ReadDirError('not-found', 'there is nothing at the path to read');
  }
  let root: string;
  try {
    root = await realpath(dir);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      throw new ReadDirError('not-found', 'there is nothing at the path to read');
    }
    throw new ReadDirError('unreadable', `the path could not be resolved (${errno})`);
  }
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new ReadDirError('not-a-directory', 'the path is not a folder');
    }
  } catch (error) {
    throw error instanceof ReadDirError ? error : failure(error, '', 'folder');
  }
  return root;
}

/**
 * The tree of the folder `dir` and what was not looked at. Throws a `ReadDirError`; the faults of
 * a tree (`TreeError`) come back as one with the code `refused` (or `limit`) and the tree's code in
 * `treeCode`.
 */
export async function readDirTree(dir: string, options: ReadDirOptions = {}): Promise<DirRead> {
  const root = await resolveRoot(dir);
  const walk: Walk = {
    limits: held(options.limits),
    canExec: (options.platform ?? process.platform) !== 'win32',
    rejectNestedRepositories: options.rejectNestedRepositories === true,
    entries: [],
    visited: 0,
    expanded: 0,
    gitLeftOut: false,
    nodeModules: 0,
    special: 0,
  };
  await walkFolder(root, '', 0, walk);
  try {
    const tree = buildTree(walk.entries, { complete: true });
    return Object.freeze({ tree, blindSpots: Object.freeze(blindSpotsOf(walk)) });
  } catch (error) {
    if (!(error instanceof TreeError)) throw error;
    const code = error.code === 'limit' ? 'limit' : 'refused';
    throw new ReadDirError(code, error.message, error.code);
  }
}
