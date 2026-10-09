// Two things the stored result and the ledger both do with a file under the Stroq home.
//
// Reading one that may have been put there by someone else: it is opened without following a
// link and without waiting for a writer, looked at through the handle that is then read (a path can
// be swapped between a check and a read), and refused unless it is a regular file of a bounded size.
// Writing one so that it is whole or not there: a temporary file next to it, and a rename.
//
// Nothing here imports from `@stroq/core`, so a test can run it in a child process.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type SafeRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'refused';
      readonly why: 'not a regular file' | 'too large' | 'unreadable';
    };

/**
 * `O_NOFOLLOW` so that a link planted where the file goes is refused and not read through;
 * `O_NONBLOCK` so that a FIFO fails the open at once, where a plain open waits for a writer that may
 * never come. Windows defines neither, and 0 leaves the open as it was (`hook-stamp.ts` does the same).
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** What an open with `O_NOFOLLOW` says to a link, which differs by system. */
const LINK_ERRORS: ReadonlySet<string | undefined> = new Set(['ELOOP', 'EMLINK']);

export function readSmallRegularFile(path: string, maxBytes: number): SafeRead {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    if (LINK_ERRORS.has(code) || code === 'EISDIR')
      return { kind: 'refused', why: 'not a regular file' };
    return { kind: 'refused', why: 'unreadable' };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { kind: 'refused', why: 'not a regular file' };
    if (stats.size > maxBytes) return { kind: 'refused', why: 'too large' };
    // Sized from the `fstat`, so that a file that grows afterwards cannot make the read longer.
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { kind: 'text', text: buffer.toString('utf8', 0, filled) };
  } catch {
    return { kind: 'refused', why: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `text` to `file` through a temporary file in the same directory and a rename, so that an
 * interrupted run leaves the previous file and never half of a new one. Readable only by the user:
 * the directories are made 0700 and the file 0600, like everything else under the Stroq home. The
 * temporary file is made with `wx`, so a link planted at its name is an error and not a write
 * through it. Throws when it cannot write, and leaves no temporary file behind.
 */
export function writePrivateFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
