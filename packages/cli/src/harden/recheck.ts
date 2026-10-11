import { resolveRealPath } from './atomic.js';
import { readTargetBytes, sameBytes } from './read.js';
import { HardenError } from './types.js';

/**
 * The last look at a file before it is replaced or removed.
 *
 * The engine reads a file, works out what to write, and writes it, and in between the owner (or
 * an editor, or an agent) can change the file. A replacement built from the old text would erase
 * that change without a word. So the file is read once more at the last point there is, before
 * every try of the rename (a rename that was refused for a moment is tried again after a wait, and
 * the wait is when the file is likely to be saved), and the replacement is made only if it is still
 * what was read.
 *
 * This narrows the window in which an edit can be lost to the time between that read and the
 * rename that follows it. It does not close it: no portable call replaces an existing file only
 * if it is unchanged, and the rename that puts a new file in place does not refuse to replace one
 * that has appeared since, so an edit made in those few microseconds is still overwritten.
 */

/**
 * Throws `stale-plan` unless the path `file` still leads to `real` and `real` still holds exactly
 * `expected` (`null`: still not there). `file` is the path as it was asked for, which may be a link.
 */
export function assertUnchanged(file: string, real: string, expected: Uint8Array | null): void {
  if (resolveRealPath(file) !== real) {
    throw new HardenError(
      'stale-plan',
      `refusing to replace ${real}: the path ${file} now leads to another file. Nothing was changed.`,
    );
  }
  if (!sameBytes(readTargetBytes(real), expected)) {
    throw new HardenError(
      'stale-plan',
      `refusing to replace ${real}: it changed after Stroq read it. Nothing was changed; try again.`,
    );
  }
}
