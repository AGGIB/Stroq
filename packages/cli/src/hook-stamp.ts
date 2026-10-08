import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { logError } from './log.js';
import { lastHookDir } from './paths.js';

/**
 * The evidence that a host calls Stroq. A hook written into a host's config says nothing about
 * whether the host runs it (hooks switched off, an approval that no longer matches, a plugin that
 * never loaded), and a firewall that silently does nothing is the worst way for one to fail. Each
 * `stroq hook <agent>` leaves the time of the call in a file of its own, and `stroq doctor` reads it.
 * The time and nothing else: no event, no command, no path.
 *
 * Evidence and not proof: the file is the same for any run of `stroq hook <agent>` on this machine,
 * from any project, by the host or by anyone who types the command.
 */

/** The names of the agents Stroq has an adapter for: lower case and hyphens, never a path. */
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

/** What a stamp holds: `Date#toISOString`, 24 characters, and nothing `Date.parse` is lenient about. */
const STAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A stamp is 25 bytes with its newline; a longer file is not one. */
const STAMP_MAX_BYTES = 64;

/**
 * `O_NOFOLLOW` so that a link planted where the stamp goes cannot make this write over the file it
 * points at; `O_NONBLOCK` so that a FIFO planted there fails the open at once, where a plain open
 * waits for a reader that may never come, and the host lifts a hook that has not answered by its own
 * timeout and lets the call through. A regular file is written as before. Windows defines neither
 * constant, and 0 leaves the open as it was (`read-regular-file.ts` does the same).
 */
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

const stampFile = (agent: string): string => join(lastHookDir(), agent);

/** `writeFileSync` types its `flag` as a string, and the flags above are numbers. */
function writeStamp(path: string, text: string): void {
  const fd = openSync(path, WRITE_FLAGS, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes down that `agent` has just called the hook. It never throws: the decision this hook is
 * about to give is worth more than the stamp. A stamp that cannot be written shows in doctor as a
 * call that was never recorded, and says why in the log, so that it is not taken for the host's fault.
 */
export function stampHookFired(agent: string, now: Date = new Date()): void {
  if (!AGENT_NAME.test(agent)) return;
  try {
    mkdirSync(lastHookDir(), { recursive: true, mode: 0o700 });
    writeStamp(stampFile(agent), `${now.toISOString()}\n`);
  } catch (err) {
    // The message and not the stack: this runs on every hook call, and the stack adds a screen.
    logError('hook stamp', err instanceof Error ? err.message : String(err));
  }
}

/**
 * When `agent` last called the hook, or null when nothing readable was recorded. Only a regular
 * file of a few bytes holding exactly what `stampHookFired` writes is a record: a FIFO, a device, a
 * directory, a long file and a date in some other spelling (`Date.parse` takes "1" for 2001) are not.
 */
export function readHookStamp(agent: string): Date | null {
  if (!AGENT_NAME.test(agent)) return null;
  try {
    const read = readRegularFile(stampFile(agent), STAMP_MAX_BYTES);
    if (read.kind !== 'text') return null;
    const text = read.text.trim();
    if (!STAMP_FORMAT.test(text)) return null;
    const stamp = new Date(text);
    // A day that does not exist (`02-31`) is moved by the parser, and printing it differently
    // from how it was written gives it away.
    return Number.isNaN(stamp.getTime()) || stamp.toISOString() !== text ? null : stamp;
  } catch {
    return null;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Hours read better than days up to this long: "47 h ago", then "2 days ago". */
const HOURS_UNTIL_DAYS = 48;

/**
 * How long ago, in the words a person uses. A negative age (a clock set back) is "just now"; the
 * caller decides how far ahead is too far. `ageLabel` in core is for a session's minutes and stops
 * at hours: a hook's last call can be a week old.
 */
export function formatAge(ms: number): string {
  if (ms < MINUTE_MS) return 'just now';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`;
  if (ms < HOURS_UNTIL_DAYS * HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h ago`;
  return `${Math.floor(ms / DAY_MS)} days ago`;
}
