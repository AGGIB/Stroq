// Reading a coding agent's own session transcript, so `stroq replay` can answer
// for sessions that happened BEFORE Stroq was installed.
//
// Claude Code writes every session to `~/.claude/projects/<slug>/<id>.jsonl`, and
// those records carry both halves of what the hooks would have seen: an assistant
// message's `tool_use` block is the call, and the matching user message's
// `tool_result` block is the output that came back. Replaying those through the
// engine reconstructs the same causal graph the live hooks would have produced.
//
// Nothing here writes to the user's real `~/.stroq`: the caller runs these events
// against a throwaway home, exactly as `stroq attack` does.
import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readClaudeSession } from './claude-session.js';
import type { Transcript } from './transcript-parse.js';

export {
  createTranscriptParser,
  feedLines,
  parseTranscript,
  type LineParser,
  type ParserOptions,
  type Transcript,
  type TranscriptEvent,
  type TranscriptPost,
  type TranscriptPre,
  type TranscriptSink,
  type TranscriptText,
} from './transcript-parse.js';

/**
 * Claude Code's transcript directory for a working directory, by its own slug rule:
 * every character that is not an ASCII letter or digit becomes `-` — a space, an
 * underscore, a non-ASCII letter, and on Windows the drive colon and backslashes.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where Claude Code keeps its sessions: under `CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`. */
export const transcriptRoot = (): string => {
  const named = process.env['CLAUDE_CONFIG_DIR'];
  return join(named === undefined || named === '' ? join(homedir(), '.claude') : named, 'projects');
};

export interface TranscriptFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * `dir` and each folder above it, nearest first: the folders a session for `dir`'s project
 * may have been started in. Not the user's home directory or anything above it when `dir`
 * is inside it (a session started in `~` is not any project's), and not the filesystem root.
 */
export function directoryAndParents(dir: string, home: string = homedir()): string[] {
  const start = resolve(dir);
  const homeDir = resolve(home);
  const homeReal = realOrSelf(homeDir);
  // The same folder however it is spelled: through a symlink, or in another case on Windows.
  const sameFolder = (a: string, b: string): boolean =>
    samePath(a, b) || samePath(realOrSelf(a), realOrSelf(b));
  const inside = (child: string, root: string): boolean => {
    const from = relative(root, child);
    return from !== '' && !from.startsWith('..') && !isAbsolute(from);
  };
  const insideHome = inside(start, homeDir) || inside(realOrSelf(start), homeReal);
  const out: string[] = [];
  let current = start;
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current || parent === dirname(parent)) return out;
    if (insideHome && sameFolder(parent, homeDir)) return out;
    if (!insideHome && sameFolder(current, homeDir)) return out;
    current = parent;
  }
}

/** `path` with symlinks resolved as far as it exists, or as it was. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether two paths are the same, which on Windows is not a question of case. */
export const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Sessions found for a directory, newest first, and whether they are its own. */
export interface SessionList {
  readonly files: readonly TranscriptFile[];
  /** False when nothing was recorded for the directory and this is every session. */
  readonly scoped: boolean;
  /**
   * How many folders above the directory the sessions were found: 0 for its own. A reader
   * with sessions nearer the directory outranks one with newer sessions further up.
   */
  readonly depth: number;
}

/**
 * Transcripts for `cwd`, newest first. Falls back to every project when this
 * directory has none, so `--last` still finds something to show.
 */
export async function findTranscripts(cwd: string): Promise<TranscriptFile[]> {
  return [...(await findTranscriptsScoped(cwd)).files];
}

/**
 * `findTranscripts`, and whether the list is this directory's own (`scoped`) or the
 * fallback over every project. A caller that reports HOW MANY sessions the project has
 * needs to know which, or it counts other projects' sessions as the project's.
 */
export async function findTranscriptsScoped(cwd: string): Promise<SessionList> {
  const root = transcriptRoot();
  // This directory's own sessions, else those of the nearest folder above it that has any:
  // an agent started at the project's root and a command typed in one of its subfolders are
  // the same project, and the sessions of the folder above are the ones to read.
  const folders = directoryAndParents(cwd);
  for (const [depth, dir] of folders.entries()) {
    const found = (await listJsonl(join(root, projectSlug(dir)))) ?? [];
    if (found.length > 0)
      return { files: found.sort((a, b) => b.mtimeMs - a.mtimeMs), scoped: true, depth };
  }

  return { files: await listAllTranscripts(), scoped: false, depth: 0 };
}

/** Every Claude Code session on this machine, of every project, newest first. */
export async function listAllTranscripts(): Promise<TranscriptFile[]> {
  const root = transcriptRoot();
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
  const all: TranscriptFile[] = [];
  for (const dir of dirs) all.push(...((await listJsonl(dir)) ?? []));
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listJsonl(dir: string): Promise<TranscriptFile[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // A transcript deleted between readdir and stat is simply not listed.
    }
  }
  return files;
}

/**
 * A Claude Code session: its main transcript, its subagents' transcripts and the large outputs
 * it saved to files (see `claude-session.ts`).
 */
export async function readTranscript(path: string): Promise<Transcript> {
  return readClaudeSession(path);
}
