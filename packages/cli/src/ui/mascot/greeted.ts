// "Has the owl greeted this person yet?", kept as an empty file called `mascot-greeted` in the Stroq
// home. The file is the whole record: its presence says yes.
//
// Both functions are for a command that is about to print something else, and neither may fail it.
// Whatever goes wrong while reading counts as "greeted" (the quiet answer: one still frame), and
// whatever goes wrong while writing counts as "not written". The write follows `hook-stamp.ts`: a
// private home, a private file, and `O_NOFOLLOW` so that a link planted in the marker's place cannot
// make Stroq create or overwrite the file it points at.

import { closeSync, constants, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from '../../log.js';
import { stroqHome } from '../../paths.js';

export const GREETED_FILE_NAME = 'mascot-greeted';

export const greetedFileIn = (home: string): string => join(home, GREETED_FILE_NAME);

/**
 * `O_EXCL` already refuses anything in the way, a link included, and `O_NOFOLLOW` says it a second
 * time; `O_NONBLOCK` keeps a FIFO from holding the open. Windows defines neither of the last two,
 * and 0 leaves the open as it was.
 */
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

/**
 * Whether the owl has greeted this person: true when anything is in the marker's place (a file, a
 * link, a folder: none of it is for Stroq to look inside), and true when it cannot tell. False only
 * when it is plain that there is no marker, a home that does not exist yet included.
 */
export function hasGreeted(home: string = stroqHome()): boolean {
  try {
    lstatSync(greetedFileIn(home));
    return true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) return true;
    // Windows says ENOENT, where POSIX says ENOTDIR, for a name under a file: a home that is there and is not a
    // folder is not "no marker". A home that is not there yet is.
    try {
      return !statSync(home).isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * Writes the marker: an empty file, mode 0600, in the home, which is made (0700) if it is not there.
 * Returns true if this call wrote it. False, and no throw, when anything is in the way already (an
 * earlier marker, a link, a folder) or the write failed; a failure is logged. Call it after a
 * greeting that finished, and not before.
 */
export function markGreeted(home: string = stroqHome()): boolean {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    closeSync(openSync(greetedFileIn(home), CREATE_FLAGS, 0o600));
    return true;
  } catch (error) {
    if (!hasCode(error, 'EEXIST'))
      logError('mascot marker', error instanceof Error ? error.message : String(error));
    return false;
  }
}
