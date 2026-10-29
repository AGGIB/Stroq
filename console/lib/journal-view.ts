import { ACTION_CLASSES, type ActionClass } from '../../packages/core/src/types';
import { ACTION_LABELS } from './incident-comparison';
import { closed, count, hash, list, member, stamp, text } from './local-guards';

/**
 * A live, read-only view of the audit journal: a short, safe projection of each recorded action.
 *
 * What a row keeps is finite: when, before or after the tool ran, what Stroq decided, a coarse tool
 * kind, the action classes, a bundled rule id, a pseudonymous session and the digest of the raw
 * line. What it never keeps: the command, path, URL, tool name, summary, reason, secret names or
 * any raw session id. Those stay in the journal.
 */

export const JOURNAL_TOOLS = [
  'shell',
  'file-read',
  'file-write',
  'search',
  'web',
  'mcp',
  'task',
  'other',
] as const;
export type JournalTool = (typeof JOURNAL_TOOLS)[number];

export const MAX_TAIL_ROWS = 100;
export const MAX_NOTABLE_ROWS = 8;
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;

export interface JournalRow {
  readonly seq: number;
  readonly at: string;
  readonly phase: 'pre' | 'post';
  /** The recorded policy decision of a `pre` row; null for a `post` row. */
  readonly decision: 'allow' | 'ask' | 'deny' | null;
  /** A `post` row is kept only when the scan of the tool's result looked suspect. */
  readonly scan: 'suspect' | null;
  readonly tool: JournalTool;
  readonly classes: readonly ActionClass[];
  /** A bundled default rule id, or null: nothing matched, or a rule of the person's own policy. */
  readonly ruleId: string | null;
  readonly session: string;
  readonly evidenceSha: string;
}

export interface JournalCursor {
  readonly seq: number;
  readonly lineSha: string;
}

export interface JournalTail {
  readonly schema: 'stroq-journal-tail/1';
  readonly source: 'local';
  readonly generatedAt: string;
  readonly state: 'ready' | 'missing' | 'refused';
  /**
   * `start`: no cursor was given. `ok`: rows are newer than the cursor. `gap`: the cursor is older
   * than the window read, so some rows may be missing (no count is invented). `reset`: the journal
   * is not the one the cursor came from.
   */
  readonly cursor: 'start' | 'ok' | 'gap' | 'reset';
  /** Oldest first. */
  readonly rows: readonly JournalRow[];
  /** The last line of the journal that was read, whatever its kind; the next request's cursor. */
  readonly head: JournalCursor | null;
  readonly windowTruncated: boolean;
  /** Lines in the window that could not be read as a record. */
  readonly unreadable: number;
  readonly limitations: readonly string[];
}

/** How many local days the summary counts by day: today and the six before it. */
export const JOURNAL_DAYS = 7;
/** How far ahead of this machine's clock a moment given to the journal view may be. */
export const SINCE_SKEW_MS = 5 * 60_000;

/** How much of a day lies in the part of the journal that was read. */
export const DAY_READ = ['all', 'part', 'none'] as const;
export type DayRead = (typeof DAY_READ)[number];

/** One local day of the journal, counted like the summary's `counts`. */
export interface JournalDay {
  /** The local date on the machine the console runs on, `YYYY-MM-DD`. */
  readonly date: string;
  /**
   * `all`: the part of the journal read reaches back past the start of the day; `part`: only its
   * later hours are in it; `none`: the day is older than the part read, so its counts say nothing.
   */
  readonly read: DayRead;
  readonly allow: number;
  readonly ask: number;
  readonly deny: number;
  readonly suspect: number;
}

/** The local date of a moment on this machine, `YYYY-MM-DD`. */
export function localDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface JournalSummary {
  readonly schema: 'stroq-journal-summary/1';
  readonly source: 'local';
  readonly generatedAt: string;
  readonly state: 'ready' | 'missing' | 'refused';
  readonly window: {
    readonly rows: number;
    readonly first: string | null;
    readonly last: string | null;
    readonly truncated: boolean;
  };
  readonly counts: {
    readonly allow: number;
    readonly ask: number;
    readonly deny: number;
    readonly suspect: number;
  };
  readonly tools: Readonly<Partial<Record<JournalTool, number>>>;
  readonly classes: ReadonlyArray<{ readonly class: ActionClass; readonly count: number }>;
  /** Newest first: denied and asked actions and suspect results. */
  readonly notable: readonly JournalRow[];
  /** The newest `JOURNAL_DAYS` local days, oldest first. */
  readonly days: readonly JournalDay[];
  /**
   * Every day was read whole and every line of the window could be read: none of them is undercounted.
   * A line that cannot be read may hold any decision, so one is enough to make this false.
   */
  readonly daysComplete: boolean;
  readonly unreadable: number;
  readonly limitations: readonly string[];
}

/** What was recorded after a moment (the last visit to the home screen), counted like the summary. */
export interface JournalSince {
  readonly schema: 'stroq-journal-since/1';
  readonly source: 'local';
  readonly generatedAt: string;
  readonly state: 'ready' | 'missing' | 'refused';
  readonly since: string;
  readonly counts: {
    readonly allow: number;
    readonly ask: number;
    readonly deny: number;
    readonly suspect: number;
  };
  /**
   * The window read reaches back to `since` and every line of it could be read: nothing recorded after
   * it is missing from the counts.
   */
  readonly complete: boolean;
  /** Lines in the window that could not be read as a record. */
  readonly unreadable: number;
  readonly limitations: readonly string[];
}

export const JOURNAL_LIMITATIONS: readonly string[] = [
  'Recorded policy decisions and scan observations from the audit journal, newest 1 MiB of it. Not proof that a host stopped anything.',
  'Commands, paths, URLs, tool names and reasons stay in the journal and are not shown here.',
  'The journal does not record which agent or project an action came from.',
  'A rule id is shown only for Stroq’s bundled rules. A decision with no bundled rule id came from your own policy, the policy default or a built-in limit.',
  'Reading the journal does not check its hash chain. Use Investigations to verify it.',
];

export const JOURNAL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'invalid-request': 'That request could not be read. Reload the page.',
  busy: 'The journal is being read. Try again in a moment.',
  'runtime-unavailable': 'The local engine is not available. Rebuild it and restart the console.',
  'engine-unavailable': 'The local engine is not available. Rebuild it and restart the console.',
};

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SESSION = /^session-[a-f0-9]{16}$/;
const CLASSES: readonly string[] = ACTION_CLASSES;

const CURSOR_TOKEN = /^([1-9][0-9]{0,15})\.([a-f0-9]{64})$/;

/** The cursor travels as one opaque string, because the strict request parser reads flat objects. */
export function cursorToken(cursor: JournalCursor): string {
  return `${cursor.seq}.${cursor.lineSha}`;
}

export function parseCursorToken(value: unknown): JournalCursor | null {
  const match = typeof value === 'string' ? CURSOR_TOKEN.exec(value) : null;
  const seq = match === null ? NaN : Number(match[1]);
  return match !== null && Number.isSafeInteger(seq) ? { seq, lineSha: match[2]! } : null;
}

export function validateTailRequest(v: unknown): v is { after: string | null } {
  return closed(v, ['after']) && (v.after === null || parseCursorToken(v.after) !== null);
}

function validCursor(v: unknown): v is JournalCursor {
  return closed(v, ['seq', 'lineSha']) && count(v.seq, MAX_SEQ) && v.seq >= 1 && hash(v.lineSha);
}

function validClasses(v: unknown): v is ActionClass[] {
  return (
    Array.isArray(v) &&
    v.length <= CLASSES.length &&
    new Set(v).size === v.length &&
    v.every((item) => typeof item === 'string' && CLASSES.includes(item))
  );
}

export function validateJournalRow(v: unknown): v is JournalRow {
  if (
    !closed(v, [
      'seq',
      'at',
      'phase',
      'decision',
      'scan',
      'tool',
      'classes',
      'ruleId',
      'session',
      'evidenceSha',
    ])
  )
    return false;
  if (!count(v.seq, MAX_SEQ) || v.seq < 1 || !stamp(v.at)) return false;
  if (!member(v.phase, ['pre', 'post']) || !member(v.tool, JOURNAL_TOOLS)) return false;
  if (v.phase === 'pre') {
    if (!member(v.decision, ['allow', 'ask', 'deny']) || v.scan !== null) return false;
  } else if (v.decision !== null || v.scan !== 'suspect') return false;
  if (!validClasses(v.classes)) return false;
  if (v.ruleId !== null && !(typeof v.ruleId === 'string' && RULE_ID.test(v.ruleId))) return false;
  return typeof v.session === 'string' && SESSION.test(v.session) && hash(v.evidenceSha);
}

const rowsList =
  (max: number) =>
  (v: unknown): v is JournalRow[] =>
    list(v, max, validateJournalRow);

const inOrder = (rows: readonly JournalRow[]) =>
  rows.every((r, i) => i === 0 || r.seq > rows[i - 1]!.seq);

export function validateJournalTail(v: unknown): v is JournalTail {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'state',
      'cursor',
      'rows',
      'head',
      'windowTruncated',
      'unreadable',
      'limitations',
    ])
  )
    return false;
  if (
    v.schema !== 'stroq-journal-tail/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !member(v.state, ['ready', 'missing', 'refused']) ||
    !member(v.cursor, ['start', 'ok', 'gap', 'reset']) ||
    typeof v.windowTruncated !== 'boolean' ||
    !count(v.unreadable, 1_000_000) ||
    !list(v.limitations, 8, (item): item is string => text(item, 400)) ||
    v.limitations.length === 0 ||
    !rowsList(MAX_TAIL_ROWS)(v.rows) ||
    !inOrder(v.rows)
  )
    return false;
  if (v.head !== null && !validCursor(v.head)) return false;
  // A journal that could not be read has no rows and no head to continue from.
  if (v.state !== 'ready') return v.rows.length === 0 && v.head === null;
  // The head is the last line read, so no row can be newer than it.
  return v.rows.every((r) => v.head !== null && r.seq <= (v.head as JournalCursor).seq);
}

const count0 = (v: unknown): v is number => count(v, 10_000_000);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validCounts(v: unknown): v is JournalSince['counts'] {
  return (
    closed(v, ['allow', 'ask', 'deny', 'suspect']) &&
    count0(v.allow) &&
    count0(v.ask) &&
    count0(v.deny) &&
    count0(v.suspect)
  );
}

/** A date of the calendar, `YYYY-MM-DD` (not `2026-02-31`). */
function calendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const at = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === v;
}

/** The date after a date of the calendar. */
const nextDate = (date: string): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

const dayTotal = (day: JournalDay): number => day.allow + day.ask + day.deny + day.suspect;

function validDay(v: unknown): v is JournalDay {
  return (
    closed(v, ['date', 'read', 'allow', 'ask', 'deny', 'suspect']) &&
    calendarDate(v.date) &&
    member(v.read, DAY_READ) &&
    count0(v.allow) &&
    count0(v.ask) &&
    count0(v.deny) &&
    count0(v.suspect) &&
    // A day older than the part read has nothing counted in it.
    (v.read !== 'none' || dayTotal(v as unknown as JournalDay) === 0)
  );
}

export function validateSinceRequest(v: unknown): v is { since: string } {
  return closed(v, ['since']) && stamp(v.since);
}

export function validateJournalSince(v: unknown): v is JournalSince {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'state',
      'since',
      'counts',
      'complete',
      'unreadable',
      'limitations',
    ])
  )
    return false;
  if (!(
    v.schema === 'stroq-journal-since/1' &&
    v.source === 'local' &&
    stamp(v.generatedAt) &&
    member(v.state, ['ready', 'missing', 'refused']) &&
    stamp(v.since) &&
    validCounts(v.counts) &&
    typeof v.complete === 'boolean' &&
    count(v.unreadable, 1_000_000) &&
    list(v.limitations, 8, (item): item is string => text(item, 400)) &&
    v.limitations.length > 0
  ))
    return false;
  const counts = v.counts as JournalSince['counts'];
  const empty = counts.allow + counts.ask + counts.deny + counts.suspect === 0;
  return (
    // A visit is a moment that has passed.
    Date.parse(v.since) <= Date.parse(v.generatedAt) + SINCE_SKEW_MS &&
    // Only a journal that was read has anything counted, and one that could not be is never complete.
    (v.state === 'ready' || empty) &&
    (v.state !== 'refused' || !v.complete) &&
    (!v.complete || v.unreadable === 0)
  );
}

export function validateJournalSummary(v: unknown): v is JournalSummary {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'state',
      'window',
      'counts',
      'tools',
      'classes',
      'notable',
      'days',
      'daysComplete',
      'unreadable',
      'limitations',
    ])
  )
    return false;
  if (
    v.schema !== 'stroq-journal-summary/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !member(v.state, ['ready', 'missing', 'refused']) ||
    !count(v.unreadable, 1_000_000) ||
    !list(v.limitations, 8, (item): item is string => text(item, 400)) ||
    v.limitations.length === 0
  )
    return false;
  const { window: w, counts } = v as { window: unknown; counts: unknown };
  if (
    !closed(w, ['rows', 'first', 'last', 'truncated']) ||
    !count0(w.rows) ||
    (w.first !== null && !stamp(w.first)) ||
    (w.last !== null && !stamp(w.last)) ||
    typeof w.truncated !== 'boolean' ||
    !closed(counts, ['allow', 'ask', 'deny', 'suspect']) ||
    !count0(counts.allow) ||
    !count0(counts.ask) ||
    !count0(counts.deny) ||
    !count0(counts.suspect)
  )
    return false;
  // The three decisions and the flagged results are each counted once, so they fit in the window.
  if (counts.allow + counts.ask + counts.deny + counts.suspect > w.rows) return false;
  // Seven days in a row, oldest first, and no more of a kind counted in them than in the window.
  const days = v.days;
  if (
    !Array.isArray(days) ||
    days.length !== JOURNAL_DAYS ||
    !days.every(validDay) ||
    !days.every((day, i) => i === 0 || nextDate((days[i - 1] as JournalDay).date) === day.date) ||
    (['allow', 'ask', 'deny', 'suspect'] as const).some(
      (kind) =>
        days.reduce((sum: number, day: JournalDay) => sum + day[kind], 0) >
        (counts as JournalSummary['counts'])[kind],
    ) ||
    v.daysComplete !== (days.every((day: JournalDay) => day.read === 'all') && v.unreadable === 0)
  )
    return false;
  const tools = v.tools;
  if (
    tools === null ||
    typeof tools !== 'object' ||
    Array.isArray(tools) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(tools)) ||
    !Object.entries(tools).every(([name, n]) => member(name, JOURNAL_TOOLS) && count0(n))
  )
    return false;
  if (
    !list(
      v.classes,
      CLASSES.length,
      (item): item is { class: ActionClass; count: number } =>
        closed(item, ['class', 'count']) &&
        typeof item.class === 'string' &&
        CLASSES.includes(item.class) &&
        count0(item.count),
    )
  )
    return false;
  return (
    rowsList(MAX_NOTABLE_ROWS)(v.notable) &&
    v.notable.every((r) => r.decision === 'deny' || r.decision === 'ask' || r.scan === 'suspect')
  );
}

export interface LiveEntry {
  readonly row: JournalRow;
  /** True for the rows that arrived with the latest tail, so the page can show what is new. */
  readonly fresh: boolean;
}

/**
 * The rows on screen after one more tail: new rows go on top, newest first. A start, a reset or a gap
 * replaces the list (nothing is marked fresh then), and a gap is reported so the page can say rows
 * may be missing. A journal that cannot be read empties the list.
 */
export function applyTail(
  current: readonly LiveEntry[],
  tail: JournalTail,
  limit: number,
): { entries: LiveEntry[]; gap: boolean } {
  if (tail.state !== 'ready') return { entries: [], gap: false };
  const replace = tail.cursor !== 'ok';
  const arrived = [...tail.rows].reverse().map((row) => ({ row, fresh: !replace }));
  const kept = replace ? [] : current.map((entry) => ({ ...entry, fresh: false }));
  return {
    entries: [...arrived, ...(replace ? [] : kept)].slice(0, limit),
    gap: tail.cursor === 'gap',
  };
}

export interface RowWording {
  readonly title: string;
  readonly verdict: 'Allowed' | 'Asked you' | 'Denied' | 'Flagged';
  readonly tone: 'green' | 'orange' | 'red';
  readonly detail: string;
}

const TOOL_TITLE: Readonly<Record<JournalTool, string>> = {
  shell: 'Run a command',
  'file-read': 'Read a file',
  'file-write': 'Write a file',
  search: 'Search files',
  web: 'Use the web',
  mcp: 'Call an MCP tool',
  task: 'Start a sub-agent',
  other: 'Use a tool',
};

export const JOURNAL_TOOL_TITLE = TOOL_TITLE;

/** Plain words for one row. A policy decision is described as that, never as "blocked" or "safe". */
export function describeRow(row: JournalRow): RowWording {
  const title = TOOL_TITLE[row.tool];
  if (row.phase === 'post') {
    return {
      title,
      verdict: 'Flagged',
      tone: 'orange',
      detail: 'What the agent read looked like an instruction to it.',
    };
  }
  const verdict =
    row.decision === 'deny' ? 'Denied' : row.decision === 'ask' ? 'Asked you' : 'Allowed';
  const tone = row.decision === 'deny' ? 'red' : row.decision === 'ask' ? 'orange' : 'green';
  if (row.decision === 'allow') {
    const first = row.classes[0];
    return {
      title,
      verdict,
      tone,
      detail: first ? ACTION_LABELS[first] : 'No risky class recorded.',
    };
  }
  const labels = row.classes
    .map((c) => ACTION_LABELS[c])
    .slice(0, 2)
    .join(', ');
  const why = row.ruleId !== null ? `Rule ${row.ruleId}` : 'Your own policy or a built-in default';
  return { title, verdict, tone, detail: labels ? `${labels}. ${why}.` : `${why}.` };
}
