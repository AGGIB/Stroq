// The sessions of the last N days that agents keep on this machine, newest first.
// For transcript files, read the head only when the file date is inside the window.
import { lstatSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { codexRoot, everyRollout } from '../sent/codex.js';
import { cursorStateDb } from '../sent/cursor.js';
import { claudeRoots, claudeSession, codexSession, type SessionRef } from '../sent/sessions.js';
import { MAX_TRANSCRIPT_BYTES } from '../replay/past.js';
import type { CardAgent } from './schema.js';
import { listCursorWindow } from './cursor-window.js';

const DAY_MS = 86_400_000;

/** The start of a window of `days` days that ends at `now`, in milliseconds since 1970. */
export const windowStart = (days: number, now: Date): number => now.getTime() - days * DAY_MS;

export interface WindowSession {
  readonly agent: CardAgent;
  readonly path: string;
  readonly cwd: string | null;
  readonly mtimeMs: number;
  /** Bytes of the transcript files or the Cursor session's rows. */
  readonly bytes: number;
  readonly cursorStamp?: string;
  /** The session as `stroq sent` reads it. */
  readonly ref: SessionRef;
}

export interface WindowListing {
  /** In the window, newest first. */
  readonly sessions: readonly WindowSession[];
  /** Sessions the agents keep that are older than the window. */
  readonly older: number;
  /** Where the agents keep them, for the sentence that says nothing was found. */
  readonly looked: readonly string[];
  readonly cursorNote?: string;
}

/** The size of a regular file, or null for a link, a pipe or a file that is gone. */
function regularBytes(path: string): number | null {
  try {
    const info = lstatSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** Claude Code's main transcripts, with their dates. */
async function claudeMains(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  for (const root of claudeRoots(home, env)) {
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const project of projects) {
      const dir = join(root, project.name);
      if (!project.isDirectory() && !(project.isSymbolicLink() && isFolder(dir))) continue;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        try {
          const info = lstatSync(path);
          if (info.isFile()) out.push({ path, mtimeMs: info.mtimeMs });
        } catch {
          // Deleted between the listing and the look: not listed.
        }
      }
    }
  }
  return out;
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Every file of a session that is a transcript (not a saved tool output), summed. */
function sessionBytes(ref: SessionRef): number {
  return ref.files
    .filter((file) => file.endsWith('.jsonl'))
    .reduce((sum, file) => sum + (regularBytes(file) ?? 0), 0);
}

/** A transcript past the size the card replays (see `MAX_TRANSCRIPT_BYTES`). */
export const isTooLarge = (session: Pick<WindowSession, 'bytes'>): boolean =>
  session.bytes > MAX_TRANSCRIPT_BYTES;

/** Where Claude Code's sessions are looked for first: `CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`. */
function lookedForClaude(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const named = env['CLAUDE_CONFIG_DIR'];
  return join(named === undefined || named === '' ? join(home, '.claude') : named, 'projects');
}

export async function listWindow(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  days: number,
  now: Date,
  stopAt = Infinity,
): Promise<WindowListing> {
  const cutoff = windowStart(days, now);
  const claude = await claudeMains(home, env);
  const codex = await everyRollout(codexRoot(home));
  const inside = (m: { mtimeMs: number }): boolean => m.mtimeMs >= cutoff;
  const sessions: WindowSession[] = [];
  for (const main of claude.filter(inside)) {
    const ref = await claudeSession(main.path);
    sessions.push({
      agent: 'claude-code',
      path: main.path,
      cwd: ref.cwd,
      mtimeMs: main.mtimeMs,
      bytes: sessionBytes(ref),
      ref,
    });
  }
  for (const rollout of codex.filter(inside)) {
    if (regularBytes(rollout.path) === null) continue;
    const ref = await codexSession(rollout.path);
    sessions.push({
      agent: 'codex',
      path: rollout.path,
      cwd: ref.cwd,
      mtimeMs: rollout.mtimeMs,
      bytes: sessionBytes(ref),
      ref,
    });
  }
  const cursorDb = cursorStateDb(process.platform, env, home);
  const cursor = await listCursorWindow(cursorDb, cutoff, stopAt);
  const older = claude.length + codex.length - sessions.length + cursor.older;
  sessions.push(...cursor.sessions);
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  return {
    sessions,
    older,
    looked: [lookedForClaude(home, env), codexRoot(home), cursorDb],
    ...(cursor.note === undefined ? {} : { cursorNote: cursor.note }),
  };
}
