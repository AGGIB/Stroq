// What a summary counts inside a window, by when each event happened.
//
// A session file is put in the window by its date (the last time it was written to), which says nothing
// of when its events were: a session resumed last week holds commands from two months ago. So the card
// counts an event only if its own time is inside the window. A summary keeps its counts by the hour they
// happened in (`SessionSummary.hours`), so the window is applied here, to the summary as it was kept,
// and the kept summary stays true whatever the window is.
//
// The hour that holds the start of the window counts whole: the counts are by the hour, and a few
// commands up to an hour older than the window are counted with it. A moment has its own exact time.
// An event whose record gave no time cannot be placed: it is counted with its file, which the date of
// the file put in the window.
import { HOUR_MS } from './hours.js';
import type { SessionSummary, ToldMoment } from './schema.js';

/** What a session counts inside the window. */
export interface WindowedCounts {
  readonly commands: number;
  readonly told: number;
  readonly moments: readonly ToldMoment[];
}

/** Whether a time (as ISO 8601) is inside the window; one that will not read as a time is. */
export function isInside(at: string | null | undefined, startMs: number): boolean {
  if (at === null || at === undefined || at === '') return true;
  const ms = Date.parse(at);
  return Number.isNaN(ms) || ms >= startMs;
}

/** The counts and moments of a summary that happened inside the window starting at `startMs`. */
export function withinWindow(summary: SessionSummary, startMs: number): WindowedCounts {
  let commands = 0;
  let told = 0;
  for (const [hour, c, t] of summary.hours) {
    // An hour is inside if any part of it is at or after the start.
    if (hour !== null && (hour + 1) * HOUR_MS <= startMs) continue;
    commands += c;
    told += t;
  }
  return {
    commands,
    told,
    moments: summary.moments.filter((moment) => isInside(moment.at, startMs)),
  };
}
