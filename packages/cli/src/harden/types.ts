/**
 * What `stroq harden`'s edit engine shares between its parts: the typed error, the small file
 * system seam, and the environment every operation takes.
 *
 * The engine edits files that belong to someone else (an agent's settings, an ignore file), so
 * it has to be able to show a diff, take a copy, write without a half-written moment, and undo
 * without clobbering what the owner did afterwards. Nothing here knows about a particular
 * recipe: those come later and only choose which edits to ask for.
 */

/**
 * Why the engine refused or failed, as a value a caller can branch on. A message is for a
 * person; the code is for the command that prints it.
 */
export type HardenErrorCode =
  /** The file's real path leaves the tree it was allowed to be written in (a symlink led out). */
  | 'path-escapes-root'
  /** The target is a directory, a FIFO, a device: something that is not a regular file. */
  | 'not-regular-file'
  /** The target is larger than any agent config is. */
  | 'target-too-large'
  /** The target has no write bit for its owner: whoever set that did not want it edited. */
  | 'read-only-target'
  /** The inputs of a diff are bigger than the preview is willing to compute. */
  | 'diff-too-large';

export class HardenError extends Error {
  readonly code: HardenErrorCode;

  constructor(code: HardenErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'HardenError';
    this.code = code;
  }
}

/** What a stat answers that the engine looks at. `fs.Stats` satisfies it. */
export interface StatLike {
  readonly mode: number;
  isFile(): boolean;
}

/** The part of a file handle an atomic write uses. `fs.promises.FileHandle` satisfies it. */
export interface FileHandleLike {
  writeFile(data: string | Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The file system operations the engine WRITES with, and nothing else. It exists so that a test
 * can make one of them fail (the rename that would have put a half-edited file in place) and
 * then look at what is left on disk. Reading goes through `readRegularFile`, which is not
 * injectable because no test needs a read to fail.
 */
export interface Fs {
  stat(path: string): Promise<StatLike>;
  mkdir(
    path: string,
    options: { readonly recursive: true; readonly mode?: number },
  ): Promise<unknown>;
  open(path: string, flags: string, mode: number): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
}

/**
 * Passed to every operation, so that a test never touches the real home: `home` is a Stroq home
 * directory (`stroqHome()` in the product, a temp directory in a test).
 */
export interface HardenEnv {
  readonly home: string;
  readonly now: () => Date;
  /** The Stroq version recorded with what was changed. */
  readonly version: string;
  readonly fs?: Fs;
}
