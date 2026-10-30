import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
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
 * What decoding invalid UTF-8 loosely leaves in its place. A planner that is handed text it cannot
 * tell was decoded loosely refuses a text that holds it, because writing that back would change
 * bytes the owner wrote.
 */
export const REPLACEMENT_CHARACTER = '\u{FFFD}';

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

/** JSON-safe identity used by private, prepared operations; never a filesystem attestation. */
export interface HardenFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly gid: string;
  readonly nlink: string;
  readonly mode: number;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export const fileIdentity = (stat: BigIntStats): HardenFileIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  uid: String(stat.uid),
  gid: String(stat.gid),
  nlink: String(stat.nlink),
  mode: Number(stat.mode),
  size: Number(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
});

export interface HardenFileSnapshot {
  readonly bytes: Buffer | null;
  readonly identity: HardenFileIdentity | null;
}

/** Exact same-descriptor read for the stricter prepared API. Does not follow a final link. */
export function readTargetSnapshot(
  path: string,
  maxBytes = MAX_TARGET_BYTES,
  privateMode = false,
): HardenFileSnapshot {
  const unsafe = (): never => {
    throw new HardenError('stale-plan', 'a prepared file is unsafe or changed while being read');
  };
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) return { bytes: null, identity: null };
  const valid = (s: BigIntStats): boolean =>
    s.isFile() &&
    !s.isSymbolicLink() &&
    s.ino !== 0n &&
    s.nlink === 1n &&
    (typeof process.getuid !== 'function' || s.uid === BigInt(process.getuid())) &&
    (!privateMode || (s.mode & 0o777n) === 0o600n);
  if (!valid(before)) unsafe();
  if (before.size > BigInt(maxBytes))
    throw new HardenError('target-too-large', 'a prepared file exceeds its bounded size');
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return unsafe();
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !valid(opened) ||
      JSON.stringify(fileIdentity(opened)) !== JSON.stringify(fileIdentity(before))
    )
      unsafe();
    const bytes = Buffer.alloc(Number(opened.size));
    let filled = 0;
    while (filled < bytes.length) {
      const count = readSync(fd, bytes, filled, bytes.length - filled, filled);
      if (!count) break;
      filled += count;
    }
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, bytes.length);
    const after = fstatSync(fd, { bigint: true });
    const found = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      filled !== bytes.length ||
      extra !== 0 ||
      found === undefined ||
      !valid(found) ||
      JSON.stringify(fileIdentity(opened)) !== JSON.stringify(fileIdentity(after)) ||
      JSON.stringify(fileIdentity(opened)) !== JSON.stringify(fileIdentity(found))
    )
      unsafe();
    return { bytes, identity: fileIdentity(opened) };
  } finally {
    closeSync(fd);
  }
}
