import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '@stroq/core';
import { hardenDirIn, hardenManifestFileIn } from '../paths.js';
import {
  assertWriteAllowed,
  makePrivateDir,
  nodeFs,
  removeFile,
  writeFileAtomic,
} from './atomic.js';
import { HardenError, type HardenEnv, type RecordedEdit } from './types.js';
import { decodeUtf8Strict, readTargetSnapshot, type HardenFileIdentity } from './read.js';
import { findLossyJson } from './json-lossy.js';
import { manifestSchema } from './manifest-schema.js';
import {
  MANIFEST_VERSION,
  assertSigned,
  signedManifestText,
  signingKey,
  unsignedManifest,
  verifyingKey,
} from './manifest-seal.js';
import { sha256Text } from './types.js';

/**
 * What `stroq harden` remembers about the files it changed: for each real path, one entry per
 * apply, newest last. It is what lets undo find the entries Stroq added (and the copy of the file
 * from before them) long after the command that added them has gone.
 *
 * A file Stroq trusts to say what to delete and what to restore had better be read strictly. This
 * one is private (0600, in a 0700 directory), is only read after its open handle matches a regular,
 * non-link file entry (a link in a directory above it is allowed, and the write side checks that
 * it stays inside the home), is refused above 1 MiB, and is accepted only if all of it is exactly
 * what the engine writes: an unknown key, a sha that is not a sha or a copy id that climbs out of
 * its directory is an error (`manifest-schema.ts`), and no part of a manifest that fails is ever
 * used. It is also signed under the home's state key (`manifest-seal.ts`): one that this home did not
 * sign, and one from before manifests were signed, is refused before anything is restored or removed.
 */

export const MAX_MANIFEST_BYTES = 1024 * 1024;

const MANIFEST_MODE = 0o600;
const LOCK_NAME = 'manifest.lock';
/** Long enough for several applies queued behind one slow disk, short enough to be an error. */
const LOCK_TIMEOUT_MS = 30_000;
/**
 * Deeper than any manifest the engine writes: its own structure is six levels, and a value a
 * recipe asked to have recorded is at most 64 more. The schema that checks a recorded value
 * recurses, so a document nested far deeper than this is refused before it is handed to it.
 */
const MAX_MANIFEST_DEPTH = 96;

export interface ManifestEntry {
  /** The recipe that asked for the change. */
  readonly recipe: string;
  /** The file did not exist before this apply: undo removes it if it is still only Stroq's. */
  readonly created: boolean;
  /** The directories this apply created because they did not exist, innermost first. */
  readonly createdDirs?: readonly string[];
  /**
   * The real path of the file when it was changed, links followed. It is also the key the entry is
   * filed under; undo refuses to act on a path that no longer leads to it.
   */
  readonly real: string;
  /**
   * The real path of the directory the file had to stay inside when it was changed, or `null`
   * if the plan named none. Undo keeps to it whatever the caller says.
   */
  readonly root: string | null;
  readonly edits: readonly RecordedEdit[];
  /** SHA-256 of the file before (`null` if it did not exist) and after. */
  readonly shaBefore: string | null;
  readonly shaAfter: string;
  /** The id of the byte copy, or `null` when none was kept. */
  readonly backup: string | null;
  readonly stroqVersion: string;
  readonly appliedAt: string;
}

/** Version 2 is signed on disk; the signature is not part of what is read. */
export interface Manifest {
  readonly version: 2;
  /** By real path. */
  readonly files: Readonly<Record<string, readonly ManifestEntry[]>>;
}

export const emptyManifest = (): Manifest => ({ version: MANIFEST_VERSION, files: {} });

/**
 * The applies recorded for `real`, oldest first, or none. The manifest is an object keyed by
 * whatever path a caller names, and some names (`__proto__`, `constructor`) are properties of
 * every object: only the manifest's own keys count.
 */
export function entriesFor(manifest: Manifest, real: string): readonly ManifestEntry[] {
  return Object.hasOwn(manifest.files, real) ? (manifest.files[real] ?? []) : [];
}

const invalid = (message: string): HardenError => new HardenError('manifest-invalid', message);

/**
 * Whether `root` is nested more than `limit` levels deep. Walked with a stack of its own, so that
 * the answer for a document nested a hundred thousand deep is "yes" and not a stack overflow, and
 * stopped as soon as it is yes, so that a structure that contains itself is no trouble either.
 */
function nestedDeeperThan(root: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[root, 1]];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const [value, depth] = item;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(value) ? (value as unknown[]) : Object.values(value)) {
      pending.push([child, depth + 1]);
    }
  }
  return false;
}

const TOO_DEEP = 'the manifest is nested deeper than Stroq writes it';

/**
 * Schema paths can themselves contain private source names. Neither paths nor values belong
 * in an error projected by a prepared operation.
 */
function describeIssues(): string {
  return 'the manifest is not what Stroq writes';
}

/**
 * The manifest in `text`, read from `file`. Its structure is checked first, so a document that is not
 * a manifest at all is `manifest-invalid`; then one from before signing is `manifest-unsigned`, and one
 * whose tag `key()` does not make is `manifest-unverified`.
 */
function parseManifest(text: string, file: string, key: () => Buffer): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid('the manifest is not valid JSON');
  }
  if (findLossyJson(text) !== null) throw invalid('the manifest contains ambiguous or lossy JSON');
  if (nestedDeeperThan(raw, MAX_MANIFEST_DEPTH)) throw invalid(TOO_DEEP);
  const result = manifestSchema.safeParse(raw);
  if (!result.success) throw invalid(describeIssues());
  // A record quietly leaves out a key called `__proto__`. A manifest that names a file must not
  // be read as one that does not.
  const files = (raw as { files: object }).files;
  if (Object.keys(result.data.files).length !== Object.keys(files).length) {
    throw invalid('the manifest names a file that cannot be read back');
  }
  if (result.data.version === 1) throw unsignedManifest(file);
  // The tag is checked against the files as they were read, not as the schema returned them.
  assertSigned(file, key(), files, result.data.mac);
  return { version: MANIFEST_VERSION, files: result.data.files } as Manifest;
}

function unsafe(file: string, why: string): HardenError {
  return new HardenError('manifest-unsafe', `${file} ${why}; Stroq does not use it`);
}

/**
 * The manifest's text, or `null` when there is none. Open first, then validate and read the same
 * descriptor. `O_NOFOLLOW` rejects links at open where available; matching the descriptor's
 * identity to a non-link path entry before reading also covers platforms without that flag.
 * A later path swap cannot change the descriptor. A link in a directory above it is not checked
 * here. `O_NONBLOCK` keeps a FIFO from waiting for a writer on platforms with named pipes.
 */
function readManifestText(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw unsafe(file, 'is a link');
    if (code === 'EISDIR') throw unsafe(file, 'is not a regular file');
    if (code === 'ENOENT') {
      // Without O_NOFOLLOW a dangling link also produces ENOENT. Only an absent entry is empty.
      if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) {
        throw unsafe(file, 'could not be opened as a regular file');
      }
      return null;
    }
    throw err;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw unsafe(file, 'is not a regular file');
    if (opened.size > BigInt(MAX_MANIFEST_BYTES)) {
      throw new HardenError('manifest-too-large', `${file} is larger than a manifest can be`);
    }
    if (opened.ino === 0n) throw unsafe(file, 'has no verifiable file identity');
    const found = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (
      found === undefined ||
      found.isSymbolicLink() ||
      !found.isFile() ||
      found.dev !== opened.dev ||
      found.ino !== opened.ino
    ) {
      throw unsafe(file, 'no longer names the regular file that was opened');
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return decodeUtf8Strict(buffer.subarray(0, filled), file);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the manifest in `env.home`: an empty one when there is none. Throws a `HardenError`
 * (`manifest-unsafe`, `manifest-too-large`, `manifest-invalid`, `manifest-unsigned`,
 * `manifest-unverified`) for anything else that is not exactly what the engine writes and this home
 * signed, and never returns part of a manifest.
 */
export function readManifest(env: HardenEnv): Manifest {
  const file = hardenManifestFileIn(env.home);
  const text = readManifestText(file);
  return text === null
    ? emptyManifest()
    : parseManifest(text, file, () => verifyingKey(env.home, file));
}

export interface ManifestSnapshot {
  readonly manifest: Manifest;
  readonly bytes: Buffer | null;
  readonly sha256: string | null;
  readonly identity: HardenFileIdentity | null;
}
export type ManifestSnapshotBinding = Pick<ManifestSnapshot, 'sha256' | 'identity'>;
export function assertManifestSnapshot(env: HardenEnv, expected: ManifestSnapshotBinding): void {
  const actual = readManifestSnapshot(env);
  if (
    actual.sha256 !== expected.sha256 ||
    JSON.stringify(actual.identity) !== JSON.stringify(expected.identity)
  )
    throw new HardenError(
      'stale-plan',
      'the prepared manifest changed; prepare the operation again',
    );
}

/** Exact private bytes and parsed records from one bounded, stable descriptor. No writes. */
export function readManifestSnapshot(env: HardenEnv): ManifestSnapshot {
  const file = hardenManifestFileIn(env.home);
  const captured = readTargetSnapshot(file, MAX_MANIFEST_BYTES, true);
  const text = captured.bytes === null ? null : decodeUtf8Strict(captured.bytes, file);
  return {
    ...captured,
    manifest:
      text === null
        ? emptyManifest()
        : parseManifest(text, file, () => verifyingKey(env.home, file)),
    sha256: text === null ? null : sha256Text(text),
  };
}

const byPath = (a: [string, unknown], b: [string, unknown]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/**
 * Writes the manifest, atomically and privately, signed under the home's state key (made on first
 * use), with its files in path order so that two writes of the same content are the same bytes.
 * Refuses what it would refuse to read, and refuses to write through a link: not one at the
 * manifest itself, not one that makes its directory lead out of the Stroq home.
 */
export async function writeManifest(
  env: HardenEnv,
  manifest: Manifest,
  expected?: ManifestSnapshotBinding,
): Promise<void> {
  if (expected) assertManifestSnapshot(env, expected);
  const files = Object.fromEntries(Object.entries(manifest.files).sort(byPath));
  // Before anything walks it: `JSON.stringify` recurses too.
  if (nestedDeeperThan({ version: MANIFEST_VERSION, files }, MAX_MANIFEST_DEPTH))
    throw invalid(TOO_DEEP);
  const fs = env.fs ?? nodeFs;
  const file = hardenManifestFileIn(env.home);
  const rules = { root: env.home, initRule: false } as const;
  try {
    const found = lstatSync(file);
    if (found.isSymbolicLink() || !found.isFile()) throw unsafe(file, 'is not a regular file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  assertWriteAllowed(file, rules);
  const key = signingKey(env.home, file);
  const text = signedManifestText(files, key);
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new HardenError('manifest-too-large', 'the manifest has grown past what it can be');
  }
  // What goes to disk is what the reader accepts, whatever the caller built.
  parseManifest(text, file, () => key);
  await makePrivateDir(fs, hardenDirIn(env.home));
  await writeFileAtomic(file, text, {
    ...rules,
    mode: MANIFEST_MODE,
    fs,
    ...(expected ? { beforeRename: () => assertManifestSnapshot(env, expected) } : {}),
  });
}

/**
 * Removes the manifest file, when an apply is taken back after failing to put the file in place.
 */
export async function removeManifest(
  env: HardenEnv,
  expected?: ManifestSnapshotBinding,
): Promise<void> {
  if (expected) assertManifestSnapshot(env, expected);
  const file = hardenManifestFileIn(env.home);
  const rules = { root: env.home, initRule: false } as const;
  try {
    const found = lstatSync(file);
    if (found.isSymbolicLink() || !found.isFile()) throw unsafe(file, 'is not a regular file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  assertWriteAllowed(file, rules);
  const fs = env.fs ?? nodeFs;
  await removeFile(file, {
    ...rules,
    fs,
    ...(expected ? { beforeRemove: () => assertManifestSnapshot(env, expected) } : {}),
  });
}

/**
 * Runs `fn` while holding the lock beside the manifest, so that two commands (two processes, or
 * two applies in one) never read the manifest, change it and write it over each other's work.
 */
export async function withManifestLock<T>(
  env: HardenEnv,
  fn: () => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  const fs = env.fs ?? nodeFs;
  const dir = hardenDirIn(env.home);
  const lock = join(dir, LOCK_NAME);
  // Asked first: the lock is made with `mkdir`, which would follow a link out of the home.
  assertWriteAllowed(lock, { root: env.home, initRule: false });
  await makePrivateDir(fs, dir);
  return withLock(lock, fn, { timeoutMs: options.timeoutMs ?? LOCK_TIMEOUT_MS });
}
