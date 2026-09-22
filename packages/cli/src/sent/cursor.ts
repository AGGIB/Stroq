// Reading Cursor's recorded sessions, so `stroq sent` can answer for the agent it
// could not answer for before.
//
// Cursor keeps no transcript files. Every session lives in one SQLite store,
// `…/User/globalStorage/state.vscdb`, in a key-value table named `cursorDiskKV`
// whose `bubbleId:<session>:<bubble>` rows are the conversation. That is a
// different shape from the other two readers — a store of sessions rather than a
// directory of files — and it is the reason `TranscriptReader.read` is given a
// `<store>#<session>` path here rather than a filename.
//
// Written against this machine's own store: 9 sessions, 1,761 bubbles, 1,126 tool
// calls, none of them fixtures. Every record parsed (0 unreadable), and so did every
// `params` (1,037 of 1,037) and every `result` (962 of 962) — unlike Codex, where
// 82% of tool arguments are JavaScript rather than JSON, Cursor writes plain JSON
// throughout, which is why this reader needs no parser of its own.
//
// What the survey changed about the obvious design:
//
//   - `params.cwd` is present and EMPTY on all 216 terminal calls, so it cannot say
//     which directory a session ran in. Neither can anything else in the store: there
//     is no workspace record, and the `Workspace Path:` line that does appear in the
//     model-message blobs is content-addressed with no link back to a session. What a
//     session touched is therefore read from the absolute paths in its own tool
//     arguments, and `find` matches a directory against those.
//   - An MCP call's label collapses server and tool with a `-`, and a server name may
//     contain `-` itself (`project-0-smart-smm-flutter-supabase` in the measured
//     store), so the label cannot be split back into the pair. `params.tools[0]`
//     states both, and that is what the name is composed from.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { isRecord, toolInputRecord } from '../adapters/tool-input.js';
import type { Transcript, TranscriptEvent, TranscriptFile } from '../replay/transcript.js';

/** One `cursorDiskKV` row, as the store holds it. */
export interface CursorRow {
  readonly key: string;
  readonly value: string;
}

export interface CursorSession {
  /** Cursor's own composer id, which is the session id the report prints. */
  readonly id: string;
  /** The newest moment any bubble in this session was written. */
  readonly mtimeMs: number;
  /** Absolute paths this session's tool calls named, deduped in the order seen. */
  readonly roots: readonly string[];
  readonly transcript: Transcript;
}

/**
 * Cursor's tool names, mapped to the ones the live hook reports for the same action,
 * so a session read back off disk classifies the way it would have classified live.
 * A tool absent from this table keeps its own name: the live hook installs on six
 * events and never sees `ripgrep_raw_search` or `glob_file_search` at all, and
 * inventing a mapping for one would be a claim about a classification nobody made.
 */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  run_terminal_command_v2: 'Bash',
  run_terminal_command: 'Bash',
  read_file_v2: 'Read',
  read_file: 'Read',
  edit_file_v2: 'Write',
  edit_file: 'Write',
  search_replace: 'Write',
  create_file: 'Write',
  delete_file: 'Write',
};

/** Argument fields that hold an absolute path, in the order the survey found them. */
const PATH_FIELDS = ['targetFile', 'effectiveUri', 'path', 'targetDirectory', 'absolutePath'];

/** Result fields that hold the text a tool actually returned. */
const RESULT_FIELDS = ['output', 'contents', 'result'];

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The MCP server and tool a call states, or null when this is not an MCP call. */
function mcpPair(params: unknown): { server: string; tool: string; args: unknown } | null {
  if (!isRecord(params)) return null;
  const tools = params['tools'];
  if (!Array.isArray(tools)) return null;
  const first: unknown = tools[0];
  if (!isRecord(first)) return null;
  const tool = first['name'];
  const server = first['serverName'];
  if (typeof tool !== 'string' || typeof server !== 'string') return null;
  return { server, tool, args: first['parameters'] };
}

interface Call {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly paths: readonly string[];
}

function callOf(name: string, params: unknown): Call {
  const mcp = mcpPair(params);
  if (mcp !== null) {
    return {
      tool: mcpToolName(mcp.server, mcp.tool),
      input: toolInputRecord(mcp.args),
      paths: [],
    };
  }
  const record = isRecord(params) ? params : {};
  const paths = PATH_FIELDS.map((field) => record[field]).filter(
    (value): value is string => typeof value === 'string' && value.startsWith('/'),
  );
  const mapped = TOOL_NAMES[name] ?? name;
  if (mapped === 'Bash') {
    const command = record['command'];
    return { tool: mapped, input: { command: typeof command === 'string' ? command : '' }, paths };
  }
  if (mapped === 'Read' || mapped === 'Write') {
    // `relativeWorkspacePath` is what every measured edit carries — there is no
    // absolute path to report for one, and inventing it by joining a guessed
    // workspace root would put a path in the report that the record never held.
    const file =
      record['targetFile'] ?? record['relativeWorkspacePath'] ?? record['path'] ?? record['uri'];
    return {
      tool: mapped,
      input: { file_path: typeof file === 'string' ? file : '' },
      paths,
    };
  }
  return { tool: mapped, input: record, paths };
}

/**
 * The text a tool returned. A recognised field is taken parsed, so the result reads
 * as the bytes the agent saw rather than as an escaped JSON string; anything else is
 * kept verbatim, because a scan of it still sees every character either way.
 */
function resultTextOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const parsed = parseJson(raw);
  if (isRecord(parsed)) {
    for (const field of RESULT_FIELDS) {
      const value = parsed[field];
      if (typeof value === 'string') return value;
    }
  }
  return raw;
}

/**
 * Every session in a set of `cursorDiskKV` rows, newest first.
 *
 * Rows for other prefixes are ignored, so the caller may hand over the whole table.
 */
export function parseCursorStore(rows: Iterable<CursorRow>): CursorSession[] {
  const bySession = new Map<
    string,
    { events: TranscriptEvent[]; roots: string[]; latest: number; skipped: number }
  >();

  for (const row of rows) {
    const parts = row.key.split(':');
    if (parts.length < 3 || parts[0] !== 'bubbleId') continue;
    const id = parts[1] ?? '';
    if (id === '') continue;
    let session = bySession.get(id);
    if (session === undefined) {
      session = { events: [], roots: [], latest: 0, skipped: 0 };
      bySession.set(id, session);
    }

    const bubble = parseJson(row.value);
    if (!isRecord(bubble)) {
      session.skipped += 1;
      continue;
    }
    const at = typeof bubble['createdAt'] === 'string' ? bubble['createdAt'] : '';
    const moment = Date.parse(at);
    if (Number.isFinite(moment)) session.latest = Math.max(session.latest, moment);

    const former = bubble['toolFormerData'];
    if (!isRecord(former)) continue;
    const name = typeof former['name'] === 'string' ? former['name'] : '';
    if (name === '') continue;

    const call = callOf(name, parseJson(former['params']));
    for (const path of call.paths) if (!session.roots.includes(path)) session.roots.push(path);

    const callId =
      typeof former['toolCallId'] === 'string' && former['toolCallId'] !== ''
        ? former['toolCallId']
        : (parts.slice(2).join(':') ?? '');
    session.events.push({ kind: 'pre', id: callId, tool: call.tool, input: call.input, at });

    const text = resultTextOf(former['result']);
    if (text === null) continue;
    session.events.push({
      kind: 'post',
      id: callId,
      tool: call.tool,
      input: call.input,
      resultText: text,
      at,
    });
  }

  return [...bySession.entries()]
    .map(([id, s]) => ({
      id,
      mtimeMs: s.latest,
      roots: s.roots,
      transcript: {
        sessionId: id,
        cwd: s.roots[0] ?? null,
        events: s.events,
        skipped: s.skipped,
      } satisfies Transcript,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Cursor's global store. `plat`/`env`/`home` default to the real process and are
 * overridable for the same reason `claudeDesktopPath` makes them overridable: a test
 * can exercise one platform branch without touching the real one.
 */
export function cursorStateDb(
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const base =
    plat === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Cursor')
      : plat === 'win32'
        ? join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Cursor')
        : join(home, '.config', 'Cursor');
  return join(base, 'User', 'globalStorage', 'state.vscdb');
}

/**
 * A session's address, as `<store>#<session>`.
 *
 * `#` is not a path character Cursor's own ids or install paths use, and the split
 * takes the LAST one so a store under a directory containing `#` still resolves.
 */
export const cursorSessionPath = (db: string, session: string): string => `${db}#${session}`;

export function splitCursorSessionPath(path: string): { db: string; session: string | null } {
  const hash = path.lastIndexOf('#');
  if (hash <= 0) return { db: path, session: null };
  return { db: path.slice(0, hash), session: path.slice(hash + 1) };
}

/**
 * `node:sqlite`, or null on a Node that does not have it.
 *
 * It is imported lazily and never at module load, because `engines` allows Node 22
 * and the module is not there across the whole of that range: on 22.11.0 the import
 * fails outright with `ERR_UNKNOWN_BUILTIN_MODULE`, and it resolves on 22.23.2 and
 * 24. A reader that threw at import would take the other two readers down with it.
 *
 * The `ExperimentalWarning` the module prints on load is swallowed for the duration
 * of the import, and only that one: `stroq sent` prints a security report, and a
 * Node-internal warning on its stderr reads as the report failing.
 */
let sqlitePromise: Promise<typeof import('node:sqlite') | null> | null = null;

async function sqlite(): Promise<typeof import('node:sqlite') | null> {
  sqlitePromise ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
      const name = typeof warning === 'string' ? String(rest[0] ?? '') : warning.name;
      const text = typeof warning === 'string' ? warning : warning.message;
      if (name === 'ExperimentalWarning' && text.includes('SQLite')) return;
      (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } catch {
      return null;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return sqlitePromise;
}

/**
 * Why this Node cannot read Cursor sessions, or null when it can.
 *
 * Surfaced rather than swallowed: a reader that quietly finds nothing is
 * indistinguishable from a session that was clean, which is the mistake
 * `readerForFile` is written to avoid on the other side of the same command.
 */
export async function cursorUnavailable(): Promise<string | null> {
  if ((await sqlite()) !== null) return null;
  return `Cursor sessions need node:sqlite, which ${process.version} does not have — Node 22.23 or newer reads them`;
}

/**
 * Rows from the store, read-only and never held longer than the parse.
 *
 * `readOnly` is not a precaution about intent but about the file: this is the
 * user's live Cursor store, and opening it for writing would create a `-wal`
 * beside it and take a lock the running editor is entitled to.
 */
async function storeRows(db: string, session: string | null): Promise<CursorRow[]> {
  const mod = await sqlite();
  if (mod === null) return [];
  let handle;
  try {
    handle = new mod.DatabaseSync(db, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const like = session === null ? 'bubbleId:%' : `bubbleId:${session}:%`;
    const rows = handle.prepare('select key, value from cursorDiskKV where key like ?').all(like);
    return rows.flatMap((row) => {
      const { key, value } = row as { key?: unknown; value?: unknown };
      return typeof key === 'string' && typeof value === 'string' ? [{ key, value }] : [];
    });
  } catch {
    // A store whose schema has moved on is not an error to report at people: the
    // command says it found no Cursor session, which is true.
    return [];
  } finally {
    handle.close();
  }
}

/** Whether `path` is `dir` itself or lies under it, on a boundary rather than a prefix. */
function isUnder(path: string, dir: string): boolean {
  if (dir === '') return false;
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Cursor sessions that touched `cwd`, newest first, falling back to every session
 * when this directory has none — the same contract, and the same fallback, as the
 * other two readers, so `--last` behaves identically whichever agent recorded the
 * session.
 */
export async function findCursorSessions(cwd: string, db?: string): Promise<TranscriptFile[]> {
  const store = db ?? cursorStateDb();
  const sessions = parseCursorStore(await storeRows(store, null));
  const files = (list: readonly CursorSession[]): TranscriptFile[] =>
    list.map((s) => ({ path: cursorSessionPath(store, s.id), mtimeMs: s.mtimeMs }));
  const here = sessions.filter((s) => s.roots.some((root) => isUnder(root, cwd)));
  return here.length > 0 ? files(here) : files(sessions);
}

/** One session out of a store, or the newest one when the path names no session. */
export async function readCursorSession(path: string): Promise<Transcript> {
  const { db, session } = splitCursorSessionPath(path);
  const sessions = parseCursorStore(await storeRows(db, session));
  const found = session === null ? sessions[0] : sessions.find((s) => s.id === session);
  return found?.transcript ?? { sessionId: session ?? '', cwd: null, events: [], skipped: 0 };
}
