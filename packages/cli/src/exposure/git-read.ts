import { execFileSync } from 'node:child_process';
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

function run(top: string, args: readonly string[], maxBuffer: number, input?: string): Buffer {
  return execFileSync('git', ['--no-optional-locks', ...args], {
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

/** `git ls-tree -r -l -z`: every blob, link and submodule of a commit, by path. */
export function listTree(top: string, commit: string): Map<string, TreeEntry> {
  const out = run(top, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], MAX_LISTING_BYTES);
  const tree = new Map<string, TreeEntry>();
  for (const record of out.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', , oid = '', size = '-'] = record.slice(0, tab).split(/ +/);
    tree.set(record.slice(tab + 1), { mode, oid, size: size === '-' ? -1 : Number(size) });
  }
  return tree;
}

/**
 * `git diff --raw -z --no-abbrev`: each path that differs between the two commits, with its mode
 * and blob at the base, so the old contents can be read by id in one batch.
 */
export function changedPaths(top: string, base: string, head: string): Map<string, Changed> {
  const out = run(
    top,
    [
      'diff',
      '--raw',
      '-z',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      base,
      head,
    ],
    MAX_LISTING_BYTES,
  );
  const parts = out.toString('utf8').split('\0');
  const changed = new Map<string, Changed>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode = '', , oldOid = '', , status = ''] = (parts[i] as string).slice(1).split(' ');
    changed.set(parts[i + 1] as string, { status: status.charAt(0), oldMode, oldOid });
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
