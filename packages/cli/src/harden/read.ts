import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { HardenError } from './types.js';

/**
 * Reading the files the engine edits. The bytes come first, because they are what a copy and a
 * "has it changed?" comparison must be made of; the text is a decoding of them, and it is strict
 * wherever the engine would write what it decoded back.
 */

/**
 * The most a file this engine edits may be. It is the bound `readConfigText` puts on an agent
 * config: real ones are a few kilobytes, and the bound is there so that a file which is not one
 * cannot take the process down.
 */
export const MAX_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * `O_NONBLOCK` so that opening a FIFO returns at once instead of waiting for a writer that may
 * never come; the handle is then refused as not a regular file. On a regular file the flag
 * changes nothing, and Windows defines no such constant.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * The bytes of a file the engine is about to edit, or `null` when there is no such file. Only a
 * regular file within `MAX_TARGET_BYTES` is read, and the check is made on the handle that is
 * then read: a FIFO planted where a config goes would otherwise block this forever, and a path
 * re-pointed between a check and a read would be a different file.
 */
export function readTargetBytes(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    if (isMissing(err)) return null;
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
      throw new HardenError('not-regular-file', `${path} is not a regular file`, { cause: err });
    }
    throw err;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new HardenError('not-regular-file', `${path} is not a regular file`);
    if (stats.size > MAX_TARGET_BYTES) {
      throw new HardenError(
        'target-too-large',
        `${path} is ${stats.size} bytes, more than an agent config is`,
      );
    }
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * The text of a file, decoded loosely: bytes that are not UTF-8 become U+FFFD. It is what a
 * planner reads (and then refuses a file with a U+FFFD in it, which it cannot write back as it
 * was). Use `readTargetStrict` where the result is going to be written.
 */
export function readTargetText(path: string): string | null {
  const bytes = readTargetBytes(path);
  return bytes === null ? null : bytes.toString('utf8');
}

/**
 * `ignoreBOM: true` keeps a byte order mark in the text as U+FEFF, as `Buffer.toString` does; the
 * default would drop it, and a file written back without its mark is not the file it was.
 */
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * `bytes` as text, or a `not-utf8` error that names `path` and never quotes a byte: decoding
 * loosely and writing the result would replace what the owner wrote with U+FFFD.
 */
export function decodeUtf8Strict(bytes: Uint8Array, path: string): string {
  try {
    return STRICT.decode(bytes);
  } catch (err) {
    throw new HardenError(
      'not-utf8',
      `${path} is not valid UTF-8, so Stroq will not rewrite it: it would change bytes the owner wrote`,
      { cause: err },
    );
  }
}

/** The text of a file that must be valid UTF-8, or `null` when there is no such file. */
export function readTargetStrict(path: string): string | null {
  const bytes = readTargetBytes(path);
  return bytes === null ? null : decodeUtf8Strict(bytes, path);
}

/** Whether two reads of a file saw the same thing. A file that is missing is not an empty one. */
export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && Buffer.compare(a, b) === 0;
}
