import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { assertStaysInside } from '../commands/config-file.js';
import { HardenError, type Fs, type StatLike } from './types.js';

/**
 * Writing someone else's config file so that nobody, the owner and the owner's agent included,
 * can ever read half of it: the new content goes into a temporary file, is flushed, and then
 * REPLACES the old one in a single rename.
 */

/**
 * The most a file this engine edits may be. It is the bound `readConfigText` puts on an agent
 * config: real ones are a few kilobytes, and the bound is there so that a file which is not one
 * cannot take the process down.
 */
export const MAX_TARGET_BYTES = 4 * 1024 * 1024;

/** The mode of a file that has to be made, when nobody asks for another: the owner's alone. */
const PRIVATE_FILE_MODE = 0o600;
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

export interface AtomicWriteOptions {
  /**
   * The directory the file's REAL path must stay inside. Without one, the rule `stroq init`
   * applies to the agent configs it writes holds: the file may resolve anywhere inside the
   * deepest of the working directory and the home directory that contains it.
   */
  readonly root?: string;
  /** The mode of a file that does not exist yet. An existing file keeps its own. */
  readonly mode?: number;
  readonly fs?: Fs;
}

export interface AtomicWriteResult {
  /** The file that was written: the target with every link in it followed. */
  readonly real: string;
  readonly created: boolean;
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const within = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The file `file` is, with every link followed, through the nearest part of the path that
 * exists, so that a file that is not made yet still gets the real directory it will be made in.
 * A link that points nowhere is not followed: it is where the file goes.
 */
export function resolveRealPath(file: string): string {
  const pending: string[] = [];
  let at = resolve(file);
  for (;;) {
    try {
      return resolve(realpathSync(at), ...pending);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(file);
      pending.unshift(basename(at));
      at = parent;
    }
  }
}

/**
 * The text of a file the engine is about to edit, or `null` when there is no such file. Only a
 * regular file within `MAX_TARGET_BYTES` is read, and the check is made on the handle that is
 * then read: a FIFO planted where a config goes would otherwise block this forever.
 */
export function readTargetText(path: string): string | null {
  let read: ReturnType<typeof readRegularFile>;
  try {
    read = readRegularFile(path, MAX_TARGET_BYTES);
  } catch (err) {
    if (isMissing(err)) return null;
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new HardenError('not-regular-file', `${path} is not a regular file`, { cause: err });
    }
    throw err;
  }
  if (read.kind === 'not-regular') {
    throw new HardenError('not-regular-file', `${path} is not a regular file`);
  }
  if (read.kind === 'too-large') {
    throw new HardenError(
      'target-too-large',
      `${path} is ${read.size} bytes, more than an agent config is`,
    );
  }
  return read.text;
}

/**
 * Refuses a path that a link carries out of the tree it belongs to. Both rules apply: the root
 * the caller named, which is the narrower and says more, and `init`'s, so that every writer in
 * Stroq answers the same way about the same path.
 */
function assertAllowed(target: string, real: string, root: string | undefined): void {
  if (root !== undefined && !within(real, resolveRealPath(root))) {
    throw new HardenError(
      'path-escapes-root',
      `refusing to touch ${target}: it resolves to ${real}, outside ${root}. A symlink in the path leads out of it; replace it with a regular file first.`,
    );
  }
  try {
    assertStaysInside(target);
  } catch (err) {
    throw new HardenError('path-escapes-root', err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
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
 * Replaces `target` with `content`, atomically.
 *
 * - The target is resolved first and the REAL file is the one replaced, so a dotfile that is a
 *   link into `~/dotfiles` stays a link.
 * - The temporary file is made in the real file's own directory: a rename across file systems
 *   is a copy, and a copy is not atomic.
 * - The mode of the file it replaces is kept, whatever the umask. A new file is private.
 * - The content is flushed before the rename. A crash leaves the old file or the new one, whole.
 *   (The directory is not flushed too: that would decide whether the rename survives a power
 *   cut, not whether either file is whole.)
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
  const real = resolveRealPath(target);
  assertAllowed(target, real, options.root);

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
  const temp = join(
    dirname(real),
    `.${basename(real)}.stroq-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
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
    await fs.rename(temp, real);
  } catch (err) {
    // Best effort, and never allowed to hide what actually went wrong.
    await fs.unlink(temp).catch(() => undefined);
    throw err;
  }
  return { real, created: existing === undefined };
}

/**
 * Removes a file the engine made, under the same rules as a write. Returns whether there was
 * a file to remove.
 */
export async function removeFile(
  target: string,
  options: { readonly root?: string; readonly fs?: Fs } = {},
): Promise<boolean> {
  const fs = options.fs ?? nodeFs;
  const real = resolveRealPath(target);
  assertAllowed(target, real, options.root);
  const existing = await statIfPresent(fs, real);
  if (existing === undefined) return false;
  if (!existing.isFile()) {
    throw new HardenError('not-regular-file', `refusing to remove ${real}: not a regular file`);
  }
  await fs.unlink(real);
  return true;
}
