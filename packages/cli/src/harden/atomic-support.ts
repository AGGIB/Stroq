import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Fs } from './types.js';

/**
 * The parts of an atomic write that are about the world around it rather than about the write:
 * links that lead nowhere, temporary files a hard stop left behind, and a rename that the
 * operating system refuses for a moment.
 */

// ---------------------------------------------------------------------------------------------
// A link that points nowhere.

/**
 * The link in `real` (a path that has already had every link that leads somewhere followed) that
 * points nowhere, or `null`. What is left of the path after that resolution is names that do not
 * exist yet, and at most one of them can be a link: the first, right below the part that exists.
 * Walking up from the file to the first thing that is there finds it. A loop of links counts: it
 * leads nowhere, only more slowly.
 */
export function danglingLinkIn(real: string): string | null {
  for (let at = real; ;) {
    try {
      return lstatSync(at).isSymbolicLink() ? at : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') return at;
      // Anything but "not there" (no permission to look) is not something this check can judge.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Temporary files that a hard stop left behind.

/** Younger than this, a temporary file may belong to a writer that is working right now. */
export const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

const OWN_TEMP_HEAD = '.';
const OWN_TEMP_TAIL = '.tmp';
/** The process id and the random part that `writeFileAtomic` puts in the name it makes. */
const OWN_TEMP_MIDDLE = /^\d{1,10}-[0-9a-f]{12}$/;

/** The name `writeFileAtomic` gives the temporary file it makes beside `base`. */
export const tempNameFor = (base: string, pid: number, random: string): string =>
  `${OWN_TEMP_HEAD}${base}.stroq-${pid}-${random}${OWN_TEMP_TAIL}`;

/**
 * Whether `name` is exactly a temporary file of the shape `tempNameFor` makes for `base`:
 * `.<base>.stroq-<pid>-<12 hex>.tmp`. The directory is the owner's, and a file that is not in
 * this shape is not Stroq's to delete, however old it is or whatever it looks like.
 */
export function isOwnTempName(name: string, base: string): boolean {
  const head = `${OWN_TEMP_HEAD}${base}.stroq-`;
  if (!name.startsWith(head) || !name.endsWith(OWN_TEMP_TAIL)) return false;
  if (name.length <= head.length + OWN_TEMP_TAIL.length) return false;
  return OWN_TEMP_MIDDLE.test(name.slice(head.length, name.length - OWN_TEMP_TAIL.length));
}

/**
 * Removes the temporary files of `base` in `dir` that are older than an hour. A process that is
 * stopped hard (a power cut, a SIGKILL) between "the new content is written" and "it replaces
 * the old file" leaves a complete copy of the content that was about to be written, in the
 * owner's own directory, where nothing else would ever remove it.
 *
 * Best effort in every step: a directory that cannot be listed, a file that cannot be looked at
 * or removed, is not a reason to stop the write that asked.
 */
export async function sweepStaleTemps(
  fs: Fs,
  dir: string,
  base: string,
  now: number,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isOwnTempName(name, base)) continue;
    const path = join(dir, name);
    try {
      const found = await fs.stat(path);
      if (found.isFile() && now - found.mtimeMs > STALE_TEMP_AGE_MS) await fs.unlink(path);
    } catch {
      // Gone already, or not ours to remove: either way, nothing to do here.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A rename that is refused for a moment.

/**
 * Windows refuses a rename onto a file that another handle holds (an editor, an indexer, a virus
 * scanner) with EPERM or EBUSY, and the same call works a moment later.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);

/** Three tries in all, with a short, growing wait between them: a refusal that lasts is a refusal. */
export const RENAME_TRIES = 3;
export const RENAME_WAITS_MS: readonly number[] = [25, 75];

export const realSleep = (ms: number): Promise<void> => delay(ms);

/**
 * `fs.rename(from, to)`, tried again after a transient refusal. Any other failure, and the last
 * transient one, is thrown as it came.
 *
 * `before` is called before EVERY try, not once before the first. A try that follows a refusal
 * comes after a wait, and the wait is exactly when whoever holds the file (an editor saving it, an
 * indexer) is likely to change it: a look taken before the first try says nothing about it. If
 * `before` throws, that is the error, and no further try is made.
 */
export async function renameWithRetry(
  fs: Fs,
  from: string,
  to: string,
  sleep: (ms: number) => Promise<void>,
  before?: () => void | Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await before?.();
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_TRIES || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await sleep(RENAME_WAITS_MS[attempt - 1] ?? RENAME_WAITS_MS.at(-1) ?? 0);
    }
  }
}
