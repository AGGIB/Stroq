import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertStaysInside, realTarget, within } from '../commands/config-file.js';
import {
  danglingLinkIn,
  realSleep,
  renameWithRetry,
  sweepStaleTemps,
  tempNameFor,
} from './atomic-support.js';
import { isMissing } from './read.js';
import { HardenError, type Fs, type StatLike } from './types.js';

/**
 * Writing someone else's config file so that nobody, the owner and the owner's agent included,
 * can read half of it while Stroq is running: the new content goes into a temporary file, is
 * flushed, and then REPLACES the old one in a single rename. (If the operating system itself dies
 * a short file is still possible: see `writeFileAtomic`.)
 */

// The readers moved to `read.ts`; they are re-exported so that the engine has one place to ask.
export { MAX_TARGET_BYTES, readTargetText } from './read.js';

/** The mode of a file that has to be made, when nobody asks for another: the owner's alone. */
export const PRIVATE_FILE_MODE = 0o600;
const OWNER_WRITE = 0o200;
const MODE_BITS = 0o7777;

export const nodeFs: Fs = {
  stat: (path) => fsp.stat(path),
  mkdir: (path, options) => fsp.mkdir(path, options),
  open: (path, flags, mode) => fsp.open(path, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  chmod: (path, mode) => fsp.chmod(path, mode),
  readdir: (path) => fsp.readdir(path),
  rmdir: (path) => fsp.rmdir(path),
};

/** What a path has to pass before the engine writes to it or removes it. */
export interface WriteRules {
  /** The directory the file's REAL path must stay inside, a link in the path or not. */
  readonly root?: string;
  /**
   * Also apply the rule `stroq init` applies to the agent configs it writes: the file may resolve
   * anywhere inside the deepest of the working directory and the home directory that contains
   * it. On by default. Stroq's own files (its manifest, its copies) turn it off and name their
   * home as the root: that home may be a link on purpose, and nothing else points into it.
   */
  readonly initRule?: boolean;
}

export interface AtomicWriteOptions extends WriteRules {
  /** The mode of a file that does not exist yet. An existing file keeps its own. */
  readonly mode?: number;
  readonly fs?: Fs;
  /**
   * Called when the new content is in the temporary file and flushed, and before EVERY try to
   * replace the target: a rename that the system refuses for a moment is tried again after a wait,
   * and the file may have changed during it. If it throws (or rejects) nothing is replaced, no
   * further try is made, the temporary file is removed and the error is the one reported. It is
   * the last point at which a caller can look at the target again ("is it still what I read?"),
   * which narrows the window in which an edit the owner makes can be lost to the time between
   * that look and the rename. It does not close it: no portable call replaces an existing file only
   * if it is unchanged, and the rename that puts a new file in place does not refuse to replace
   * one that has appeared since (an exclusive create would, but not on every file system).
   */
  readonly beforeRename?: () => void | Promise<void>;
  /** Waits between the tries of a rename the system refuses for a moment. A test passes its own. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The clock (milliseconds) that the age of an old temporary file is judged by. */
  readonly now?: () => number;
}

export interface AtomicWriteResult {
  /** The file that was written: the target with every link in it followed. */
  readonly real: string;
  readonly created: boolean;
}

/**
 * The file `file` is, with every link followed, through the nearest part of the path that
 * exists, so that a file that is not made yet still gets the real directory it will be made in.
 * It is the function `stroq init` resolves its own writes with, so the two writers agree.
 */
export const resolveRealPath: (file: string) => string = realTarget;

/**
 * Refuses a path that a link carries out of the tree it belongs to, or that runs through a link
 * that points nowhere, and returns the real path it resolves to. Two rules can apply to the
 * tree: the root the caller named, which is the narrower and says more, and `init`'s, so that
 * every writer of an agent config in Stroq answers the same way about the same path. Touches
 * nothing, so it can be asked before anything else is done.
 */
export function assertWriteAllowed(target: string, rules: WriteRules = {}): string {
  const real = resolveRealPath(target);
  if (rules.root !== undefined && !within(real, resolveRealPath(rules.root))) {
    throw new HardenError(
      'path-escapes-root',
      `refusing to touch ${target}: it resolves to ${real}, outside ${rules.root}. A symlink in the path leads out of it; replace it with a regular file first.`,
    );
  }
  if (rules.initRule !== false) {
    try {
      assertStaysInside(target);
    } catch (err) {
      // The rule's own refusal has no `code`; a system error (a working directory that is gone)
      // has one, and is not a path leading anywhere.
      if (typeof (err as NodeJS.ErrnoException).code === 'string') throw err;
      throw new HardenError('path-escapes-root', err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }
  // After the tree rules: a link that leaves the tree is the more serious thing to say first.
  const dangling = danglingLinkIn(real);
  if (dangling !== null) {
    throw new HardenError(
      'dangling-link',
      `refusing to touch ${target}: ${dangling} is a link that points nowhere, and a file written there would be made somewhere else than the link says. Fix or remove the link first.`,
    );
  }
  return real;
}

async function statIfPresent(fs: Fs, path: string): Promise<StatLike | undefined> {
  try {
    return await fs.stat(path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/**
 * The directories leading to `dir` (and `dir` itself) that do not exist yet, innermost first.
 */
export async function missingDirsTo(fs: Fs, dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dir;
  for (;;) {
    const existing = await statIfPresent(fs, current);
    if (existing !== undefined) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

/**
 * Replaces `target` with `content`, atomically.
 *
 * - The target is resolved first and the REAL file is the one replaced, so a dotfile that is a
 *   link into `~/dotfiles` stays a link.
 * - The temporary file is made in the real file's own directory: a rename across file systems
 *   is a copy, and a copy is not atomic. Temporary files that an earlier hard stop left there
 *   (the exact name this makes, older than an hour) are removed first.
 * - The mode of the file it replaces is kept, whatever the umask. A new file is private.
 * - The content is flushed before the rename. If the process dies, at any point, the target is
 *   the old file or the new one, whole. If the operating system dies (a power cut, a kernel
 *   panic) a short or empty file is still possible: the flush is `fsync`, and on macOS `fsync`
 *   does not flush the drive's own cache (only `F_FULLFSYNC` does). The directory is not flushed
 *   either, which would decide whether the rename itself survives, not whether a file is whole.
 * - A rename that the system refuses for a moment (EPERM or EBUSY, as Windows does for a file
 *   another handle holds) is tried again, three tries in all.
 * - On any failure the temporary file is removed and the target has not been touched.
 *
 * A rename gives the path a new inode, so a hard link to the old file keeps the old content.
 * That is the price of never showing anyone a half-written file.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const fs = options.fs ?? nodeFs;
  const real = assertWriteAllowed(target, options);

  const existing = await statIfPresent(fs, real);
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new HardenError('not-regular-file', `refusing to replace ${real}: not a regular file`);
    }
    if ((existing.mode & OWNER_WRITE) === 0) {
      throw new HardenError(
        'read-only-target',
        `refusing to replace ${real}: it is read-only. Whoever set that did not want it edited; make it writable first if you do.`,
      );
    }
  }
  const mode =
    existing === undefined ? (options.mode ?? PRIVATE_FILE_MODE) : existing.mode & MODE_BITS;

  await fs.mkdir(dirname(real), { recursive: true });
  // Before the temporary file of this write exists, so that it can never be swept by mistake.
  await sweepStaleTemps(fs, dirname(real), basename(real), (options.now ?? Date.now)());
  const temp = join(
    dirname(real),
    tempNameFor(basename(real), process.pid, randomBytes(6).toString('hex')),
  );
  // `wx`, and private while it is written: whatever the final mode, nobody else reads the
  // content before it is in place.
  const handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE);
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    await handle.close();
    await renameWithRetry(fs, temp, real, options.sleep ?? realSleep, options.beforeRename);
  } catch (err) {
    // Best effort, and never allowed to hide what actually went wrong.
    await fs.unlink(temp).catch(() => undefined);
    throw err;
  }
  return { real, created: existing === undefined };
}

/** The mode of a directory the engine keeps for itself: the owner's alone. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Makes `dir` (and what is above it) and sets it to 0700, whatever the umask made of the mode given
 * to `mkdir` and whatever an older directory was left as. For Stroq's own directories only: ask
 * `assertWriteAllowed` first, because `mkdir` and `chmod` follow a link.
 */
export async function makePrivateDir(fs: Fs, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(dir, PRIVATE_DIR_MODE).catch(() => undefined);
}

/**
 * Removes a file the engine made, under the same rules as a write. Returns whether there was
 * a file to remove. `beforeRemove` is called when everything else has been checked and right
 * before the file goes, the last point at which a caller can look at it again; if it throws,
 * nothing is removed. As for a write, that narrows the window in which an edit can be lost and does
 * not close it.
 */
export async function removeFile(
  target: string,
  options: WriteRules & {
    readonly fs?: Fs;
    readonly beforeRemove?: () => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const fs = options.fs ?? nodeFs;
  const real = assertWriteAllowed(target, options);
  const existing = await statIfPresent(fs, real);
  if (existing === undefined) return false;
  if (!existing.isFile()) {
    throw new HardenError('not-regular-file', `refusing to remove ${real}: not a regular file`);
  }
  await options.beforeRemove?.();
  await fs.unlink(real);
  return true;
}

/**
 * Removes directories in `dirs` (deepest first) if they exist and are completely empty.
 * Never removes a directory that has anything in it or violates write rules.
 */
export async function removeEmptyDirs(
  dirs: readonly string[],
  options: WriteRules & {
    readonly fs?: Fs | undefined;
    readonly roots?: readonly string[] | undefined;
  } = {},
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const ordered = [...new Set(dirs)].sort((a, b) => b.length - a.length || b.localeCompare(a));
  for (const dir of ordered) {
    try {
      if (resolveRealPath(dir) !== dir) continue;
      if (options.roots !== undefined) {
        for (const root of options.roots) {
          assertWriteAllowed(dir, { ...options, root });
        }
      } else {
        assertWriteAllowed(dir, options);
      }
      await fs.rmdir(dir);
    } catch {
      // Best-effort cleanup: never let directory cleanup failure hide or break the caller.
    }
  }
}
