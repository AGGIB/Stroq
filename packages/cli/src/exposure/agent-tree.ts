import { readdirSync, readlinkSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, posix, resolve as resolvePath, sep } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { within } from '../commands/config-file.js';
import { inSharedFolder } from './agent-change.js';
import { escalateApproved } from './agent-json.js';
import { hit, type AgentHit } from './agent-kinds.js';
import { isPackageConfig, lineHits } from './agent-lines.js';
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  SKIP_DIRS,
  hitsForRead,
  inAgentFolder,
  isAgentDir,
  isSurfacePath,
  type SourceRead,
} from './agent-surface.js';
import { linkMatters } from './git-tree.js';

/**
 * What a working tree runs by itself, read from the disk: `stroq inspect` without a base, on a
 * clone, a zip download or any folder. The walk reads the agent and editor folders first, so no
 * number of other folders can push them past its caps, and a cap that stops it fails the check.
 * It follows a link only while the link stays inside the folder.
 */

/** A repository is a working tree, not a corpus; these are generous for one. */
export const WALK_CAPS = { dirs: 20_000, files: 5_000 } as const;

export interface AgentSurface {
  readonly hits: readonly AgentHit[];
  /** True when the walk stopped at a cap, so files further on were not read. */
  readonly capped: boolean;
}

interface Candidate {
  readonly rel: string;
  /** The real path of a file to read, or the text of a link that leads out or to nothing. */
  readonly real: string;
  readonly kind: 'file' | 'outside' | 'dangling';
}

interface Dir {
  readonly abs: string;
  readonly rel: string;
  readonly real: string;
  /** The folder this one was reached from, to tell a link that loops back up. */
  readonly parent: Dir | undefined;
}

const tryRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** A file the walk reads: an agent or editor config, or the config of a package manager. */
const isWanted = (rel: string): boolean => isSurfacePath(rel) || isPackageConfig(rel);

const readlinkOrUndefined = (path: string): string | undefined => {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
};

/**
 * What to report a link out of the folder by: the text it holds, or, when it leads into a folder
 * anyone can write however it is spelled (`../../../../tmp/x`), where it leads, so that the shared
 * folder is seen. `real` is where it was found to lead, when it does lead somewhere.
 */
function outsideText(abs: string, real?: string): string {
  const text = readlinkOrUndefined(abs);
  if (text === undefined) return 'outside the repository';
  const where = posix.normalize(resolvePath(dirname(abs), text).split(sep).join('/'));
  for (const target of [where, real])
    if (target !== undefined && inSharedFolder(target)) return target;
  return text;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const entriesOf = (path: string): Dirent[] => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** How many folders on the way to `dir`, itself included, are `real`. */
function timesOnTheWay(dir: Dir | undefined, real: string): number {
  let times = 0;
  for (let at = dir; at !== undefined; at = at.parent) if (at.real === real) times += 1;
  return times;
}

/** The queues of the walk: folders inside agent and editor folders are taken first. */
class Queue {
  private readonly agent: Dir[] = [];
  private readonly other: Dir[] = [];
  /**
   * A folder reached through an agent folder is walked under each name, since its name decides
   * what reads its files; any other folder only once.
   */
  private readonly seen = new Set<string>();

  add(dir: Dir): void {
    const isAgent = inAgentFolder(dir.rel);
    const key = isAgent ? `${dir.real}\0${dir.rel.toLowerCase()}` : dir.real;
    // A link back up to a folder on the way is a loop. One inside an agent folder is walked once
    // all the same, since its name makes what is up there a skill or a rule: a host reads
    // `.claude/skills/all/SKILL.md` through `.claude/skills/all -> ../..`.
    const loops = timesOnTheWay(dir.parent, dir.real) > (isAgent ? 1 : 0);
    if (this.seen.has(key) || loops) return;
    this.seen.add(key);
    (isAgent ? this.agent : this.other).push(dir);
  }

  take(): Dir | undefined {
    return this.agent.shift() ?? this.other.shift();
  }
}

interface Walked {
  readonly found: readonly Candidate[];
  /** Where the walk stopped at a cap, or undefined when it read everything. */
  readonly stoppedAt: string | undefined;
}

/** The files the readers want, the agent folders first, until a cap stops the walk. */
function walk(root: string): Walked {
  const realRoot = tryRealpath(root) ?? root;
  const found: Candidate[] = [];
  const queue = new Queue();
  queue.add({ abs: root, rel: '', real: realRoot, parent: undefined });
  let dirs = 0;
  for (let next = queue.take(); next !== undefined; next = queue.take()) {
    dirs += 1;
    if (dirs > WALK_CAPS.dirs) return { found, stoppedAt: next.rel || '.' };
    const skip = inAgentFolder(next.rel) ? new Set<string>() : SKIP_DIRS;
    for (const entry of entriesOf(next.abs)) {
      if (entry.name === '.git' || skip.has(entry.name)) continue;
      const rel = next.rel === '' ? entry.name : `${next.rel}/${entry.name}`;
      if (found.length >= WALK_CAPS.files) return { found, stoppedAt: rel };
      const abs = join(next.abs, entry.name);
      const isLink = entry.isSymbolicLink();
      const real = isLink ? tryRealpath(abs) : join(next.real, entry.name);
      if (real === undefined) {
        const broken = isLink ? brokenLink(abs, rel, [root, realRoot]) : undefined;
        if (broken !== undefined) found.push(broken);
        continue;
      }
      if (isLink && !within(real, realRoot)) {
        if (isWanted(rel) || isAgentDir(rel))
          found.push({ rel, real: outsideText(abs, real), kind: 'outside' });
        continue;
      }
      if (isLink ? isDirectory(real) : entry.isDirectory())
        queue.add({ abs, rel, real, parent: next });
      else if (isWanted(rel)) found.push({ rel, real, kind: 'file' });
    }
  }
  return { found, stoppedAt: undefined };
}

/**
 * A link that leads to nothing, as a candidate when a host would go through it: one inside the
 * folder is reported as not read, one that leads out of it as a link out. Undefined otherwise.
 */
function brokenLink(abs: string, rel: string, roots: readonly string[]): Candidate | undefined {
  const text = readlinkOrUndefined(abs);
  if (text === undefined) return undefined;
  const where = resolvePath(dirname(abs), text);
  if (roots.some((root) => within(where, root)))
    return linkMatters(rel) || isPackageConfig(rel)
      ? { rel, real: text, kind: 'dangling' }
      : undefined;
  return isWanted(rel) || isAgentDir(rel)
    ? { rel, real: outsideText(abs), kind: 'outside' }
    : undefined;
}

/** Reads one file, charging its size to what is `left` of the budget. */
function readCandidate(candidate: Candidate, left: { bytes: number }): SourceRead {
  if (candidate.kind === 'outside') return { kind: 'outside', target: candidate.real };
  if (candidate.kind === 'dangling') return { kind: 'dangling', target: candidate.real };
  try {
    const size = statSync(candidate.real).size;
    if (size <= MAX_FILE_BYTES && size > left.bytes)
      return { kind: 'over-budget', budget: MAX_TOTAL_BYTES };
    const read = readRegularFile(candidate.real, MAX_FILE_BYTES);
    if (read.kind === 'too-large') return { kind: 'too-large', size: read.size };
    if (read.kind !== 'text') return { kind: 'unreadable' };
    left.bytes -= Buffer.byteLength(read.text);
    return { kind: 'text', text: read.text };
  } catch {
    return { kind: 'unreadable' };
  }
}

const byRel = (a: Candidate, b: Candidate): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/**
 * The hits of one file read from disk. The config of npm, yarn or bun is read line by line: each
 * line but a comment fails, by its file and line, and none of its text is shown.
 */
function hitsOfRead(rel: string, read: SourceRead): readonly AgentHit[] {
  return isPackageConfig(rel) && read.kind === 'text'
    ? lineHits(rel, read.text)
    : hitsForRead(rel, read);
}

/** What the working tree at `root` runs by itself, file by file in the order of their paths. */
export function agentSurface(root: string): AgentSurface {
  const { found, stoppedAt } = walk(root);
  const left = { bytes: MAX_TOTAL_BYTES };
  const hits = escalateApproved(
    [...found]
      .sort(byRel)
      .flatMap((candidate) => hitsOfRead(candidate.rel, readCandidate(candidate, left))),
  );
  if (stoppedAt === undefined) return { hits, capped: false };
  const why = `the walk stopped here, after ${WALK_CAPS.dirs} folders or ${WALK_CAPS.files} agent files`;
  return { hits: [...hits, hit('unreadable-config', stoppedAt, 1, 'walk', why)], capped: true };
}
