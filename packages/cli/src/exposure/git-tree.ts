import { posix } from 'node:path';
import { inAgentDir, inAgentFolder, isAgentDir, isSurfacePath } from './agent-surface.js';
import type { TreeEntry } from './git-read.js';

/**
 * A commit's tree as a host on disk would see it once checked out: links followed while they
 * stay inside it, a submodule as a folder of another repository. Nothing here runs git; the
 * caller lists the tree and reads the link targets it is asked for.
 */

export const SYMLINK = '120000';
export const GITLINK = '160000';
export const isBlob = (e: TreeEntry): boolean => e.mode === '100644' || e.mode === '100755';
/** As many links on one path as a host follows before it gives up (`ELOOP`). */
export const MAX_LINK_HOPS = 16;

export interface TreeView {
  readonly tree: ReadonlyMap<string, TreeEntry>;
  /** The tree's paths in order, to find what is under a folder. */
  readonly sorted: readonly string[];
  /** Each link read so far, by its path, and the text it holds. */
  readonly targets: ReadonlyMap<string, string>;
}

export const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The first index of `sorted` whose path is not before `prefix`. */
export function lowerBound(sorted: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The paths of `sorted` under the folder `dir`, in order; every path for the root, `''`. */
export function* under(sorted: readonly string[], dir: string): Generator<string> {
  if (dir === '') {
    yield* sorted;
    return;
  }
  const prefix = `${dir}/`;
  for (let i = lowerBound(sorted, prefix); i < sorted.length; i += 1) {
    const path = sorted[i] as string;
    if (!path.startsWith(prefix)) return;
    yield path;
  }
}

const isFolder = (sorted: readonly string[], path: string): boolean =>
  !under(sorted, path).next().done;

/**
 * Where a link's target is in the tree: a path, `''` for the root of the tree, or null when it
 * leads out of it.
 */
export function linkTarget(link: string, target: string): string | null {
  if (target === '' || target.startsWith('/') || /^[A-Za-z]:/.test(target)) return null;
  const normal = posix.normalize(posix.join(posix.dirname(link), target));
  // `cfg/` names the folder `cfg`; normalize leaves at most one slash at the end.
  const joined = normal.endsWith('/') ? normal.slice(0, -1) : normal;
  if (joined === '.' || joined === '') return '';
  return joined === '..' || joined.startsWith('../') ? null : joined;
}

export type Resolved =
  | { readonly kind: 'blob'; readonly path: string; readonly links: readonly string[] }
  | { readonly kind: 'folder'; readonly path: string; readonly links: readonly string[] }
  | {
      readonly kind: 'submodule';
      readonly path: string;
      readonly oid: string;
      readonly links: readonly string[];
    }
  | { readonly kind: 'outside'; readonly target: string; readonly links: readonly string[] }
  /** A link on the way whose target was not read. */
  | { readonly kind: 'unread'; readonly link: string; readonly links: readonly string[] }
  /**
   * Links that lead to nothing in the tree: to `missing`, which is not there, or round in a loop
   * (`missing` undefined). What a host opens there is whatever appears at the target later.
   */
  | {
      readonly kind: 'dangling';
      readonly link: string;
      readonly missing: string | undefined;
      readonly links: readonly string[];
    }
  /** No such path, and no link on the way to it. */
  | { readonly kind: 'none' };

/** The first part of `parts` that is a link or a submodule, and its path; -1 when none is. */
function firstStop(parts: readonly string[], tree: ReadonlyMap<string, TreeEntry>) {
  let path = '';
  for (let i = 0; i < parts.length; i += 1) {
    path = i === 0 ? (parts[0] as string) : `${path}/${parts[i] as string}`;
    const mode = tree.get(path)?.mode;
    if (mode === SYMLINK || mode === GITLINK) return { at: i, path };
  }
  return { at: -1, path };
}

interface StopNode {
  readonly children: Map<string, StopNode>;
  path?: string;
}

/** Segment keys avoid hashing each growing whole-path prefix. */
function stopIndex(tree: ReadonlyMap<string, TreeEntry>): StopNode {
  const root: StopNode = { children: new Map() };
  for (const [path, entry] of tree) {
    if (entry.mode !== SYMLINK && entry.mode !== GITLINK) continue;
    let node = root;
    for (const part of path.split('/')) {
      let next = node.children.get(part);
      if (next === undefined) {
        next = { children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    node.path = path;
  }
  return root;
}

function indexedStop(parts: readonly string[], index: StopNode) {
  let node = index;
  for (let i = 0; i < parts.length; i += 1) {
    const next = node.children.get(parts[i] as string);
    if (next === undefined) break;
    node = next;
    if (node.path !== undefined) return { at: i, path: node.path };
  }
  return { at: -1, path: parts.join('/') };
}

/** What is at `path`, a path with no link or submodule on the way to it. */
function landed(path: string, links: readonly string[], view: TreeView): Resolved {
  const entry = view.tree.get(path);
  if (entry !== undefined && isBlob(entry)) return { kind: 'blob', path, links };
  if (isFolder(view.sorted, path)) return { kind: 'folder', path, links };
  const link = links.at(-1);
  return link === undefined ? { kind: 'none' } : { kind: 'dangling', link, missing: path, links };
}

/**
 * `path` as a host on disk would open it: each link on the way replaced by where it points, as
 * long as that stays inside the tree. `links` are the link paths passed through.
 */
function resolveWith(
  path: string,
  view: TreeView,
  stopAt: (parts: readonly string[]) => { at: number; path: string },
): Resolved {
  let parts = path === '' ? [] : path.split('/');
  const links: string[] = [];
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops += 1) {
    const stop = stopAt(parts);
    if (stop.at === -1) return landed(stop.path, links, view);
    const entry = view.tree.get(stop.path) as TreeEntry;
    if (entry.mode === GITLINK)
      return { kind: 'submodule', path: stop.path, oid: entry.oid, links };
    links.push(stop.path);
    const raw = view.targets.get(stop.path);
    if (raw === undefined) return { kind: 'unread', link: stop.path, links };
    const target = linkTarget(stop.path, raw);
    if (target === null) return { kind: 'outside', target: raw, links };
    parts = [...(target === '' ? [] : target.split('/')), ...parts.slice(stop.at + 1)];
  }
  // More links in a row than a host follows: it gives up there, and so does this.
  return { kind: 'dangling', link: links.at(-1) as string, missing: undefined, links };
}

/**
 * A single lookup keeps the small ordinary-path fast path. Its depth bound limits prefix-hash
 * work, not resolution: deeper paths use the complete stop index and retain every outcome.
 */
export function resolve(path: string, view: TreeView): Resolved {
  let index: StopNode | undefined;
  return resolveWith(path, view, (parts) =>
    parts.length <= 32
      ? firstStop(parts, view.tree)
      : indexedStop(parts, (index ??= stopIndex(view.tree))),
  );
}

/**
 * Reuse only within one synchronous operation whose readonly tree does not change. The index
 * is local, never cached on a mutable Map; later operations build it again. Targets stay live.
 */
export function createTreeResolver(view: TreeView): (path: string) => Resolved {
  const index = stopIndex(view.tree);
  return (path) => resolveWith(path, view, (parts) => indexedStop(parts, index));
}

/** A link whose target decides what an agent or editor loads. */
export const linkMatters = (path: string): boolean => isSurfacePath(path) || inAgentFolder(path);

/**
 * The links to read after the ones already read: the links on the way to each target read so
 * far, and the links inside a folder that one points at, since a host opens those through it.
 */
export function linksOnTheWay(view: TreeView, read: Iterable<string>): Set<string> {
  const next = new Set<string>();
  const want = (path: string): void => {
    if (view.tree.get(path)?.mode === SYMLINK && !view.targets.has(path)) next.add(path);
  };
  for (const link of read) {
    const target = linkTarget(link, view.targets.get(link) ?? '');
    if (target === null) continue;
    let prefix = '';
    for (const part of target.split('/')) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      want(prefix);
    }
    for (const path of under(view.sorted, target)) want(path);
  }
  return next;
}

/** Whether `real` is already what a folder on the way to `virtual` stands for: a loop. */
function loops(expanded: ReadonlyMap<string, string>, virtual: string, real: string): boolean {
  let prefix = '';
  for (const part of virtual.split('/')) {
    prefix = prefix === '' ? part : `${prefix}/${part}`;
    if (prefix !== virtual && expanded.get(prefix) === real) return true;
  }
  return false;
}

/** A path a host opens that the readers want, a submodule where one would be, or a link to one. */
const wanted = (path: string, entry: TreeEntry | undefined): boolean =>
  isSurfacePath(path) || isAgentDir(path) || (entry?.mode === GITLINK && inAgentDir(path));

export interface Paths {
  readonly paths: readonly string[];
  /** Where the walk through links stopped at `maxSteps`, or undefined when it did not. */
  readonly stoppedAt: string | undefined;
}

/**
 * The paths a host would open: the tree's own, and those it reaches through a link to a folder,
 * links inside that folder included. A link that leads to no file or folder of the tree is one
 * too, whatever its name, so that it is reported: what is behind it was not read. `maxSteps`
 * bounds the entries walked through links.
 */
export function openedPaths(view: TreeView, maxSteps: number): Paths {
  const resolvePath = createTreeResolver(view);
  const paths = new Set(view.sorted.filter((path) => wanted(path, view.tree.get(path))));
  const queue = view.sorted.filter((p) => view.tree.get(p)?.mode === SYMLINK && linkMatters(p));
  const expanded = new Map<string, string>();
  let steps = 0;
  for (let next = 0; next < queue.length; next += 1) {
    const virtual = queue[next] as string;
    const at = resolvePath(virtual);
    if (at.kind !== 'folder') {
      if (at.kind !== 'blob') paths.add(virtual);
      continue;
    }
    if (expanded.has(virtual) || loops(expanded, virtual, at.path)) continue;
    expanded.set(virtual, at.path);
    for (const real of under(view.sorted, at.path)) {
      steps += 1;
      if (steps > maxSteps) return { paths: [...paths], stoppedAt: virtual };
      const seen = `${virtual}/${at.path === '' ? real : real.slice(at.path.length + 1)}`;
      const entry = view.tree.get(real);
      if (entry?.mode === SYMLINK && linkMatters(seen)) queue.push(seen);
      if (wanted(seen, entry)) paths.add(seen);
    }
  }
  return { paths: [...paths], stoppedAt: undefined };
}
