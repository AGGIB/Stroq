// Every session the readers can find on this machine, and the files that make each one up.
//
// A Claude Code session is its transcript, its subagents' transcripts and its saved large
// outputs. A Codex session is one rollout. A Cursor session is a set of rows in one SQLite
// store, read whole here because the store is small and holds every session at once.
// Nothing is parsed beyond the first records of each file: the folder a session ran in and
// when it started (`head.ts`).
import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Transcript } from '../replay/transcript.js';
import { codexRoot, everyRollout, rolloutMeta } from './codex.js';
import { headRecords } from './head.js';
import {
  cursorSessionPath,
  cursorStateDb,
  cursorUnavailable,
  parseCursorStore,
  storeRows,
} from './cursor.js';

export type Agent = 'claude-code' | 'codex' | 'cursor';

export interface SessionRef {
  readonly agent: Agent;
  /** The main transcript, the rollout, or `<store>#<session>`. */
  readonly path: string;
  /** Every file the session is made of, for the fast pass. Empty for Cursor. */
  readonly files: readonly string[];
  /** The folder it ran in, as its first records say. */
  readonly cwd: string | null;
  /**
   * Claude Code: the name of the folder it is filed under in `~/.claude/projects`, which is
   * the folder it ran in written as a slug. For a session whose records name no folder.
   */
  readonly project?: string;
  /** The first time recorded in it. */
  readonly first: string | null;
  readonly mtimeMs: number;
  /** A Cursor session, already read, and its rows as stored. */
  readonly cursor?: { readonly transcript: Transcript; readonly rows: readonly string[] };
}

export interface MachineSessions {
  readonly sessions: readonly SessionRef[];
  /** Why Cursor's sessions could not be read, or null. */
  readonly cursorUnavailable: string | null;
}

async function filesIn(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && keep(e.name))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** The first `cwd` and `timestamp` in the records at the start of a transcript. */
export async function transcriptHead(
  path: string,
): Promise<{ cwd: string | null; first: string | null }> {
  const head: { cwd: string | null; first: string | null } = { cwd: null, first: null };
  await headRecords(path, (r) => {
    if (head.cwd === null && typeof r['cwd'] === 'string') head.cwd = r['cwd'];
    if (head.first === null && typeof r['timestamp'] === 'string') head.first = r['timestamp'];
    return head.cwd !== null && head.first !== null;
  });
  return { cwd: head.cwd, first: head.first };
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** One Claude Code session: its transcript, subagent transcripts and saved outputs. */
export async function claudeSession(main: string): Promise<SessionRef> {
  const stem = main.slice(0, -'.jsonl'.length);
  const files = [
    main,
    ...(await filesIn(join(stem, 'subagents'), (n) => n.endsWith('.jsonl'))),
    ...(await filesIn(join(stem, 'tool-results'), () => true)),
  ];
  const head = await transcriptHead(main);
  return {
    agent: 'claude-code',
    path: main,
    files,
    ...head,
    project: basename(dirname(main)),
    mtimeMs: await mtimeOf(main),
  };
}

/**
 * The folders Claude Code may keep its sessions in: the one `CLAUDE_CONFIG_DIR` names, then
 * `~/.claude` and `~/.config/claude`, each read once however it is reached.
 */
export function claudeRoots(
  home: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string[] {
  const named = env['CLAUDE_CONFIG_DIR'];
  const dirs = [
    ...(named === undefined || named === '' ? [] : [named]),
    join(home, '.claude'),
    join(home, '.config', 'claude'),
  ];
  const seen = new Set<string>();
  return dirs
    .map((dir) => join(dir, 'projects'))
    .filter((root) => {
      let real: string;
      try {
        real = realpathSync(root);
      } catch {
        return false;
      }
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    });
}

/** Whether a folder entry is a folder, or a link to one. */
async function isFolder(path: string, linked: boolean): Promise<boolean> {
  if (!linked) return true;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function claudeSessions(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  for (const root of claudeRoots(home, env)) {
    let projects: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const folders: string[] = [];
      for (const d of entries)
        if (
          (d.isDirectory() || d.isSymbolicLink()) &&
          (await isFolder(join(root, d.name), d.isSymbolicLink()))
        )
          folders.push(join(root, d.name));
      projects = folders.sort();
    } catch {
      continue;
    }
    for (const project of projects)
      for (const main of await filesIn(project, (n) => n.endsWith('.jsonl')))
        out.push(await claudeSession(main));
  }
  return out;
}

/** One Codex rollout. */
export async function codexSession(path: string): Promise<SessionRef> {
  const meta = await rolloutMeta(path);
  return {
    agent: 'codex',
    path,
    files: [path],
    cwd: meta.cwd,
    first: meta.at,
    mtimeMs: await mtimeOf(path),
  };
}

async function codexSessions(home: string): Promise<SessionRef[]> {
  const out: SessionRef[] = [];
  for (const file of await everyRollout(codexRoot(home))) out.push(await codexSession(file.path));
  return out;
}

/** Every Cursor session in the store, or only `only`, with its rows as stored. */
export async function cursorSessions(
  db: string,
  only: string | null = null,
): Promise<SessionRef[]> {
  const rows = await storeRows(db, only);
  const raw = new Map<string, string[]>();
  for (const row of rows) {
    const id = row.key.split(':')[1] ?? '';
    // Appended in place: copying the list for every row would cost the square of its length.
    const rows = raw.get(id);
    if (rows === undefined) raw.set(id, [row.value]);
    else rows.push(row.value);
  }
  return parseCursorStore(rows).map((s) => {
    const firstAt = s.transcript.events
      .map((e) => e.at)
      .find((at) => !Number.isNaN(Date.parse(at)));
    return {
      agent: 'cursor',
      path: cursorSessionPath(db, s.id),
      files: [],
      cwd: s.transcript.cwd,
      first: firstAt ?? null,
      mtimeMs: s.mtimeMs,
      cursor: { transcript: s.transcript, rows: raw.get(s.id) ?? [] },
    };
  });
}

/** Every session the readers can find under `home`, and where `CLAUDE_CONFIG_DIR` points. */
export async function machineSessions(
  home: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<MachineSessions> {
  const unavailable = await cursorUnavailable();
  const cursor =
    unavailable === null
      ? await cursorSessions(cursorStateDb(process.platform, process.env, home))
      : [];
  return {
    sessions: [...(await claudeSessions(home, env)), ...(await codexSessions(home)), ...cursor],
    cursorUnavailable: unavailable,
  };
}
