// What `stroq vet --from <path>` has been given: a folder, or a file to be read as an archive.
//
// The path is resolved once (a link is followed here, once, as the folder reader follows the path it is
// given) and what it leads to is looked at with `lstat`. Nothing is opened: a FIFO, a socket or a device
// is neither, and is refused here before anything waits for it. The reader that is chosen then checks
// again what it opens, so a path that changes in between is a typed error and not a wrong reading.
import { lstat, realpath } from 'node:fs/promises';
import { errnoOf, ReadDirError } from './read-dir.js';

/** `dir` for a folder, and `tarball` for a file: the types of source in a passport that a path can be. */
export type SourceType = 'dir' | 'tarball';

const NOTHING_THERE = 'there is nothing at the path to read';

export async function sourceTypeOf(path: string): Promise<SourceType> {
  // `realpath('')` is the current folder, which is not what an empty path means.
  if (typeof path !== 'string' || path === '') throw new ReadDirError('not-found', NOTHING_THERE);
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT' || errno === 'ENOTDIR')
      throw new ReadDirError('not-found', NOTHING_THERE);
    throw new ReadDirError('unreadable', `the path could not be resolved (${errno})`);
  }
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT' || errno === 'ENOTDIR')
      throw new ReadDirError('not-found', NOTHING_THERE);
    throw new ReadDirError('unreadable', `the path could not be read (${errno})`);
  }
  if (info.isDirectory()) return 'dir';
  if (info.isFile()) return 'tarball';
  throw new ReadDirError('not-a-directory', 'the path is not a folder or a file');
}
