// An archive on this machine, read into the in-memory tree of Safe Install (`stroq vet --from <file>`).
//
// The file is somebody else's, so it is read as a hostile input, the way the folder reader reads a file:
// the path is resolved once, and the file is opened once, with `O_NOFOLLOW` where the platform has it
// (so a link swapped in after the path was resolved is not followed) and `O_NONBLOCK` (so that a FIFO
// swapped in does not wait for a writer). What is checked is the descriptor and not the name: it has to
// be a regular file, and it is read through that one descriptor into a buffer of the size it said, which
// has to be the size it still is when the reading is done.
//
// Whether it is gzip is decided by its first two bytes, never by its name, and the size that is allowed
// follows from that: the size of a download for a gzip file, the size of an expanded archive for a plain
// one. A file over its size is refused before a byte of it is read. The bytes then go to `readTarArchive`,
// which holds them to the limits again, for the callers that have bytes and no file.
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { ArchiveError } from './archive-error.js';
import { isGzip } from './archive-gzip.js';
import {
  heldLimits,
  readTarArchive,
  type ArchiveOptions,
  type ArchiveRead,
  type HeldLimits,
} from './archive-tar.js';
import { errnoOf } from './read-dir.js';

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const NOTHING_THERE = 'there is nothing at the path to read';

/** The refusal for a failed call of the file system. The message holds an errno and never a path. */
function failure(error: unknown): ArchiveError {
  if (error instanceof ArchiveError) return error;
  const errno = errnoOf(error);
  if (errno === 'ENOENT' || errno === 'ENOTDIR')
    return new ArchiveError('not-found', NOTHING_THERE);
  if (errno === 'ELOOP') {
    return new ArchiveError('changed', 'the archive file became a link while it was read');
  }
  return new ArchiveError('unreadable', `the archive file could not be read (${errno})`);
}

/** The path, resolved once. `realpath('')` is the current folder, which is not what an empty path means. */
async function resolveOnce(path: string): Promise<string> {
  if (typeof path !== 'string' || path === '') throw new ArchiveError('not-found', NOTHING_THERE);
  try {
    return await realpath(path);
  } catch (error) {
    throw failure(error);
  }
}

/** Reads exactly `size` bytes, and checks that the file ends there. */
async function readExactly(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  // One byte past the end: a file that has grown is not the file that was measured.
  const extra = filled === size ? await handle.read(new Uint8Array(1), 0, 1, size) : null;
  if (filled !== size || (extra?.bytesRead ?? 0) > 0) {
    throw new ArchiveError('changed', 'the archive file changed size while it was read');
  }
  return bytes;
}

async function readBytes(path: string, limits: HeldLimits): Promise<Uint8Array> {
  const resolved = await resolveOnce(path);
  let handle: FileHandle;
  try {
    handle = await open(resolved, OPEN_FLAGS);
  } catch (error) {
    throw failure(error);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new ArchiveError('not-a-file', 'the path is not a regular file');
    // The first two bytes say which size the file is held to.
    const head = new Uint8Array(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    const gzipped = isGzip(head.subarray(0, bytesRead));
    const cap = gzipped ? limits.maxCompressed : limits.maxExpanded;
    if (info.size > BigInt(cap)) {
      throw new ArchiveError(
        'limit',
        gzipped
          ? `the compressed archive file is over ${cap} bytes`
          : `the archive file is over ${cap} bytes`,
      );
    }
    return await readExactly(handle, Number(info.size));
  } catch (error) {
    throw failure(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The tree of the archive file at `path` (plain tar or gzip, told by its bytes), what was not looked at,
 * and the folder that wrapped the files. Throws an `ArchiveError`; its message holds no path.
 */
export async function readArchiveFile(
  path: string,
  options: ArchiveOptions = {},
): Promise<ArchiveRead> {
  const bytes = await readBytes(path, heldLimits(options.limits));
  return readTarArchive(bytes, options);
}
