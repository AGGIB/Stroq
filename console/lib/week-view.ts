import type { DayRead, JournalSince, JournalSummary } from './journal-view';

/**
 * The home screen's week: one bar a day of what needs a look (denied, asked you, flagged), with the
 * week's totals and what was recorded since the last visit, in plain words. These are decisions the
 * journal recorded, not proof that a host stopped anything. Allowed actions are counted and said, not
 * drawn: a bar of thousands of reads would make a denial invisible beside it.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface WeekBar {
  /** `YYYY-MM-DD`, the local date. */
  readonly date: string;
  /** The day's short name (`Mon`), or `Today`. */
  readonly label: string;
  /** How much of the day lies in the part of the journal that was read. */
  readonly read: DayRead;
  readonly deny: number;
  readonly ask: number;
  readonly suspect: number;
  readonly allow: number;
  /** Denied, asked and flagged together: what needs a look. */
  readonly attention: number;
}

export interface WeekTotals {
  readonly allow: number;
  readonly ask: number;
  readonly deny: number;
  readonly suspect: number;
}

export interface WeekView {
  readonly bars: readonly WeekBar[];
  readonly totals: WeekTotals;
  /** The most that needs a look on one day: the height of the tallest bar. */
  readonly peak: number;
  /** Every day was read whole and every line could be read. */
  readonly complete: boolean;
  /** Lines of the journal that could not be read. */
  readonly unreadable: number;
}

const dayOf = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
};

export function weekView(journal: JournalSummary): WeekView {
  const last = journal.days.length - 1;
  const bars = journal.days.map((day, i) => ({
    date: day.date,
    label: i === last ? 'Today' : (WEEKDAYS[dayOf(day.date).getDay()] ?? day.date),
    read: day.read,
    deny: day.deny,
    ask: day.ask,
    suspect: day.suspect,
    allow: day.allow,
    attention: day.deny + day.ask + day.suspect,
  }));
  const totals = bars.reduce(
    (sum, bar) => ({
      allow: sum.allow + bar.allow,
      ask: sum.ask + bar.ask,
      deny: sum.deny + bar.deny,
      suspect: sum.suspect + bar.suspect,
    }),
    { allow: 0, ask: 0, deny: 0, suspect: 0 },
  );
  return {
    bars,
    totals,
    peak: Math.max(0, ...bars.map((bar) => bar.attention)),
    complete: journal.daysComplete,
    unreadable: journal.unreadable,
  };
}

const n = (value: number): string => value.toLocaleString('en-US');

const joined = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;

/** "4 denied, 4 asked you, 3 flagged and 284 allowed", or null when nothing was recorded. */
export function recordedPhrase(counts: WeekTotals): string | null {
  const parts = [
    counts.deny > 0 ? `${n(counts.deny)} denied` : null,
    counts.ask > 0 ? `${n(counts.ask)} asked you` : null,
    counts.suspect > 0 ? `${n(counts.suspect)} flagged` : null,
    counts.allow > 0 ? `${n(counts.allow)} allowed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : joined(parts);
}

const unreadableSentence = (lines: number): string =>
  `${n(lines)} ${lines === 1 ? 'line' : 'lines'} of the journal could not be read, so some actions may be missing.`;

/** What the week's counts leave out, in sentences: lines that could not be read, days not read whole. */
function weekCaveats(view: WeekView): string[] {
  const out: string[] = [];
  if (view.unreadable > 0) out.push(unreadableSentence(view.unreadable));
  // Days not read whole are the oldest: the newest of them says how far back the counts go.
  const newest = view.bars.filter((bar) => bar.read !== 'all').at(-1);
  if (newest !== undefined) {
    const first = newest === view.bars[0];
    out.push(
      newest.read === 'part'
        ? `The journal is longer than the part read: ${newest.label} is counted only in part${first ? '' : ', and the days before it not at all'}.`
        : `The journal is longer than the part read: ${newest.label}${first ? ' is' : ' and the days before it are'} not counted.`,
    );
  }
  return out;
}

/** The week in a sentence, and what it leaves out. */
export function weekSentence(view: WeekView): string {
  const recorded = recordedPhrase(view.totals);
  const sentence =
    recorded === null
      ? 'Nothing was recorded in the last 7 days.'
      : `Recorded in the last 7 days: ${recorded}.`;
  return [sentence, ...weekCaveats(view)].join(' ');
}

/** A day in words, for a screen reader: "Mon: 1 denied and 12 allowed". */
export function dayWords(bar: WeekBar): string {
  if (bar.read === 'none') return `${bar.label}: not read`;
  const recorded = recordedPhrase(bar) ?? 'nothing recorded';
  return `${bar.label}: ${recorded}${bar.read === 'part' ? ', only part of the day read' : ''}`;
}

/** The time of a visit, short: `Tue 14:05`, or `14:05` today. */
export function visitTime(since: string, now: Date): string {
  const at = new Date(since);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 6.5) return `${WEEKDAYS[at.getDay()] ?? ''} ${time}`;
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** What was recorded since the last visit, in a sentence, and what it leaves out. */
export function sinceSentence(since: JournalSince, now: Date): string {
  const when = visitTime(since.since, now);
  const recorded = recordedPhrase(since.counts);
  const sentence =
    recorded === null
      ? `Nothing was recorded since your last visit (${when}).`
      : `Since your last visit (${when}): ${recorded}.`;
  if (since.complete) return sentence;
  return `${sentence} ${
    since.unreadable > 0
      ? unreadableSentence(since.unreadable)
      : 'Part of that time is older than the part of the journal read.'
  }`;
}
