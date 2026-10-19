import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { tagChanges, type TaggedHit } from './agent-change.js';
import { hit, type AgentHit } from './agent-kinds.js';
import {
  AGENT_DIRS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  hitsForRead,
  isSurfacePath,
  type SourceRead,
} from './agent-surface.js';
import { hardeningEnv } from './git-hardening.js';

/**
 * What a change brings that an agent or an editor runs by itself: the values at HEAD compared
 * with the values at a base revision.
 *
 * Both sides are read from git's objects, never from the working tree, and git is asked only
 * to list trees, to name the paths that differ between two commits, and to print blobs. None
 * of those runs a filter, a diff driver or a hook, and the hardening overlay `stroq inspect
 * --env` prints is applied as well. `.git` is never read: a change cannot alter it, and what
 * `actions/checkout` writes there is not the change's doing.
 */

export class GitError extends Error {}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  /** Bytes, for a blob; -1 for anything else. */
  readonly size: number;
}

/** The most output of one listing that is read: a tree of many thousand files fits. */
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const MAX_LINK_HOPS = 16;
const MAX_LINKS = 500;
const MAX_CANDIDATES = 2_000;
const MAX_LINK_BYTES = 4096;
const SYMLINK = '120000';
const isBlob = (e: TreeEntry): boolean => e.mode === '100644' || e.mode === '100755';

function run(
  top: string,
  args: readonly string[],
  maxBuffer = MAX_LISTING_BYTES,
  input?: string,
): Buffer {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: top,
    maxBuffer,
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
const reason = (err: unknown): string => {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const first =
    String(stderr ?? '')
      .split('\n')[0]
      ?.trim() ?? '';
  return first === '' ? 'git failed' : first.slice(0, 200);
};

function revision(top: string, rev: string): string {
  try {
    return run(top, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
      .toString('utf8')
      .trim();
  } catch {
    throw new GitError(`cannot find ${rev}: fetch it first (in CI, check out with fetch-depth: 2)`);
  }
}

function topLevel(dir: string): string {
  try {
    return run(dir, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch (err) {
    throw new GitError(`${dir} is not a git repository you can read: ${reason(err)}`);
  }
}

/** `git ls-tree -r -l -z`: every blob, link and submodule of a commit, by path. */
function listTree(top: string, commit: string): Map<string, TreeEntry> {
  const out = run(top, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]).toString('utf8');
  const tree = new Map<string, TreeEntry>();
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', , oid = '', size = '-'] = record.slice(0, tab).split(/ +/);
    tree.set(record.slice(tab + 1), { mode, oid, size: size === '-' ? -1 : Number(size) });
  }
  return tree;
}

/** `git diff --name-status -z`: each path that differs between the two commits, by its status. */
function changedPaths(top: string, base: string, head: string): Map<string, string> {
  const out = run(top, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    base,
    head,
  ]).toString('utf8');
  const parts = out.split('\0');
  const changed = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    changed.set(parts[i + 1] as string, (parts[i] as string).charAt(0));
  }
  return changed;
}

/** The most bytes of blobs one `git cat-file --batch` is asked for. */
const MAX_BATCH_BYTES = 32 * 1024 * 1024;

/** One `git cat-file --batch` over `oids`, parsed. A blob that is not there is left out. */
function readBatch(top: string, oids: readonly string[], into: Map<string, string>): void {
  const out = run(top, ['cat-file', '--batch'], MAX_LISTING_BYTES, `${oids.join('\n')}\n`);
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) break;
    const [oid = '', type = '', size = ''] = out.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (type === 'missing' || size === '') continue;
    const bytes = Number(size);
    into.set(oid, out.toString('utf8', at, at + bytes));
    at += bytes + 1;
  }
}

/** Blobs by id, read in batches of a bounded size so that no one read is unbounded. */
function readBlobs(top: string, entries: readonly TreeEntry[]): Map<string, string> {
  const blobs = new Map<string, string>();
  let batch: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && bytes + entry.size > MAX_BATCH_BYTES) {
      readBatch(top, batch, blobs);
      batch = [];
      bytes = 0;
    }
    batch.push(entry.oid);
    bytes += Math.max(entry.size, 0);
  }
  if (batch.length > 0) readBatch(top, batch, blobs);
  return blobs;
}

/** A blob of the base commit by path, or what kept it from being read. */
function readAt(top: string, commit: string, path: string): SourceRead {
  try {
    const text = run(top, ['cat-file', 'blob', `${commit}:${path}`], MAX_FILE_BYTES + 1);
    return { kind: 'text', text: text.toString('utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOBUFS'
      ? { kind: 'too-large', size: MAX_FILE_BYTES + 1 }
      : { kind: 'unreadable' };
  }
}

/** Where a link's target is in the tree, or null when it leads out of the repository. */
function linkTarget(link: string, target: string): string | null {
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return null;
  const joined = posix.normalize(posix.join(posix.dirname(link), target));
  return joined === '..' || joined.startsWith('../') || joined === '.' ? null : joined;
}

type Resolved =
  | { readonly kind: 'blob'; readonly path: string; readonly links: readonly string[] }
  | { readonly kind: 'outside'; readonly target: string; readonly links: readonly string[] }
  | { readonly kind: 'none' };

/**
 * `path` as a host on disk would open it: each link on the way replaced by where it points,
 * as long as that stays inside the tree. `links` are the link paths passed through.
 */
function resolve(
  path: string,
  tree: ReadonlyMap<string, TreeEntry>,
  targets: ReadonlyMap<string, string>,
): Resolved {
  let parts = path.split('/');
  const links: string[] = [];
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops += 1) {
    const link = parts.findIndex(
      (_, i) => tree.get(parts.slice(0, i + 1).join('/'))?.mode === SYMLINK,
    );
    if (link === -1) {
      const at = parts.join('/');
      const entry = tree.get(at);
      return entry !== undefined && isBlob(entry)
        ? { kind: 'blob', path: at, links }
        : { kind: 'none' };
    }
    const linkPath = parts.slice(0, link + 1).join('/');
    links.push(linkPath);
    const raw = targets.get(linkPath);
    if (raw === undefined) return { kind: 'none' };
    const target = linkTarget(linkPath, raw);
    if (target === null) return { kind: 'outside', target: raw, links };
    parts = [...target.split('/'), ...parts.slice(link + 1)];
  }
  return { kind: 'none' };
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The first index of `sorted` whose path is not before `prefix`. */
function lowerBound(sorted: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The paths a host would open: the tree's own, and those under a linked folder inside it. */
function candidatePaths(
  tree: ReadonlyMap<string, TreeEntry>,
  targets: ReadonlyMap<string, string>,
): string[] {
  const sorted = [...tree.keys()].sort(byPath);
  const paths = new Set(
    sorted.filter((path) => isSurfacePath(path) || AGENT_DIRS.has(path.toLowerCase())),
  );
  for (const [link, raw] of targets) {
    const target = linkTarget(link, raw);
    if (target === null) continue;
    const prefix = `${target}/`;
    for (let i = lowerBound(sorted, prefix); i < sorted.length; i += 1) {
      const path = sorted[i] as string;
      if (!path.startsWith(prefix)) break;
      const seen = `${link}/${path.slice(prefix.length)}`;
      if (isSurfacePath(seen)) paths.add(seen);
    }
  }
  return [...paths].sort(byPath).slice(0, MAX_CANDIDATES);
}

/** Folders that hold `HEAD`, `objects/` and `refs/`: a bare repository committed as files. */
export function bareRepositories(paths: Iterable<string>): string[] {
  const heads = new Set<string>();
  const objects = new Set<string>();
  const refs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (i === parts.length - 1 && parts[i] === 'HEAD') heads.add(dir);
      if (parts[i] === 'objects' && i < parts.length - 1) objects.add(dir);
      if (parts[i] === 'refs' && i < parts.length - 1) refs.add(dir);
    }
  }
  return [...heads].filter((dir) => objects.has(dir) && refs.has(dir)).sort();
}

export interface AgentChanges {
  /** The commit the base revision named. */
  readonly base: string;
  readonly hits: readonly TaggedHit[];
}

/** An error from running git (it exited badly, or wrote more than was asked for). */
const isGitFailure = (err: unknown): boolean => {
  const e = err as { status?: unknown; code?: unknown };
  return typeof e.status === 'number' || e.code === 'ENOBUFS' || e.code === 'ENOENT';
};

/** What changed between `rev` and HEAD of the repository that holds `dir`. */
export function agentChanges(dir: string, rev: string): AgentChanges {
  const top = topLevel(dir);
  const base = revision(top, rev);
  const head = revision(top, 'HEAD');
  try {
    return compare(top, base, head);
  } catch (err) {
    if (!isGitFailure(err)) throw err;
    throw new GitError(`git could not compare ${rev} with HEAD: ${reason(err)}`);
  }
}

/**
 * What the blobs of the plan cost, in the order of their paths, until the budget is spent:
 * the ones to read, and the ones past the budget, which are reported and not read.
 */
function budgeted(
  plan: readonly { readonly at: Resolved }[],
  tree: ReadonlyMap<string, TreeEntry>,
): { wanted: TreeEntry[]; over: Set<string> } {
  const wanted = new Map<string, TreeEntry>();
  const over = new Set<string>();
  let left = MAX_TOTAL_BYTES;
  for (const { at } of plan) {
    const entry = at.kind === 'blob' ? tree.get(at.path) : undefined;
    if (entry === undefined || entry.size > MAX_FILE_BYTES || wanted.has(entry.oid)) continue;
    if (entry.size > left) {
      over.add(entry.oid);
      continue;
    }
    left -= entry.size;
    wanted.set(entry.oid, entry);
  }
  return { wanted: [...wanted.values()], over };
}

function compare(top: string, base: string, head: string): AgentChanges {
  const tree = listTree(top, head);
  const changed = changedPaths(top, base, head);
  // A link's target is a path; one longer than a path can be is not a link a checkout makes.
  const links = [...tree]
    .filter(([, e]) => e.mode === SYMLINK && e.size <= MAX_LINK_BYTES)
    .slice(0, MAX_LINKS);
  const linkBlobs = readBlobs(
    top,
    links.map(([, e]) => e),
  );
  const targets = new Map(links.map(([path, e]) => [path, linkBlobs.get(e.oid) ?? ''] as const));
  const plan = candidatePaths(tree, targets).map((path) => ({
    path,
    at: resolve(path, tree, targets),
  }));
  const { wanted, over } = budgeted(plan, tree);
  const blobs = readBlobs(top, wanted);
  const hits = plan.flatMap(({ path, at }) => {
    if (at.kind === 'none') return [];
    if (at.kind === 'outside') {
      if (!isSurfacePath(path) && !AGENT_DIRS.has(path.toLowerCase())) return [];
      const status = at.links.some((l) => changed.has(l)) ? 'new' : 'present';
      return [{ ...hit('config-link-outside', path, 1, 'link', at.target), status } as TaggedHit];
    }
    const entry = tree.get(at.path) as TreeEntry;
    const read: SourceRead =
      entry.size > MAX_FILE_BYTES
        ? { kind: 'too-large', size: entry.size }
        : over.has(entry.oid)
          ? { kind: 'over-budget', budget: MAX_TOTAL_BYTES }
          : { kind: 'text', text: blobs.get(entry.oid) ?? '' };
    const now = hitsForRead(path, read);
    return tagChanges(now, baseHits(top, base, path, at, changed, now));
  });
  // A stable sort: each file's hits keep the order of their lines.
  const all = [...hits, ...bareChanges(tree, changed)].sort((a, b) => byPath(a.file, b.file));
  return { base, hits: all };
}

/** The hits of the same file at the base: the same ones when nothing on its way changed. */
function baseHits(
  top: string,
  base: string,
  path: string,
  at: { readonly path: string; readonly links: readonly string[] },
  changed: ReadonlyMap<string, string>,
  now: readonly AgentHit[],
): readonly AgentHit[] {
  const status = changed.get(at.path);
  const linkChanged = at.links.some((l) => changed.has(l));
  if (!linkChanged && status === undefined) return now;
  if (linkChanged || status === 'A') return [];
  return hitsForRead(path, readAt(top, base, at.path));
}

function bareChanges(
  tree: ReadonlyMap<string, TreeEntry>,
  changed: ReadonlyMap<string, string>,
): TaggedHit[] {
  const headPaths = [...tree.keys()];
  const basePaths = [
    ...headPaths.filter((p) => changed.get(p) !== 'A'),
    ...[...changed].filter(([, s]) => s === 'D').map(([p]) => p),
  ];
  const before = new Set(bareRepositories(basePaths));
  return bareRepositories(headPaths).map((dir) => ({
    ...hit('nested-bare-repo', dir, 1, 'bare repository', 'HEAD, objects, refs'),
    status: before.has(dir) ? 'present' : 'new',
  }));
}
