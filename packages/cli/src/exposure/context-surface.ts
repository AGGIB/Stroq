import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { samePath } from '../replay/transcript.js';
import { loadBundledRules, readRegularFile, scanContent } from '@stroq/core';
import { isStroqHandler, readSettings, settingsPath } from '../commands/init.js';
import type { Finding } from './findings.js';

/**
 * A real machine can carry thousands of these — 4,824 were measured on the author's
 * on 2026-09-13 — and `exposure` must stay fast enough to run casually, so discovery
 * is bounded rather than exhaustive. The report states the cap when it is reached.
 */
export const MAX_CONTEXT_FILES = 5_000;
/** Files larger than this are counted but not scanned; instruction files are small. */
const MAX_SCAN_BYTES = 256 * 1024;

export interface ContextSurface {
  readonly instructionFiles: number;
  readonly skills: number;
  readonly subagents: number;
  readonly commands: number;
  readonly bytes: number;
  /** Paths of files that tripped at least one rule. See `contextFindings` for the caveat. */
  readonly flagged: readonly string[];
  /**
   * The sha256 of every file read, by absolute path, so the next run can name what
   * appeared or changed since: a swapped skill is the same file name with new text.
   */
  readonly digests: Readonly<Record<string, string>>;
  /** Non-Stroq hook handlers configured for Claude Code: arbitrary code on every tool call. */
  readonly foreignHooks: number;
  /** True when discovery stopped at `MAX_CONTEXT_FILES`, so every count is a lower bound. */
  readonly capped: boolean;
}

/** Files directly under `.claude` that Claude Code loads or runs from, besides directories. */
const CLAUDE_STATE_FILES = ['scheduled_tasks.json', 'loop.md'] as const;

const INSTRUCTION_NAMES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
] as const;

/**
 * Collects absolute paths, never the same one twice. The project directory IS the home
 * directory often enough (a dotfiles repo, `cd ~`) that without this every user-scope
 * file would be counted a second time and every finding would double.
 */
class FileSet {
  private readonly seen = new Set<string>();
  readonly paths: string[] = [];
  /** True when a walk stopped at its directory budget, so what was found is a lower bound. */
  exhausted = false;

  add(path: string): void {
    if (this.seen.has(path) || this.full) return;
    this.seen.add(path);
    this.paths.push(path);
  }

  get full(): boolean {
    return this.seen.size >= MAX_CONTEXT_FILES;
  }

  get size(): number {
    return this.paths.length;
  }
}

/** Directories nested deeper than this are not searched: no instruction tree is this deep. */
const MAX_WALK_DEPTH = 12;
/**
 * Directories read by one walk. A repository can commit a symlink to a directory it does not
 * own; followed with no budget, a link to a filesystem root walked it for minutes (92 s
 * measured for `/System`) before the file cap was reached. The budget is per walk, and
 * the user's own directories get a large one (a plugin cache holds thousands) while a
 * repository's get a small one, so a repository cannot spend what the user's own skills need.
 */
const MAX_REPO_WALK_DIRS = 2_000;
const MAX_HOME_WALK_DIRS = 20_000;
/** Never searched: neither holds a skill or an instruction file, and both hold a great many directories. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * Every file under `dir` for which `match` holds, into `out`.
 *
 * A directory is walked once, by its real path: a repository can commit a symlink that
 * points back at its own directory, and with two of them each level doubled the walk
 * until `exposure` did not come back. A symlink to a directory elsewhere is still
 * followed, once, because people do share a skills directory that way.
 */
/** `path` with symlinks resolved as far as it exists, or as it was. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function walk(
  dir: string,
  match: (name: string) => boolean,
  out: FileSet,
  dirsLeft: number,
  visited: Set<string> = new Set(),
  depth = 0,
): void {
  const budget = { left: dirsLeft };
  walkTree(dir, match, out, budget, visited, depth);
}

function walkTree(
  dir: string,
  match: (name: string) => boolean,
  out: FileSet,
  budget: { left: number },
  visited: Set<string>,
  depth: number,
): void {
  if (out.full || depth > MAX_WALK_DEPTH || !existsSync(dir)) return;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);
  if (budget.left <= 0) {
    out.exhausted = true;
    return;
  }
  budget.left -= 1;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.full) return;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!SKIPPED_DIRS.has(name)) walkTree(full, match, out, budget, visited, depth + 1);
    } else if (match(name)) out.add(full);
  }
}

function countForeignHooks(cwd: string): number {
  let count = 0;
  const seen = new Set<string>();
  for (const scope of ['project', 'user'] as const) {
    const file = settingsPath(scope, cwd);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      for (const group of Object.values(readSettings(file).hooks ?? {}).flat()) {
        if (!Array.isArray(group.hooks)) continue;
        count += group.hooks.filter((h) => !isStroqHandler(h)).length;
      }
    } catch {
      continue;
    }
  }
  return count;
}

const isMarkdown = (name: string): boolean => name.endsWith('.md');

/** The directories directly inside `dir`, or none when it cannot be read. */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

export function contextSurface(cwd: string, home: string = homedir()): ContextSurface {
  // The user's own folders get the large budget, a repository's the small one. A project
  // that IS the home directory (a dotfiles repository) is the user's.
  const dirsFor = (base: string): number =>
    samePath(resolve(base), resolve(home)) || samePath(realOrSelf(base), realOrSelf(home))
      ? MAX_HOME_WALK_DIRS
      : MAX_REPO_WALK_DIRS;
  const skills = new FileSet();
  walk(join(home, '.claude', 'skills'), isMarkdown, skills, dirsFor(home));
  walk(join(cwd, '.claude', 'skills'), isMarkdown, skills, dirsFor(cwd));
  walk(join(home, '.claude', 'plugins'), (n) => n === 'SKILL.md', skills, dirsFor(home));

  const subagents = new FileSet();
  walk(join(home, '.claude', 'agents'), isMarkdown, subagents, dirsFor(home));
  walk(join(cwd, '.claude', 'agents'), isMarkdown, subagents, dirsFor(cwd));

  const commands = new FileSet();
  walk(join(home, '.claude', 'commands'), isMarkdown, commands, dirsFor(home));
  walk(join(cwd, '.claude', 'commands'), isMarkdown, commands, dirsFor(cwd));

  const instruction = new FileSet();
  for (const base of [cwd, home])
    for (const name of INSTRUCTION_NAMES) {
      const full = join(base, name);
      if (existsSync(full)) instruction.add(full);
    }
  // The user-level CLAUDE.md, and the memory Claude Code keeps per project: both are
  // loaded into every session like the files above, and both are where a poisoned
  // session would save an instruction for the next one.
  const userClaude = join(home, '.claude', 'CLAUDE.md');
  if (existsSync(userClaude)) instruction.add(userClaude);
  // Rules, output styles and Copilot's per-path instructions: loaded into every session
  // by the host, so a poisoned one persists exactly as a poisoned CLAUDE.md does.
  for (const base of [cwd, home]) {
    walk(join(base, '.claude', 'rules'), isMarkdown, instruction, dirsFor(base));
    walk(join(base, '.claude', 'output-styles'), isMarkdown, instruction, dirsFor(base));
    // A subagent's own memory, and the two files Claude Code reads its loop and its
    // scheduled tasks from: on the guard's list, so on the inventory too.
    walk(join(base, '.claude', 'agent-memory'), isMarkdown, instruction, dirsFor(base));
    walk(join(base, '.claude', 'agent-memory-local'), isMarkdown, instruction, dirsFor(base));
    for (const name of CLAUDE_STATE_FILES) {
      const file = join(base, '.claude', name);
      if (existsSync(file)) instruction.add(file);
    }
  }
  walk(join(cwd, '.github', 'instructions'), isMarkdown, instruction, dirsFor(cwd));
  for (const project of subdirectories(join(home, '.claude', 'projects')))
    walk(join(project, 'memory'), isMarkdown, instruction, dirsFor(home));

  const rules = loadBundledRules();
  const flagged: string[] = [];
  const digests: Record<string, string> = {};
  let bytes = 0;
  for (const file of [
    ...skills.paths,
    ...subagents.paths,
    ...commands.paths,
    ...instruction.paths,
  ]) {
    let text: string;
    try {
      // Found by name, so any of these can be a symlink to `/dev/zero` or a FIFO that a
      // repository or an agent put there; only a regular file is read.
      const read = readRegularFile(file, MAX_SCAN_BYTES);
      if (read.kind === 'not-regular') continue;
      bytes += read.size;
      if (read.kind === 'too-large') continue;
      text = read.text;
    } catch {
      continue;
    }
    digests[file] = createHash('sha256').update(text).digest('hex');
    // Every file walked above is an instruction file, a skill, a subagent or a slash
    // command: text the agent is meant to obey, not repository material.
    if (scanContent(rules, text, {}, { target: 'instruction_file' }).verdict === 'suspect')
      flagged.push(file);
  }

  return {
    instructionFiles: instruction.size,
    skills: skills.size,
    subagents: subagents.size,
    commands: commands.size,
    bytes,
    flagged,
    digests,
    foreignHooks: countForeignHooks(cwd),
    capped:
      skills.full ||
      subagents.full ||
      commands.full ||
      instruction.full ||
      skills.exhausted ||
      subagents.exhausted ||
      commands.exhausted ||
      instruction.exhausted,
  };
}

export function contextFindings(surface: ContextSurface): readonly Finding[] {
  const findings: Finding[] = [];
  if (surface.flagged.length > 0) {
    findings.push({
      class: 'context-flagged',
      severity: 'medium',
      detail:
        `${surface.flagged.length} of the instruction files this agent reads trip a content rule. ` +
        `Expect false positives: documentation that discusses credentials, prompts or shell ` +
        `commands matches the same rules as an attack, and rules are not yet scoped to the ` +
        `surface they were written for. Review with --verbose rather than acting on the count.`,
      fix: null,
    });
  }
  if (surface.foreignHooks > 0) {
    findings.push({
      class: 'hook-foreign',
      severity: 'high',
      detail: `${surface.foreignHooks} non-Stroq hook handler(s) are configured for Claude Code; each runs arbitrary code on every matching tool call`,
      fix: null,
    });
  }
  return findings;
}
