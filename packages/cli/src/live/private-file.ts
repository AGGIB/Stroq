// Two things the stored result and the ledger both do with a file under the Stroq home.
//
// Reading one that may have been put there by someone else: it is read only if it is a regular file of a
// bounded size, by the reader of `@stroq/core` (`readRegularFile`), which is the one place that opens a
// path somebody else chose without waiting for a writer, looks at the handle it then reads, and sizes
// the buffer from it. This module used to carry a copy of that, and a second copy of a reader like that
// is a second chance to get it wrong, so what is left here is only what core does not do: a link is
// refused and not followed, and what core reports is put in the words the callers use.
// Writing one so that it is whole or not there: a temporary file next to it, and a rename.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRegularFile } from '@stroq/core';

export type SafeRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'refused';
      readonly why: 'not a regular file' | 'too large' | 'unreadable';
    };

const NOT_REGULAR: SafeRead = { kind: 'refused', why: 'not a regular file' };
const TOO_LARGE: SafeRead = { kind: 'refused', why: 'too large' };

/** What an open says to a path that does not lead to a file, and what it says to a link that loops. */
const ABSENT: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);
const NOT_A_FILE: ReadonlySet<string | undefined> = new Set(['EISDIR', 'ELOOP', 'EMLINK']);

/** What a call that failed means for a read: no file, not a file, or a file that cannot be had. */
function unreadable(err: unknown): SafeRead {
  const code = (err as NodeJS.ErrnoException).code;
  if (ABSENT.has(code)) return { kind: 'absent' };
  return NOT_A_FILE.has(code) ? NOT_REGULAR : { kind: 'refused', why: 'unreadable' };
}

/**
 * The text of the regular file at `path`, if it is one of at most `maxBytes`; that there is no file; or
 * why what is there is not read. Never throws.
 *
 * A link is refused, even to a file that would do: what sits where Stroq keeps its own file is read, or
 * it is not. The look at the path and the open that follows are two steps, so a link swapped in between
 * is followed by the open; what then comes back is still a regular file of a bounded size, read through
 * the handle that was checked, and the callers parse it strictly.
 */
export function readSmallRegularFile(path: string, maxBytes: number): SafeRead {
  try {
    if (lstatSync(path).isSymbolicLink()) return NOT_REGULAR;
  } catch (err) {
    return unreadable(err);
  }
  try {
    const read = readRegularFile(path, maxBytes);
    if (read.kind === 'text') return { kind: 'text', text: read.text };
    return read.kind === 'too-large' ? TOO_LARGE : NOT_REGULAR;
  } catch (err) {
    return unreadable(err);
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
