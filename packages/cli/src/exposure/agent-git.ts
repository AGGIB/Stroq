import { isPlainObject } from '../commands/config-file.js';
import { tagChanges, type ChangeStatus, type TaggedHit } from './agent-change.js';
import { escalateApproved } from './agent-json.js';
import { hit, type AgentHit } from './agent-kinds.js';
import { runFileChanges, type PackageScripts, type RunView } from './agent-run-files.js';
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  hitsForRead,
  readTier,
  type SourceRead,
} from './agent-surface.js';
import {
  GitError,
  changedPaths,
  isGitFailure,
  listTree,
  objectSizes,
  readBlobs,
  reason,
  revision,
  topLevel,
  type Changed,
  type TreeEntry,
} from './git-read.js';
import {
  GITLINK,
  MAX_LINK_HOPS,
  SYMLINK,
  byPath,
  isBlob,
  linkMatters,
  linksOnTheWay,
  openedPaths,
  resolve,
  type Resolved,
  type TreeView,
} from './git-tree.js';

import { stripJsonc } from './jsonc.js';

export { GitError } from './git-read.js';

/**
 * What a change brings that an agent or an editor runs by itself: the values at HEAD compared
 * with the values at a base revision. Both sides are read from git's objects, never from the
 * working tree, and `.git` is never read: a change cannot alter it, and what `actions/checkout`
 * writes there is not the change's doing.
 *
 * The author of the change chooses its size, so no limit here may pass it quietly. The configs
 * at a fixed place are read first, then the files the change touched, then the rest; whatever a
 * limit keeps from being read is a failing entry, and so is a link whose target was not read.
 * The one exception is an instruction file the change did not touch: it runs nothing.
 */

export const GIT_CAPS = {
  /** The most agent files one check reads. */
  candidates: 5_000,
  /** The most links whose target one check reads. */
  links: 2_000,
  /** The most entries one check walks through links to folders. */
  steps: 50_000,
} as const;
/** A link's target is a path; one longer than a path can be is not a link a checkout makes. */
const MAX_LINK_BYTES = 4096;

export interface AgentChanges {
  /** The commit the base revision named. */
  readonly base: string;
  /** The top of the repository compared: the whole of it, whichever folder of it was given. */
  readonly root: string;
  readonly hits: readonly TaggedHit[];
  /** True when a limit kept the check from reading every agent file or link. */
  readonly capped: boolean;
}

/** What changed between `rev` and HEAD of the repository that holds `dir`. */
export function agentChanges(dir: string, rev: string): AgentChanges {
  const root = topLevel(dir);
  const base = revision(root, rev);
  const head = revision(root, 'HEAD');
  try {
    return { root, ...compare(root, base, head) };
  } catch (err) {
    if (!isGitFailure(err)) throw err;
    throw new GitError(`git could not compare ${rev} with HEAD: ${reason(err)}`);
  }
}

const tagged = (h: AgentHit, status: ChangeStatus): TaggedHit => ({ ...h, status });
const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];
const entryAt = (tree: ReadonlyMap<string, TreeEntry>, path: string): TreeEntry =>
  tree.get(path) as TreeEntry;

/** The targets of the links a host follows to an agent file, read round by round. */
function readLinks(top: string, tree: ReadonlyMap<string, TreeEntry>, sorted: readonly string[]) {
  const targets = new Map<string, string>();
  const view: TreeView = { tree, sorted, targets };
  const tried = new Set<string>();
  const cut: string[] = [];
  let next = sorted.filter((p) => tree.get(p)?.mode === SYMLINK && linkMatters(p));
  for (let round = 0; round <= MAX_LINK_HOPS && next.length > 0; round += 1) {
    const ordered = [...next].sort((a, b) => readTier(a) - readTier(b) || byPath(a, b));
    const room = Math.max(0, GIT_CAPS.links - tried.size);
    const now = ordered.slice(0, room);
    cut.push(...ordered.slice(room));
    for (const p of now) tried.add(p);
    const small = now.map((p) => entryAt(tree, p)).filter((e) => e.size <= MAX_LINK_BYTES);
    const blobs = readBlobs(top, small);
    for (const p of now) {
      const text = blobs.get(entryAt(tree, p).oid);
      if (text !== undefined) targets.set(p, text);
    }
    next = [...linksOnTheWay(view, now)].filter((p) => !tried.has(p));
  }
  return { view, cut: unique([...cut, ...next]) };
}

interface Planned {
  readonly path: string;
  readonly at: Resolved;
  readonly tier: 0 | 1 | 2;
  /** Whether the change touched it: the path a host opens, a link on the way, or the file behind. */
  readonly touched: boolean;
}

const linksOf = (at: Resolved): readonly string[] => (at.kind === 'none' ? [] : at.links);
/** The path of the tree a host ends up at, there or not: a change to it is a change here. */
const behind = (at: Resolved): string | undefined =>
  at.kind === 'blob' || at.kind === 'submodule' || at.kind === 'folder'
    ? at.path
    : at.kind === 'dangling'
      ? at.missing
      : undefined;
const linkChanged = (at: Resolved, changed: ReadonlyMap<string, Changed>): boolean =>
  linksOf(at).some((l) => changed.has(l));

function plan(view: TreeView, changed: ReadonlyMap<string, Changed>) {
  const opened = openedPaths(view, GIT_CAPS.steps);
  const all = opened.paths.map((path): Planned => {
    const at = resolve(path, view);
    const file = behind(at);
    const touched =
      changed.has(path) || (file !== undefined && changed.has(file)) || linkChanged(at, changed);
    return { path, at, tier: readTier(path), touched };
  });
  // The configs at a fixed place first, then what the change touched, then the rest.
  const rank = (p: Planned): number => (p.tier === 0 ? 0 : p.touched ? 1 : 2);
  const ordered = [...all].sort(
    (a, b) => rank(a) - rank(b) || a.tier - b.tier || byPath(a.path, b.path),
  );
  return {
    kept: ordered.slice(0, GIT_CAPS.candidates),
    dropped: ordered.slice(GIT_CAPS.candidates),
    stoppedAt: opened.stoppedAt,
  };
}

/** The blobs to read, in order, until what is `left` of the budget is spent. */
function budget(wanted: readonly TreeEntry[], left: { bytes: number }, known: ReadonlySet<string>) {
  const read = new Map<string, TreeEntry>();
  const over = new Set<string>();
  for (const entry of wanted) {
    if (entry.size > MAX_FILE_BYTES || read.has(entry.oid) || known.has(entry.oid)) continue;
    if (entry.size > left.bytes) {
      over.add(entry.oid);
      continue;
    }
    left.bytes -= entry.size;
    read.set(entry.oid, entry);
  }
  return { read: [...read.values()], over };
}

/** What a source found for one blob: its text, or why it was not read. */
function sourceOf(
  entry: TreeEntry,
  over: ReadonlySet<string>,
  blobs: ReadonlyMap<string, string>,
): SourceRead {
  if (entry.size > MAX_FILE_BYTES) return { kind: 'too-large', size: entry.size };
  if (over.has(entry.oid)) return { kind: 'over-budget', budget: MAX_TOTAL_BYTES };
  return { kind: 'text', text: blobs.get(entry.oid) ?? '' };
}

/** The base blob of a file the change edited in place; undefined when there is none to read. */
function baseOid(p: Planned, changed: ReadonlyMap<string, Changed>): string | undefined {
  if (p.at.kind !== 'blob' || linkChanged(p.at, changed)) return undefined;
  const c = changed.get(p.at.path);
  return c !== undefined && (c.oldMode === '100644' || c.oldMode === '100755')
    ? c.oldOid
    : undefined;
}

/** Reads every blob the plan wants, head first, both sides charged to one budget of bytes. */
function readPlan(
  top: string,
  tree: ReadonlyMap<string, TreeEntry>,
  kept: readonly Planned[],
  changed: ReadonlyMap<string, Changed>,
) {
  const left = { bytes: MAX_TOTAL_BYTES };
  const heads = kept.flatMap((p) => (p.at.kind === 'blob' ? [entryAt(tree, p.at.path)] : []));
  const head = budget(heads, left, new Set());
  const oids = unique(kept.flatMap((p) => baseOid(p, changed) ?? []));
  const sizes = objectSizes(top, oids);
  const olds = oids.map((oid): TreeEntry => ({ mode: '100644', oid, size: sizes.get(oid) ?? -1 }));
  const base = budget(olds, left, new Set(head.read.map((e) => e.oid)));
  const blobs = readBlobs(top, [...head.read, ...base.read]);
  return {
    overBudget: head.over.size + base.over.size > 0,
    headSource: (entry: TreeEntry) => sourceOf(entry, head.over, blobs),
    baseSource: (oid: string) => {
      const size = sizes.get(oid);
      // An id git did not size is not there to read: everything in the file counts as new.
      return size === undefined
        ? undefined
        : sourceOf({ mode: '100644', oid, size }, base.over, blobs);
    },
  };
}

function compare(top: string, base: string, head: string) {
  const tree = listTree(top, head);
  const sorted = [...tree.keys()].sort(byPath);
  const changed = changedPaths(top, base, head);
  const links = readLinks(top, tree, sorted);
  const { kept, dropped, stoppedAt } = plan(links.view, changed);
  const read = readPlan(top, tree, kept, changed);

  const hitsOf = (p: Planned): TaggedHit[] => {
    const moved = linkChanged(p.at, changed);
    switch (p.at.kind) {
      case 'none':
      case 'folder':
        return [];
      case 'outside':
        return [
          tagged(
            hit('config-link-outside', p.path, 1, 'link', p.at.target),
            moved ? 'new' : 'present',
          ),
        ];
      case 'unread': {
        // What is behind a link left unread is not known, changed or not: this always fails.
        const why = `a link on the way was not read: ${p.at.link}`;
        return [tagged(hit('unreadable-config', p.path, 1, 'link', why), 'new')];
      }
      case 'dangling':
        return hitsForRead(p.path, { kind: 'dangling', target: p.at.missing }).map((h) =>
          tagged(h, p.touched ? 'new' : 'present'),
        );
      case 'submodule':
        return submoduleHits(p.path, p.at, changed, moved);
      case 'blob': {
        const headRead = read.headSource(entryAt(tree, p.at.path));
        const now = hitsForRead(p.path, headRead);
        // A file not read cannot be compared with its base. It fails unless it is an instruction
        // file the change did not touch, which runs nothing and so hides nothing the change brought.
        if (headRead.kind !== 'text')
          return now.map((h) => tagged(h, !p.touched && p.tier === 2 ? 'present' : 'new'));
        if (!p.touched) return tagChanges(now, now);
        const oid = baseOid(p, changed);
        const source = oid === undefined ? undefined : read.baseSource(oid);
        return tagChanges(now, source === undefined ? [] : hitsForRead(p.path, source));
      }
    }
  };

  const found = escalateApproved(kept.flatMap(hitsOf));
  const touched = (path: string): 'new' | 'changed' | undefined => {
    const at = resolve(path, links.view);
    if (at.kind !== 'blob') return undefined;
    if (linkChanged(at, changed)) return 'changed';
    const status = changed.get(at.path)?.status;
    return status === 'A' ? 'new' : status === 'M' || status === 'T' ? 'changed' : undefined;
  };
  const touchedFiles = [...changed].flatMap(([path, c]): RunView['touchedFiles'] => {
    const entry = tree.get(path);
    if (entry === undefined || !isBlob(entry)) return [];
    if (c.status === 'A') return [[path, 'new']];
    return c.status === 'M' || c.status === 'T' ? [[path, 'changed']] : [];
  });
  const scripts = packageScripts(top, tree, changed, links.view);
  const limits = limitHits(dropped, links.cut, stoppedAt);
  const hits = [
    ...found,
    ...runFileChanges(found, { touched, touchedFiles, scripts }),
    ...limits,
    ...bareChanges(tree, changed),
  ];
  // A stable sort: each file's hits keep the order of their lines.
  const byFile = hits.sort((a, b) => byPath(a.file, b.file));
  return { base, hits: byFile, capped: limits.length > 0 || read.overBudget };
}

/** The most package.json files one check reads for the npm scripts that entries already there run. */
const MAX_PACKAGE_FILES = 64;

/** The `scripts` of a package.json's text; null when the text is not JSON. */
function scriptsIn(text: string | undefined): Readonly<Record<string, unknown>> | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(stripJsonc(text));
    if (!isPlainObject(value)) return null;
    const scripts = Object.hasOwn(value, 'scripts') ? value['scripts'] : undefined;
    return isPlainObject(scripts) ? scripts : {};
  } catch {
    return null;
  }
}

/**
 * The scripts of a package.json at the head and at the base, read when a command already there
 * runs npm: a few files, each read once, at most `MAX_PACKAGE_FILES` of them. One that cannot be
 * read, or one past that count, is `unread`, which fails.
 */
function packageScripts(
  top: string,
  tree: ReadonlyMap<string, TreeEntry>,
  changed: ReadonlyMap<string, Changed>,
  view: TreeView,
): RunView['scripts'] {
  const cache = new Map<string, PackageScripts | 'unread' | undefined>();
  const read = (path: string): PackageScripts | 'unread' | undefined => {
    const at = resolve(path, view);
    if (at.kind === 'none' || at.kind === 'folder') return undefined;
    if (at.kind !== 'blob') return 'unread';
    const entry = entryAt(tree, at.path);
    const c = changed.get(at.path);
    const old = linkChanged(at, changed)
      ? undefined
      : c === undefined
        ? entry.oid
        : c.status !== 'A' && (c.oldMode === '100644' || c.oldMode === '100755')
          ? c.oldOid
          : undefined;
    const oids = unique([entry.oid, ...(old === undefined ? [] : [old])]);
    const sizes = objectSizes(top, oids);
    if (oids.some((oid) => (sizes.get(oid) ?? MAX_FILE_BYTES + 1) > MAX_FILE_BYTES))
      return 'unread';
    const blobs = readBlobs(
      top,
      oids.map((oid) => ({ oid, size: sizes.get(oid) ?? 0 })),
    );
    const head = scriptsIn(blobs.get(entry.oid));
    if (head === null) return 'unread';
    const base = old === undefined ? null : scriptsIn(blobs.get(old));
    return { head, base: base ?? undefined };
  };
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const scripts = cache.size >= MAX_PACKAGE_FILES ? 'unread' : read(path);
    cache.set(path, scripts);
    return scripts;
  };
}

function submoduleHits(
  path: string,
  at: { readonly path: string; readonly oid: string },
  changed: ReadonlyMap<string, Changed>,
  moved: boolean,
): TaggedHit[] {
  const now = [hit('config-submodule', path, 1, 'submodule', at.oid)];
  const c = changed.get(at.path);
  if (moved || c?.status === 'A') return tagChanges(now, []);
  if (c === undefined) return tagChanges(now, now);
  const old =
    c.oldMode === GITLINK ? [hit('config-submodule', path, 1, 'submodule', c.oldOid)] : [];
  return tagChanges(now, old);
}

/** A failing entry for each limit that kept something from being read. */
function limitHits(
  dropped: readonly Planned[],
  cutLinks: readonly string[],
  stoppedAt: string | undefined,
): TaggedHit[] {
  const hits: TaggedHit[] = [];
  const first = dropped[0];
  if (first !== undefined) {
    // Even files the change did not touch: a config left out could run a file the change edits.
    const why = `${dropped.length} more agent files were not read: one check reads ${GIT_CAPS.candidates}`;
    hits.push(tagged(hit('unreadable-config', first.path, 1, 'file list', why), 'new'));
  }
  const link = cutLinks[0];
  if (link !== undefined) {
    // A link left unread hides the files behind it, changed or not: this one always fails.
    const why = `${cutLinks.length} links to agent files were not read: one check reads ${GIT_CAPS.links}`;
    hits.push(tagged(hit('unreadable-config', link, 1, 'links', why), 'new'));
  }
  if (stoppedAt !== undefined) {
    const why = `the walk through links to folders stopped here, after ${GIT_CAPS.steps} entries`;
    hits.push(tagged(hit('unreadable-config', stoppedAt, 1, 'links', why), 'new'));
  }
  return hits;
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

function bareChanges(
  tree: ReadonlyMap<string, TreeEntry>,
  changed: ReadonlyMap<string, Changed>,
): TaggedHit[] {
  const headPaths = [...tree.keys()];
  const basePaths = [
    ...headPaths.filter((p) => changed.get(p)?.status !== 'A'),
    ...[...changed].filter(([, c]) => c.status === 'D').map(([p]) => p),
  ];
  const before = new Set(bareRepositories(basePaths));
  return bareRepositories(headPaths).map((dir) =>
    tagged(
      hit('nested-bare-repo', dir, 1, 'bare repository', 'HEAD, objects, refs'),
      before.has(dir) ? 'present' : 'new',
    ),
  );
}
