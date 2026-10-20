// Files a session or a repository named, opened so that none of them can hang the check.
//
// The folders `stroq sent` reads key files, MCP configs and git configs from are the folders
// sessions ran in, so what is in them was chosen by a repository or by the agent. A FIFO there
// makes a plain `open` wait for a writer that may never come, and a device such as `/dev/zero`
// never ends. So every file is opened with `O_NONBLOCK`, which opens a FIFO at once, and checked
// with `fstat` on the same handle before a byte is read: anything but a regular file is refused.
// On a regular file the flag changes nothing. Windows defines no such flag, and 0 leaves the open
// as it was.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

const FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** What reading the start of a file found. */
export type HeadRead =
  /** `cut`: the file holds more than was read. */
  | { readonly kind: 'text'; readonly text: string; readonly cut: boolean }
  | { readonly kind: 'missing' }
  | { readonly kind: 'folder' }
  /** A FIFO, a device or a socket: refused, and never read. */
  | { readonly kind: 'not-regular' }
  | { readonly kind: 'failed' };

const MISSING: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/** A regular file's handle, or why there is none. */
function openRegular(path: string): number | Exclude<HeadRead, { kind: 'text' }> {
  let fd: number;
  try {
    fd = openSync(path, FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (MISSING.has(code)) return { kind: 'missing' };
    return code === 'EISDIR' ? { kind: 'folder' } : { kind: 'failed' };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return fd;
    closeSync(fd);
    return stat.isDirectory() ? { kind: 'folder' } : { kind: 'not-regular' };
  } catch {
    closeSync(fd);
    return { kind: 'failed' };
  }
}

/** The first `maxBytes` of a regular file, and whether it holds more. */
export function readHead(path: string, maxBytes: number): HeadRead {
  const fd = openRegular(path);
  if (typeof fd !== 'number') return fd;
  try {
    const size = fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      if (n === 0) break;
      read += n;
    }
    return { kind: 'text', text: buffer.toString('utf8', 0, read), cut: size > maxBytes };
  } catch {
    return { kind: 'failed' };
  } finally {
    closeSync(fd);
  }
}

/** A whole regular file of at most `maxBytes`, or null for anything else. */
export function readSmall(path: string, maxBytes: number): string | null {
  const read = readHead(path, maxBytes);
  return read.kind === 'text' && !read.cut ? read.text : null;
}

/** A regular file opened for reading, or null: missing, not a regular file, or not readable. */
export function openRegularFile(path: string): number | null {
  const fd = openRegular(path);
  return typeof fd === 'number' ? fd : null;
}

/** `openRegularFile` for a reader that reads with promises. */
export async function openRegularHandle(path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, FLAGS);
  } catch {
    return null;
  }
  try {
    if ((await handle.stat()).isFile()) return handle;
  } catch {
    // Not readable: refused like anything else that is not a regular file.
  }
  await handle.close();
  return null;
}
