import {
  JOURNAL_DAYS,
  JOURNAL_LIMITATIONS,
  MAX_NOTABLE_ROWS,
  MAX_TAIL_ROWS,
  SINCE_SKEW_MS,
  localDate,
  parseCursorToken,
  validateSinceRequest,
  validateTailRequest,
  type JournalCursor,
  type JournalDay,
  type JournalRow,
  type JournalSince,
  type JournalSummary,
  type JournalTail,
} from '../lib/journal-view';
import { readJournalWindow, type JournalLine, type JournalWindow } from './journal-view-reader';

type Response = { status: number; body: unknown };

/** What a first read, or a read that lost its place, shows: the newest few rows. */
const START_ROWS = 25;
const MAX_CLASSES = 10;

interface Dependencies {
  readonly home: string;
  readonly now?: () => Date;
}

const refusal = (error: string): Response => ({ status: 400, body: { error } });

function selected(lines: readonly JournalLine[]): JournalRow[] {
  return lines.flatMap((line) => (line.row === null ? [] : [line.row]));
}

/** Adds one row to counts: a flagged result, or the decision of an action. */
function countRow(
  counts: { allow: number; ask: number; deny: number; suspect: number },
  row: JournalRow,
): void {
  if (row.phase === 'post') counts.suspect += 1;
  else if (row.decision !== null) counts[row.decision] += 1;
}

/**
 * The moment the window reaches back to: null where it holds everything (it was not cut short, or the
 * journal is missing and holds nothing to miss), the time of its oldest row where it was cut short,
 * and +Infinity where nothing could be read.
 */
function reachesTo(win: JournalWindow, rows: readonly JournalRow[]): number | null {
  if (win.state === 'missing') return null;
  if (win.state !== 'ready') return Number.POSITIVE_INFINITY;
  if (!win.truncated) return null;
  const first = rows[0];
  return first === undefined ? Number.POSITIVE_INFINITY : Date.parse(first.at);
}

/**
 * Whether a window holds every row recorded since a moment: it reaches back to the moment and every
 * line of it could be read. A line that cannot be read may hold any decision, and one that could not
 * be read at all is never complete.
 */
function reachesBack(win: JournalWindow, rows: readonly JournalRow[], since: Date): boolean {
  const from = reachesTo(win, rows);
  return win.unreadable === 0 && (from === null || from <= since.getTime());
}

/** The newest `JOURNAL_DAYS` local days of the rows, oldest first, each with how much of it was read. */
function byDay(
  win: JournalWindow,
  rows: readonly JournalRow[],
  today: Date,
): { days: JournalDay[]; complete: boolean } {
  const dayStart = (i: number): Date =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - (JOURNAL_DAYS - 1) + i);
  const from = reachesTo(win, rows);
  const counts = Array.from({ length: JOURNAL_DAYS }, () => ({
    allow: 0,
    ask: 0,
    deny: 0,
    suspect: 0,
  }));
  const dates = Array.from({ length: JOURNAL_DAYS }, (_, i) => localDate(dayStart(i)));
  const index = new Map(dates.map((date, i) => [date, i]));
  const lastDate = dates[JOURNAL_DAYS - 1] as string;
  for (const row of rows) {
    const date = localDate(new Date(row.at));
    // A row stamped after today (a clock that ran ahead) was recorded all the same: it counts today.
    const at = date > lastDate ? JOURNAL_DAYS - 1 : index.get(date);
    if (at !== undefined) countRow(counts[at] as (typeof counts)[number], row);
  }
  const days: JournalDay[] = dates.map((date, i) => {
    const day = counts[i] as (typeof counts)[number];
    const begins = dayStart(i).getTime();
    const ends = dayStart(i + 1).getTime();
    const read = from === null || from <= begins ? 'all' : from < ends ? 'part' : 'none';
    // A row whose clock ran back can land on a day older than the part read: that day was read in part.
    const total = day.allow + day.ask + day.deny + day.suspect;
    return { date, read: read === 'none' && total > 0 ? 'part' : read, ...day };
  });
  return {
    days,
    complete: win.unreadable === 0 && days.every((day) => day.read === 'all'),
  };
}

function headOf(lines: readonly JournalLine[]): JournalCursor | null {
  const last = lines.at(-1);
  return last === undefined ? null : { seq: last.seq, lineSha: last.sha };
}

/**
 * Read-only views of the audit journal for the live page: a cursor-based tail and a summary of the
 * newest window. Both read the same bounded window; neither writes, and neither checks the hash
 * chain (Investigations does, on request).
 */
export function createJournalViewService({ home, now = () => new Date() }: Dependencies) {
  let closed = false;

  async function window(): Promise<JournalWindow> {
    return readJournalWindow(home);
  }

  function newest(win: JournalWindow, cursor: JournalTail['cursor']): JournalTail {
    const rows = selected(win.lines).slice(-START_ROWS);
    return tailBody(win, cursor, rows, headOf(win.lines));
  }

  function tailBody(
    win: JournalWindow,
    cursor: JournalTail['cursor'],
    rows: readonly JournalRow[],
    head: JournalCursor | null,
  ): JournalTail {
    return {
      schema: 'stroq-journal-tail/1',
      source: 'local',
      generatedAt: now().toISOString(),
      state: win.state,
      cursor,
      rows: win.state === 'ready' ? rows : [],
      head: win.state === 'ready' ? head : null,
      windowTruncated: win.truncated,
      unreadable: win.unreadable,
      limitations: [...JOURNAL_LIMITATIONS],
    };
  }

  return {
    async tail(input: unknown): Promise<Response> {
      if (closed) return { status: 503, body: { error: 'engine-unavailable' } };
      if (!validateTailRequest(input)) return refusal('invalid-request');
      const win = await window();
      if (win.state !== 'ready' || win.lines.length === 0)
        return { status: 200, body: tailBody(win, 'start', [], headOf(win.lines)) };
      const after = input.after === null ? null : parseCursorToken(input.after);
      if (after === null) return { status: 200, body: newest(win, 'start') };
      const index = win.lines.findIndex((line) => line.seq === after.seq);
      if (index >= 0) {
        // Same sequence number, different line: this is not the journal the cursor came from.
        if (win.lines[index]!.sha !== after.lineSha)
          return { status: 200, body: newest(win, 'reset') };
        const rows: JournalRow[] = [];
        let head: JournalCursor | null = null;
        for (const line of win.lines.slice(index + 1)) {
          if (line.row !== null && rows.length === MAX_TAIL_ROWS) break;
          if (line.row !== null) rows.push(line.row);
          head = { seq: line.seq, lineSha: line.sha };
        }
        return {
          status: 200,
          body: tailBody(win, 'ok', rows, head ?? { seq: after.seq, lineSha: after.lineSha }),
        };
      }
      const first = win.lines[0]!.seq;
      // Older than the window we could read: some rows may be missing, and we do not guess how many.
      if (after.seq < first && win.truncated) return { status: 200, body: newest(win, 'gap') };
      return { status: 200, body: newest(win, 'reset') };
    },

    async summary(): Promise<Response> {
      if (closed) return { status: 503, body: { error: 'engine-unavailable' } };
      const win = await window();
      const rows = selected(win.lines);
      const counts = { allow: 0, ask: 0, deny: 0, suspect: 0 };
      const tools: Record<string, number> = {};
      const classes = new Map<string, number>();
      const week = byDay(win, win.state === 'ready' ? rows : [], now());
      for (const row of rows) {
        countRow(counts, row);
        tools[row.tool] = (tools[row.tool] ?? 0) + 1;
        for (const name of row.classes) classes.set(name, (classes.get(name) ?? 0) + 1);
      }
      const notable = rows
        .filter(
          (row) => row.decision === 'deny' || row.decision === 'ask' || row.scan === 'suspect',
        )
        .slice(-MAX_NOTABLE_ROWS)
        .reverse();
      const body: JournalSummary = {
        schema: 'stroq-journal-summary/1',
        source: 'local',
        generatedAt: now().toISOString(),
        state: win.state,
        window: {
          rows: rows.length,
          first: rows[0]?.at ?? null,
          last: rows.at(-1)?.at ?? null,
          truncated: win.truncated,
        },
        counts,
        tools,
        classes: [...classes]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, MAX_CLASSES)
          .map(([name, count]) => ({
            class: name as JournalSummary['classes'][number]['class'],
            count,
          })),
        notable,
        days: week.days,
        daysComplete: week.complete,
        unreadable: win.unreadable,
        limitations: [...JOURNAL_LIMITATIONS],
      };
      return { status: 200, body };
    },

    /** What was recorded after a moment the page gives (its last visit), from the same window. */
    async since(input: unknown): Promise<Response> {
      if (closed) return { status: 503, body: { error: 'engine-unavailable' } };
      if (!validateSinceRequest(input)) return refusal('invalid-request');
      const at = now();
      // A moment still to come is not a visit: refused, rather than answered as a quiet stretch.
      if (Date.parse(input.since) > at.getTime() + SINCE_SKEW_MS) return refusal('invalid-request');
      const win = await window();
      const rows = win.state === 'ready' ? selected(win.lines) : [];
      const moment = new Date(input.since);
      const counts = { allow: 0, ask: 0, deny: 0, suspect: 0 };
      for (const row of rows) if (new Date(row.at) > moment) countRow(counts, row);
      const body: JournalSince = {
        schema: 'stroq-journal-since/1',
        source: 'local',
        generatedAt: at.toISOString(),
        state: win.state,
        since: input.since,
        counts,
        complete: reachesBack(win, rows, moment),
        unreadable: win.unreadable,
        limitations: [...JOURNAL_LIMITATIONS],
      };
      return { status: 200, body };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
