import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hardeningEnv } from './git-hardening.js';

/**
 * The calls to git that `stroq inspect --changed-from` makes, and nothing else: list a commit's
 * tree, name what changed between two commits, and print blobs by their ids. None of these runs
 * a filter, a diff driver or a hook, the hardening overlay `stroq inspect --env` prints is in
 * force, and each call has a time limit and a limit on what it may print.
 */

export class GitError extends Error {}

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  /** Bytes, for a blob; -1 for anything else. */
  readonly size: number;
}

/** What `git diff --raw` says of one path: how it changed, and what it was at the base. */
export interface Changed {
  readonly status: string;
  readonly oldMode: string;
  readonly oldOid: string;
}

/** The most one listing may print: a tree of several hundred thousand files fits. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
/** The most bytes of blobs one `git cat-file --batch` is asked for. */
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
/** The longest one call to git may take before it is stopped. */
export const GIT_TIMEOUT_MS = 60_000;

/** The folder a checkout is in: `dir` or the nearest folder above it that holds a `.git`. */
function checkoutOf(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return resolve(dir);
  }
  for (let at = real; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return real;
  }
}

const inside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const isProgram = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The git found for each checkout, by its folder and the PATH it was looked up in. */
const found = new Map<string, string | null>();

/**
 * The git to run for a check that starts in `cwd`, by its full path: the first one in a folder of
 * PATH that is written out in full and is not inside the checkout. A bare `git` would be looked
 * up in the folder it starts in first on Windows, and on POSIX for an empty or relative part of
 * PATH, and that folder's files are the change being checked; a folder of PATH inside the
 * checkout, such as its `node_modules/.bin`, holds the change's files too.
 */
export function gitProgram(cwd: string): string | null {
  const checkout = checkoutOf(cwd);
  const key = `${checkout}\0${process.env.PATH ?? ''}`;
  const known = found.get(key);
  if (known !== undefined) return known;
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  let program: string | null = null;
  for (const part of (process.env.PATH ?? '').split(delimiter)) {
    if (part === '' || !isAbsolute(part)) continue;
    let folder: string;
    try {
      folder = realpathSync(part);
    } catch {
      continue;
    }
    if (inside(checkout, folder)) continue;
    const hit = names.map((n) => join(folder, n)).find(isProgram);
    if (hit !== undefined) {
      program = hit;
      break;
    }
  }
  found.set(key, program);
  return program;
}

function run(top: string, args: readonly string[], maxBuffer: number, input?: string): Buffer {
  const program = gitProgram(top);
  if (program === null)
    throw Object.assign(new Error('no git'), {
      code: 'ENOENT',
      stderr: 'git was not found in a folder of PATH outside the folder being checked',
    });
  return execFileSync(program, ['--no-optional-locks', ...args], {
    cwd: top,
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }),
    env: {
      ...process.env,
      ...hardeningEnv(process.env),
      GIT_TERMINAL_PROMPT: '0',
      // A partial clone would otherwise fetch a missing blob from the network to print it.
      GIT_NO_LAZY_FETCH: '1',
    },
  });
}

/** The first line git wrote to stderr, for a message; never the output itself. */
export const reason = (err: unknown): string => {
  const e = err as { stderr?: Buffer | string; code?: unknown; signal?: unknown };
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL')
    return `git took longer than ${GIT_TIMEOUT_MS / 1000} s`;
  if (e.code === 'ENOBUFS') return 'git printed more than one check reads';
  const first =
    String(e.stderr ?? '')
      .split('\n')[0]
      ?.trim() ?? '';
  return first === '' ? 'git failed' : first.slice(0, 200);
};

/** An error from running git: it exited badly, was stopped, or wrote more than was asked for. */
export const isGitFailure = (err: unknown): boolean => {
  const e = err as { status?: unknown; code?: unknown; signal?: unknown };
  return (
    typeof e.status === 'number' ||
    typeof e.signal === 'string' ||
    e.code === 'ENOBUFS' ||
    e.code === 'ENOENT' ||
    e.code === 'ETIMEDOUT'
  );
};

export function revision(top: string, rev: string): string {
  try {
    return run(top, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], 4096)
      .toString('utf8')
      .trim();
  } catch {
    throw new GitError(`cannot find ${rev}: fetch it first (in CI, check out with fetch-depth: 2)`);
  }
}

export function topLevel(dir: string): string {
  try {
    return run(dir, ['rev-parse', '--show-toplevel'], 64 * 1024)
      .toString('utf8')
      .trim();
  } catch (err) {
    throw new GitError(`${dir} is not a git repository you can read: ${reason(err)}`);
  }
}

/** Decodes UTF-8 and throws on bytes that are not, keeping a byte order mark as a character. */
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The NUL-separated records of a listing as text, and which of them are not UTF-8. Git keeps a
 * path as bytes: two that differ only in bytes that are not UTF-8 decode to the same text, so
 * such a path is marked, for the caller to report rather than to read.
 */
function records(out: Buffer): { readonly text: string[]; readonly lossy: ReadonlySet<number> } {
  try {
    return { text: STRICT.decode(out).split('\0'), lossy: new Set() };
  } catch {
    // Some record is not UTF-8: each one is decoded on its own to find which.
  }
  const text: string[] = [];
  const lossy = new Set<number>();
  for (let at = 0; ;) {
    const end = out.indexOf(0, at);
    const bytes = out.subarray(at, end === -1 ? out.length : end);
    try {
      text.push(STRICT.decode(bytes));
    } catch {
      lossy.add(text.length);
      text.push(bytes.toString('utf8'));
    }
    if (end === -1) return { text, lossy };
    at = end + 1;
  }
}

export interface Tree {
  /** Every blob, link and submodule of a commit, by path. */
  readonly entries: Map<string, TreeEntry>;
  /** Paths that are not UTF-8, as decoded: each may stand for more than one path of the tree. */
  readonly lossy: readonly string[];
  /**
   * Texts that two or more paths of the tree decode to. Git lists each path, as bytes, once, so a
   * text seen twice stands for two paths: `entries` holds one of them, and the other was hidden.
   */
  readonly collisions: readonly string[];
}

/** `git ls-tree -r -l -z`: every blob, link and submodule of a commit, by path. */
export function listTree(top: string, commit: string): Tree {
  const out = run(top, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], MAX_LISTING_BYTES);
  const entries = new Map<string, TreeEntry>();
  const lossy = new Set<string>();
  const collisions = new Set<string>();
  const listing = records(out);
  listing.text.forEach((record, i) => {
    const tab = record.indexOf('\t');
    if (tab === -1) return;
    const [mode = '', , oid = '', size = '-'] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (entries.has(path)) collisions.add(path);
    entries.set(path, { mode, oid, size: size === '-' ? -1 : Number(size) });
    if (listing.lossy.has(i)) lossy.add(path);
  });
  return { entries, lossy: [...lossy], collisions: [...collisions] };
}

/**
 * `git diff --raw -z --no-abbrev`: each path that differs between the two commits, with its mode
 * and blob at the base, so the old contents can be read by id in one batch. A submodule is
 * compared too, whatever `.gitmodules` says: `ignore = all` there, which the change itself can
 * write, would otherwise leave a new or moved submodule out of the diff.
 */
export function changedPaths(top: string, base: string, head: string): Map<string, Changed> {
  const out = run(
    top,
    [
      '-c',
      'diff.ignoreSubmodules=none',
      'diff',
      '--raw',
      '-z',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=none',
      base,
      head,
    ],
    MAX_LISTING_BYTES,
  );
  // Decoded as the tree is, so a path that is not UTF-8 is found under the same text.
  const parts = records(out).text;
  const changed = new Map<string, Changed>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode = '', , oldOid = '', , status = ''] = (parts[i] as string).slice(1).split(' ');
    const path = parts[i + 1] as string;
    // Two paths that decode to one text: the one the head still has decides how it changed.
    if (changed.get(path)?.status !== undefined && status.charAt(0) === 'D') continue;
    changed.set(path, { status: status.charAt(0), oldMode, oldOid });
  }
  return changed;
}

/** `git cat-file --batch-check` over `oids`: the size of each object that is there. */
export function objectSizes(top: string, oids: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const out = run(top, ['cat-file', '--batch-check'], MAX_LISTING_BYTES, `${oids.join('\n')}\n`);
  for (const line of out.toString('utf8').split('\n')) {
    const [oid = '', type = '', size = ''] = line.split(' ');
    if (type === 'blob') sizes.set(oid, Number(size));
  }
  return sizes;
}

/** One `git cat-file --batch` over `oids`, parsed. A blob that is not there is left out. */
function readBatch(top: string, oids: readonly string[], bytes: number, into: Map<string, string>) {
  const room = bytes + oids.length * 128 + 4096;
  const out = run(top, ['cat-file', '--batch'], room, `${oids.join('\n')}\n`);
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) break;
    const [oid = '', type = '', size = ''] = out.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (type === 'missing' || size === '') continue;
    const length = Number(size);
    into.set(oid, out.toString('utf8', at, at + length));
    at += length + 1;
  }
}

/** Blobs by id, read in batches of a bounded size so that no one read is unbounded. */
export function readBlobs(
  top: string,
  wanted: readonly { readonly oid: string; readonly size: number }[],
): Map<string, string> {
  const blobs = new Map<string, string>();
  let batch: string[] = [];
  let bytes = 0;
  for (const { oid, size } of wanted) {
    if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      readBatch(top, batch, bytes, blobs);
      batch = [];
      bytes = 0;
    }
    batch.push(oid);
    bytes += Math.max(size, 0);
  }
  if (batch.length > 0) readBatch(top, batch, bytes, blobs);
  return blobs;
}
