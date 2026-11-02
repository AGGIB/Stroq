// The hours a session's counts are kept by (`SessionSummary.hours`).
import { MAX_HOURS, type SessionHour } from './schema.js';

/** One hour, in milliseconds. */
export const HOUR_MS = 3_600_000;

/** The hour (whole hours since 1970) a record's time falls in, or null when it will not read as a time. */
export function hourOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) || ms < 0 ? null : Math.floor(ms / HOUR_MS);
}

/**
 * Counts by the hour they happened in, oldest first (events with no time last), the newest `MAX_HOURS`.
 * An event whose record gave no time is kept apart, because the window cannot place it: it is counted
 * with its file, whose date put the session in the window.
 */
export function hoursOf(
  commandHours: readonly (number | null)[],
  toldHours: readonly (number | null)[],
): SessionHour[] {
  const counts = new Map<number | null, { commands: number; told: number }>();
  const add = (hour: number | null, which: 'commands' | 'told'): void => {
    const held = counts.get(hour) ?? { commands: 0, told: 0 };
    counts.set(hour, { ...held, [which]: held[which] + 1 });
  };
  for (const hour of commandHours) add(hour, 'commands');
  for (const hour of toldHours) add(hour, 'told');
  const rows = [...counts.entries()]
    .map(([hour, c]): SessionHour => [hour, c.commands, c.told])
    .sort((a, b) => (a[0] ?? Infinity) - (b[0] ?? Infinity));
  // Past the cap the oldest are dropped; the ones with no time stay (they are the last).
  const timed = rows.filter((r) => r[0] !== null);
  const untimed = rows.filter((r) => r[0] === null);
  return [...timed.slice(-(MAX_HOURS - untimed.length)), ...untimed];
}
