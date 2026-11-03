import { describeRow, localDate, type JournalRow, type JournalSummary } from './journal-view';
import type { LiveSelection, LiveShow } from './live-navigation';

/**
 * The rules of the Live feed, as pure functions of the rows on screen: which rows a filter keeps,
 * which row an address names, which sessions and days the filters offer, and what the agent had read
 * before a row. Nothing here reads more than a row holds: a coarse tool kind, action classes, a
 * bundled rule id, a pseudonymous session and the digest of the journal line.
 */

const isFlagged = (row: JournalRow): boolean => row.phase === 'post' && row.scan === 'suspect';

/** Whether a row belongs to a filter. Every row is in `all`; a flagged result is not a decision. */
export function inShow(row: JournalRow, show: LiveShow): boolean {
  switch (show) {
    case 'all':
      return true;
    case 'denied':
      return row.phase === 'pre' && row.decision === 'deny';
    case 'asked':
      return row.phase === 'pre' && row.decision === 'ask';
    case 'flagged':
      return isFlagged(row);
  }
}

/** The words a text search looks in: the row as the feed words it, its rule and its session. */
function haystack(row: JournalRow): string {
  const words = describeRow(row);
  return `${words.verdict} ${words.title} ${words.detail} ${row.tool} ${row.ruleId ?? ''} ${row.session}`.toLowerCase();
}

/** The rows a selection keeps, in the order they were given (newest first on screen). */
export function filterRows(
  rows: readonly JournalRow[],
  selection: Pick<LiveSelection, 'show' | 'session' | 'date' | 'text'>,
): JournalRow[] {
  const needle = selection.text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      inShow(row, selection.show) &&
      (selection.session === null || row.session === selection.session) &&
      (selection.date === null || localDate(new Date(row.at)) === selection.date) &&
      (needle === '' || haystack(row).includes(needle)),
  );
}

/** How many rows each filter would keep, for the labels of the filters. */
export function showCounts(rows: readonly JournalRow[]): Readonly<Record<LiveShow, number>> {
  return {
    all: rows.length,
    denied: rows.filter((row) => inShow(row, 'denied')).length,
    asked: rows.filter((row) => inShow(row, 'asked')).length,
    flagged: rows.filter((row) => inShow(row, 'flagged')).length,
  };
}

/** The row an address names: by the digest of its journal line, or, for an older link, by its number. */
export function findEvent(rows: readonly JournalRow[], event: string | null): JournalRow | null {
  if (event === null) return null;
  return (
    rows.find((row) => row.evidenceSha === event) ??
    (/^\d+$/.test(event) ? (rows.find((row) => String(row.seq) === event) ?? null) : null)
  );
}

export interface SessionOption {
  readonly id: string;
  /** The last four characters of the session's name: enough to tell two apart on a screen. */
  readonly short: string;
  readonly rows: number;
  readonly newest: string;
}

/** The sessions on screen, the one with the newest row first. */
export function sessionOptions(rows: readonly JournalRow[]): SessionOption[] {
  const found = new Map<string, { rows: number; newest: string }>();
  for (const row of rows) {
    const seen = found.get(row.session);
    found.set(row.session, {
      rows: (seen?.rows ?? 0) + 1,
      newest: seen === undefined || row.at > seen.newest ? row.at : seen.newest,
    });
  }
  return [...found.entries()]
    .map(([id, value]) => ({ id, short: id.slice(-4), ...value }))
    .sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0));
}

export interface DayOption {
  readonly date: string;
  /** `part` for a day only some of whose hours the part of the journal read reaches. */
  readonly read: 'all' | 'part';
}

/** The days the summary counts, newest first, leaving out the days the part of the journal read does not reach. */
export function dayOptions(summary: JournalSummary | null): DayOption[] {
  if (summary === null) return [];
  return summary.days
    .filter((day) => day.read !== 'none')
    .map((day) => ({
      date: day.date,
      read: day.read === 'all' ? ('all' as const) : ('part' as const),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * The results the scan flagged earlier in the same session, newest first: what the agent had read
 * that looked like an instruction to it, before it did what this row records. Said as what the
 * journal shows; it does not say the one caused the other.
 */
export function readBefore(
  rows: readonly JournalRow[],
  row: JournalRow,
  limit = 3,
): { readonly rows: JournalRow[]; readonly total: number } {
  const earlier = rows
    .filter((other) => other.session === row.session && other.seq < row.seq && isFlagged(other))
    .sort((a, b) => b.seq - a.seq);
  return { rows: earlier.slice(0, limit), total: earlier.length };
}

/** Whether Stroq's recorded evidence can be asked for about this row: a deny, an ask or a flagged result. */
export const hasEvidence = (row: JournalRow): boolean =>
  isFlagged(row) || (row.phase === 'pre' && (row.decision === 'deny' || row.decision === 'ask'));

/** The commands the chain offers to copy for a row. */
export function chainCommands(row: JournalRow): {
  readonly why: string;
  readonly untaint: string;
} {
  return {
    why: `stroq why --seq ${row.seq}`,
    untaint: 'stroq untaint --session <id>',
  };
}
