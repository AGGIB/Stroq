// Why an archive was not read. One class for every reader of an archive (the gzip layer, the tar
// reader, the reader of a file), so that a caller has one thing to catch and one list of reasons.
import type { TreeErrorCode } from './tree.js';

export type ArchiveErrorCode =
  /** The path names nothing. */
  | 'not-found'
  /** The path names something that is not a regular file. */
  | 'not-a-file'
  /** A file that the operating system will not let this process read. */
  | 'unreadable'
  /** The file is not what it was a moment ago: a link where a file was, a file that grew or shrank. */
  | 'changed'
  /** The gzip layer is damaged, cut short, has more than one member or has data after it. */
  | 'bad-gzip'
  /** The bytes are not a tar archive (a zip file, a text, a gzip of something else). */
  | 'not-a-tar'
  /** A tar archive that is cut short or whose headers do not hold together. */
  | 'corrupt'
  /** A tar archive of a kind this reader does not read: links, devices, sparse files. */
  | 'unsupported'
  /** Over a limit of `LIMITS`, or one that was asked for. */
  | 'limit'
  /** A name or a tree that is refused: a path that is not safe, a path twice, names that are one name on some disks. */
  | 'refused'
  /** An archive with no files in it. */
  | 'empty';

/**
 * Why an archive could not be read. `message` is a fixed phrase and never repeats a name from the
 * archive as it is: a name that has to be said is quoted and written out (`quotePath`), and most
 * messages do not say one. `treeCode` is the code of the `TreeError` behind a refusal or a limit of
 * the tree, when there is one.
 */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly treeCode: TreeErrorCode | null;

  constructor(code: ArchiveErrorCode, message: string, treeCode: TreeErrorCode | null = null) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.treeCode = treeCode;
  }
}
