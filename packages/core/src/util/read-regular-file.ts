import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** What `readRegularFile` found at a path. */
export type RegularFileRead =
  | { readonly kind: 'text'; readonly text: string; readonly size: number }
  | { readonly kind: 'not-regular' }
  | { readonly kind: 'too-large'; readonly size: number };

/**
 * `O_NONBLOCK` so that opening a FIFO returns at once instead of waiting for a writer
 * that may never come; the handle is then refused below as not a regular file. On a
 * regular file the flag changes nothing. Windows defines no such constant, and 0
 * leaves the open as it was.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * A file someone else chose, read only if it is a regular file of at most `maxBytes`,
 * and checked on the same handle that is then read.
 *
 * The paths this is for are named by a repository or reachable by the agent: a
 * project's `package.json`, its `CLAUDE.md`, its `.git/config`, an agent's settings.
 * Any of them can be a symlink to `/dev/zero`, which never ends, or a FIFO, which
 * blocks the read until something writes to it. `stat` on the path and then
 * `readFileSync` on the same path checked one file and read whatever was there a
 * moment later; one handle, `fstat`ed and then read, is the file that was checked.
 * The buffer is sized from that `fstat`, so a file that grows afterwards cannot make
 * the read exceed `maxBytes` either.
 *
 * A path that cannot be opened (missing, unreadable, a broken symlink) throws, as the
 * `fs` calls this replaces did; callers decide what that means.
 */
export function readRegularFile(path: string, maxBytes: number): RegularFileRead {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { kind: 'not-regular' };
    if (stats.size > maxBytes) return { kind: 'too-large', size: stats.size };
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { kind: 'text', text: buffer.toString('utf8', 0, filled), size: stats.size };
  } finally {
    closeSync(fd);
  }
}
