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
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectStringsDeep } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { isRecord, toolInputRecord } from '../adapters/tool-input.js';
import type {
  SessionList,
  Transcript,
  TranscriptEvent,
  TranscriptFile,
} from '../replay/transcript.js';

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
  /** Raw rows in replay order, including any row that did not produce an event. */
  readonly rows: readonly string[];
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
  // Every field is kept beside the ones read by name: a key in a field no reader names (a working
  // folder, the text of an edit) is still in the call, and placed from there.
  if (mapped === 'Bash') {
    const command = record['command'];
    return {
      tool: mapped,
      input: { ...record, command: typeof command === 'string' ? command : '' },
      paths,
    };
  }
  if (mapped === 'Read' || mapped === 'Write') {
    // `relativeWorkspacePath` is what every measured edit carries — there is no
    // absolute path to report for one, and inventing it by joining a guessed
    // workspace root would put a path in the report that the record never held.
    const file =
      record['targetFile'] ?? record['relativeWorkspacePath'] ?? record['path'] ?? record['uri'];
    const filePath = typeof file === 'string' ? file : '';
    if (mapped === 'Read')
      return { tool: mapped, input: { ...record, file_path: filePath }, paths };
    // What an edit writes is in a field of its own (`streamingContent`, `code_edit`, …): every
    // text it carries but the file's name is read as what it wrote.
    const content = Object.entries(record)
      .filter(([field]) => !EDIT_NAME_FIELDS.has(field))
      .flatMap(([, value]) => collectStringsDeep(value))
      .join('\n');
    return { tool: mapped, input: { ...record, file_path: filePath, content }, paths };
  }
  return { tool: mapped, input: record, paths };
}

/** The fields of an edit that name its file, not what it writes there. */
const EDIT_NAME_FIELDS: ReadonlySet<string> = new Set([
  'targetFile',
  'relativeWorkspacePath',
  'path',
  'uri',
  'effectiveUri',
  'absolutePath',
  'targetDirectory',
]);

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
    {
      bubbles: { readonly at: number; readonly raw: string; readonly events: TranscriptEvent[] }[];
      roots: string[];
      latest: number;
      skipped: number;
    }
  >();

  for (const row of rows) {
    const parts = row.key.split(':');
    if (parts.length < 3 || parts[0] !== 'bubbleId') continue;
    const id = parts[1] ?? '';
    if (id === '') continue;
    let session = bySession.get(id);
    if (session === undefined) {
      session = { bubbles: [], roots: [], latest: 0, skipped: 0 };
      bySession.set(id, session);
    }

    const bubble = parseJson(row.value);
    const at =
      isRecord(bubble) && typeof bubble['createdAt'] === 'string' ? bubble['createdAt'] : '';
    const moment = Date.parse(at);
    const events: TranscriptEvent[] = [];
    session.bubbles.push({
      at: Number.isFinite(moment) ? moment : Infinity,
      raw: row.value,
      events,
    });
    if (!isRecord(bubble)) {
      session.skipped += 1;
      continue;
    }
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
    events.push({ kind: 'pre', id: callId, tool: call.tool, input: call.input, at });

    const text = resultTextOf(former['result']);
    if (text === null) continue;
    events.push({
      kind: 'post',
      id: callId,
      tool: call.tool,
      input: call.input,
      resultText: text,
      at,
    });
  }

  return [...bySession.entries()]
    .map(([id, s]) => {
      // SQLite's row order is insertion order, which can change when a bubble is replaced.
      // Keep pre/post events together. Put undated bubbles after dated ones, in store order,
      // and preserve store order for bubbles with the same date.
      const ordered = s.bubbles.sort((a, b) => a.at - b.at || 0);
      return {
        id,
        mtimeMs: s.latest,
        roots: s.roots,
        transcript: {
          sessionId: id,
          cwd: s.roots[0] ?? null,
          events: ordered.flatMap((bubble) => bubble.events),
          skipped: s.skipped,
        } satisfies Transcript,
        rows: ordered.map((bubble) => bubble.raw),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The events of one stored row of a session, read as `parseCursorStore` reads it: for reading a
 * session one row at a time, so what a row holds can be told from what was read from it.
 */
export function cursorRowEvents(session: string, n: number, value: string): TranscriptEvent[] {
  const [one] = parseCursorStore([{ key: `bubbleId:${session}:${n}`, value }]);
  return one === undefined ? [] : [...one.transcript.events];
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
 * The store's address as SQLite opens it with `immutable=1`: read as a plain file, with no lock
 * taken and nothing created beside it.
 *
 * Cursor's store is in WAL mode. Opened read-only the usual way with no other connection (Cursor
 * not running), SQLite still creates `state.vscdb-shm` and `state.vscdb-wal` beside it, and a
 * read-only connection cannot remove them again: the check would write while saying it wrote
 * nothing. The cost of `immutable` is that changes Cursor has not yet moved from its write-ahead
 * file into the store are not read. `cursorChangesPending` says when there are any, and the
 * report names them as not checked.
 */
function storeUrl(db: string): URL {
  const url = pathToFileURL(db);
  url.search = '?immutable=1';
  return url;
}

/**
 * Whether Cursor holds changes in its write-ahead file (`state.vscdb-wal`) that a read of the
 * store does not see: written while Cursor runs, until it moves them into the store.
 */
export function cursorChangesPending(db: string): boolean {
  try {
    const wal = lstatSync(`${db}-wal`);
    return wal.isFile() && wal.size > 0;
  } catch {
    return false;
  }
}

/**
 * Rows from the store, read-only and never held longer than the parse.
 *
 * Read-only and immutable (`storeUrl`): this is the user's live Cursor store, and nothing is
 * created beside it, and no lock the running editor is entitled to is taken.
 */
export async function storeRows(db: string, session: string | null): Promise<CursorRow[]> {
  return (await readStoreRows(db, session)) ?? [];
}

/** A bounded reader can distinguish an incomplete snapshot from an empty store. */
export async function readStoreRows(
  db: string,
  session: string | null,
  budget?: { readonly stopAt: number; readonly maxRows: number; readonly maxBytes: number },
): Promise<CursorRow[] | null> {
  const mod = await sqlite();
  if (mod === null || (budget !== undefined && Date.now() >= budget.stopAt)) return null;
  let handle;
  try {
    handle = new mod.DatabaseSync(storeUrl(db), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const like = session === null ? 'bubbleId:%' : `bubbleId:${session}:%`;
    const records =
      budget === undefined
        ? handle.prepare('select key, value from cursorDiskKV where key like ?').all(like)
        : handle
            .prepare(
              `
          select key, typeof(value) = 'text' as isText,
            case when typeof(value) <> 'text' then null
                 when length(cast(value as blob)) <= ? then value end as value
          from cursorDiskKV where key like ?
        `,
            )
            .iterate(budget.maxBytes, like);
    const rows: CursorRow[] = [];
    let bytes = 0;
    for (const { key, value, isText } of records) {
      if (budget !== undefined && Date.now() >= budget.stopAt) return null;
      if (typeof key !== 'string') continue;
      if (typeof value !== 'string') {
        // The bounded query leaves out the payload of an oversized text row.
        if (isText === 1) return null;
        continue;
      }
      if (budget !== undefined) {
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        if (rows.length >= budget.maxRows || bytes > budget.maxBytes) return null;
      }
      rows.push({ key, value });
    }
    return budget !== undefined && Date.now() >= budget.stopAt ? null : rows;
  } catch {
    // A store whose schema has moved on is not an error to report at people: the
    // command says it found no Cursor session, which is true.
    return null;
  } finally {
    handle.close();
  }
}

/** How much one bounded read of the store may take: a deadline, and rows and bytes it may hold. */
export interface StoreBudget {
  readonly stopAt: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}

/**
 * The session of a `bubbleId:<session>:<bubble>` key, in SQL, and null for a key
 * `parseCursorStore` skips: the same split on `:` it makes, so both read a key alike.
 */
const SESSION_OF_KEY = `case when typeof(key) = 'text' and substr(key, 1, 9) = 'bubbleId:'
    and instr(substr(key, 10), ':') > 1 then substr(key, 10, instr(substr(key, 10), ':') - 1) end`;

/**
 * Each bubble row's session and date, without its value. `judged` is 0 for a row the parse skips
 * (not text), 2 for one this pass cannot judge (too large, or not plain JSON to SQLite), and 1
 * for the rest, with `at` the text of the LAST top-level `createdAt`, as `JSON.parse` keeps it, or
 * null when that is not a string. CASE, not AND, so a value over the limit is never parsed.
 */
const DATES_SQL = `
  select ${SESSION_OF_KEY} as session,
    case when typeof(value) <> 'text' then 0
         when length(cast(value as blob)) > ?1 then 2
         when not json_valid(value) then 2
         else 1 end as judged,
    case when typeof(value) <> 'text' then null
         when length(cast(value as blob)) > ?1 then null
         when not json_valid(value) then null
         else (select case when type = 'text' then value end from json_each(cursorDiskKV.value)
               where key = 'createdAt' order by id desc limit 1) end as at
  from cursorDiskKV where key like 'bubbleId:%'`;

/** The rows of the sessions named in ?2 (a JSON array), in the order a read of every row has. */
const CHOSEN_ROWS_SQL = `
  select ${SESSION_OF_KEY} as session, key, typeof(value) = 'text' as isText,
    case when typeof(value) <> 'text' then null
         when length(cast(value as blob)) <= ?1 then value end as value
  from cursorDiskKV
  where key like 'bubbleId:%' and ${SESSION_OF_KEY} in (select value from json_each(?2))`;

/**
 * Every row of the sessions that may have a bubble at or after `cutoff`, and how many sessions the
 * store holds, or null when that could not be read in full within `budget`.
 *
 * The budget covers the rows of those sessions only, not the whole history: a first pass reads
 * each row's session and date in SQLite, without its value, and a second reads the rows of the
 * chosen sessions. The parse of those rows still decides which sessions are in the window. The
 * first pass only leaves sessions out, and only on a date it read: a session with a row it cannot
 * judge is read in full, so the parse judges that row. The second pass must find the rows the
 * first one counted, or the store changed between them and nothing is returned.
 */
export async function readStoreWindow(
  db: string,
  cutoff: number,
  budget: StoreBudget,
): Promise<{ readonly rows: CursorRow[]; readonly sessions: number } | null> {
  const mod = await sqlite();
  if (mod === null || Date.now() >= budget.stopAt) return null;
  let handle;
  try {
    handle = new mod.DatabaseSync(storeUrl(db), { readOnly: true });
  } catch {
    return null;
  }
  try {
    // A session's date is the newest of its bubbles, from 0, as `parseCursorStore` takes it.
    const seen = new Map<string, { rows: number; latest: number; unsure: boolean }>();
    for (const { session, judged, at } of handle.prepare(DATES_SQL).iterate(budget.maxBytes)) {
      if (Date.now() >= budget.stopAt) return null;
      if (typeof session !== 'string' || judged === 0) continue;
      const s = seen.get(session) ?? { rows: 0, latest: 0, unsure: false };
      const moment = typeof at === 'string' ? Date.parse(at) : NaN;
      // U+FFFD is where SQLite's text may differ from what `JSON.parse` reads (an escaped lone
      // surrogate), so such a date is not judged here.
      const lossy = typeof at === 'string' && at.includes('\uFFFD');
      seen.set(session, {
        rows: s.rows + 1,
        latest: Number.isFinite(moment) ? Math.max(s.latest, moment) : s.latest,
        unsure: s.unsure || judged !== 1 || lossy,
      });
    }
    const chosen = [...seen].filter(([, s]) => s.unsure || s.latest >= cutoff);
    if (chosen.length === 0) return { rows: [], sessions: seen.size };

    const rows: CursorRow[] = [];
    const found = new Map<string, number>();
    let bytes = 0;
    const records = handle
      .prepare(CHOSEN_ROWS_SQL)
      .iterate(budget.maxBytes, JSON.stringify(chosen.map(([id]) => id)));
    for (const { session, key, value, isText } of records) {
      if (Date.now() >= budget.stopAt) return null;
      if (typeof session !== 'string' || typeof key !== 'string') continue;
      if (typeof value !== 'string') {
        // The query leaves out the payload of an oversized text row.
        if (isText === 1) return null;
        continue;
      }
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (rows.length >= budget.maxRows || bytes > budget.maxBytes) return null;
      rows.push({ key, value });
      found.set(session, (found.get(session) ?? 0) + 1);
    }
    const complete =
      found.size === chosen.length && chosen.every(([id, s]) => found.get(id) === s.rows);
    return complete && Date.now() < budget.stopAt ? { rows, sessions: seen.size } : null;
  } catch {
    return null;
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
  return [...(await findCursorSessionsScoped(cwd, db)).files];
}

/** `findCursorSessions`, and whether the list is this directory's own; see `SessionList`. */
export async function findCursorSessionsScoped(cwd: string, db?: string): Promise<SessionList> {
  const store = db ?? cursorStateDb();
  const sessions = parseCursorStore(await storeRows(store, null));
  const files = (list: readonly CursorSession[]): TranscriptFile[] =>
    list.map((s) => ({ path: cursorSessionPath(store, s.id), mtimeMs: s.mtimeMs }));
  const here = sessions.filter((s) => s.roots.some((root) => isUnder(root, cwd)));
  return here.length > 0
    ? { files: files(here), scoped: true, depth: 0 }
    : { files: files(sessions), scoped: false, depth: 0 };
}

/** One session out of a store, or the newest one when the path names no session. */
export async function readCursorSession(path: string): Promise<Transcript> {
  const { db, session } = splitCursorSessionPath(path);
  const sessions = parseCursorStore(await storeRows(db, session));
  const found = session === null ? sessions[0] : sessions.find((s) => s.id === session);
  return found?.transcript ?? { sessionId: session ?? '', cwd: null, events: [], skipped: 0 };
}
