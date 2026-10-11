import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { withLock } from '@stroq/core';
import { z } from 'zod';
import { hardenDirIn, hardenManifestFileIn } from '../paths.js';
import { assertWriteAllowed, makePrivateDir, nodeFs, writeFileAtomic } from './atomic.js';
import { HardenError, ID_PATTERN, type HardenEnv, type RecordedEdit } from './types.js';

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
 * its directory is an error, and no part of a manifest that fails is ever used.
 */

export const MAX_MANIFEST_BYTES = 1024 * 1024;

const MANIFEST_MODE = 0o600;
const LOCK_NAME = 'manifest.lock';
/** Long enough for several applies queued behind one slow disk, short enough to be an error. */
const LOCK_TIMEOUT_MS = 30_000;
const MAX_ENTRIES_PER_FILE = 1_000;
const MAX_EDIT_PATH = 64;
const MAX_PREFIX_CHARS = 8;
const MAX_SUFFIX_CHARS = 2;
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

export interface Manifest {
  readonly version: 1;
  /** By real path. */
  readonly files: Readonly<Record<string, readonly ManifestEntry[]>>;
}

export const emptyManifest = (): Manifest => ({ version: 1, files: {} });

/**
 * The applies recorded for `real`, oldest first, or none. The manifest is an object keyed by
 * whatever path a caller names, and some names (`__proto__`, `constructor`) are properties of
 * every object: only the manifest's own keys count.
 */
export function entriesFor(manifest: Manifest, real: string): readonly ManifestEntry[] {
  return Object.hasOwn(manifest.files, real) ? (manifest.files[real] ?? []) : [];
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const editPath = z.array(z.string().min(1)).min(1).max(MAX_EDIT_PATH);
const createdFrom = z.number().int().min(0);
const pathFits = (edit: {
  readonly path: readonly string[];
  readonly createdFrom: number;
}): boolean => edit.createdFrom <= edit.path.length;

const editSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('json-array-add'),
      path: editPath,
      value: z.json(),
      preexisting: z.boolean(),
      createdFrom,
    })
    .refine(pathFits, 'createdFrom is past the end of the path'),
  z
    .strictObject({
      kind: z.literal('json-set'),
      path: editPath,
      value: z.json(),
      previous: z.discriminatedUnion('present', [
        z.strictObject({ present: z.literal(false) }),
        // `masked` is there only when the value was credential-shaped and was not written down.
        z.strictObject({
          present: z.literal(true),
          value: z.json(),
          masked: z.literal(true).optional(),
        }),
      ]),
      createdFrom,
    })
    .refine(pathFits, 'createdFrom is past the end of the path'),
  z
    .strictObject({
      kind: z.literal('text-block'),
      id: z.string().regex(ID_PATTERN),
      lines: z.array(z.string()),
      previous: z.array(z.string()).nullable(),
      // Nothing but the one or two line breaks that Stroq writes before an appended block.
      prefix: z
        .string()
        .max(MAX_PREFIX_CHARS)
        .regex(/^(?:\r?\n){0,2}$/),
      closesLastLine: z.boolean(),
      // Nothing but the one line break that Stroq writes after the end marker.
      suffix: z
        .string()
        .max(MAX_SUFFIX_CHARS)
        .regex(/^(?:\r?\n)?$/),
    })
    .refine(
      (edit) => !edit.closesLastLine || edit.prefix !== '',
      'a prefix that ends the last line cannot be empty',
    ),
]);

const absolutePath = z.string().refine((path) => isAbsolute(path), 'a path is absolute');

const entrySchema = z.strictObject({
  recipe: z.string().min(1).max(128),
  created: z.boolean(),
  real: absolutePath,
  root: absolutePath.nullable(),
  edits: z.array(editSchema),
  shaBefore: sha256Hex.nullable(),
  shaAfter: sha256Hex,
  backup: z.string().regex(ID_PATTERN).nullable(),
  stroqVersion: z.string().min(1).max(64),
  appliedAt: z.iso.datetime(),
});

const manifestSchema = z.strictObject({
  version: z.literal(1),
  files: z.record(
    z.string().refine((key) => isAbsolute(key), 'a file is named by its absolute path'),
    z.array(entrySchema).max(MAX_ENTRIES_PER_FILE),
  ),
});

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
 * Where the schema was not satisfied, as paths and never values: the manifest is a file that
 * could have been written by anything, and its contents do not belong in an error.
 */
function describeIssues(error: z.ZodError): string {
  const places = error.issues.slice(0, 3).map((issue) => JSON.stringify(issue.path));
  return `the manifest is not what Stroq writes (at ${places.join(', ')})`;
}

function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid('the manifest is not valid JSON');
  }
  if (nestedDeeperThan(raw, MAX_MANIFEST_DEPTH)) throw invalid(TOO_DEEP);
  const result = manifestSchema.safeParse(raw);
  if (!result.success) throw invalid(describeIssues(result.error));
  // A record quietly leaves out a key called `__proto__`. A manifest that names a file must not
  // be read as one that does not.
  const named = Object.keys((raw as { files: object }).files).length;
  if (Object.keys(result.data.files).length !== named) {
    throw invalid('the manifest names a file that cannot be read back');
  }
  return result.data as Manifest;
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
    return buffer.toString('utf8', 0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the manifest in `env.home`: an empty one when there is none. Throws a `HardenError`
 * (`manifest-unsafe`, `manifest-too-large`, `manifest-invalid`) for anything else that is not
 * exactly what the engine writes, and never returns part of a manifest.
 */
export function readManifest(env: HardenEnv): Manifest {
  const text = readManifestText(hardenManifestFileIn(env.home));
  return text === null ? emptyManifest() : parseManifest(text);
}

const byPath = (a: [string, unknown], b: [string, unknown]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/**
 * Writes the manifest, atomically and privately, with its files in path order so that two writes
 * of the same content are the same bytes. Refuses what it would refuse to read, and refuses to
 * write through a link: not one at the manifest itself, not one that makes its directory lead
 * out of the Stroq home.
 */
export async function writeManifest(env: HardenEnv, manifest: Manifest): Promise<void> {
  const written = {
    version: manifest.version,
    files: Object.fromEntries(Object.entries(manifest.files).sort(byPath)),
  };
  // Before anything walks it: `JSON.stringify` recurses too.
  if (nestedDeeperThan(written, MAX_MANIFEST_DEPTH)) throw invalid(TOO_DEEP);
  const text = `${JSON.stringify(written, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new HardenError('manifest-too-large', 'the manifest has grown past what it can be');
  }
  // What goes to disk is what the reader accepts, whatever the caller built.
  parseManifest(text);
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
  await makePrivateDir(fs, hardenDirIn(env.home));
  await writeFileAtomic(file, text, { ...rules, mode: MANIFEST_MODE, fs });
}

/**
 * Runs `fn` while holding the lock beside the manifest, so that two commands (two processes, or
 * two applies in one) never read the manifest, change it and write it over each other's work.
 */
export async function withManifestLock<T>(env: HardenEnv, fn: () => Promise<T>): Promise<T> {
  const fs = env.fs ?? nodeFs;
  const dir = hardenDirIn(env.home);
  const lock = join(dir, LOCK_NAME);
  // Asked first: the lock is made with `mkdir`, which would follow a link out of the home.
  assertWriteAllowed(lock, { root: env.home, initRule: false });
  await makePrivateDir(fs, dir);
  return withLock(lock, fn, { timeoutMs: LOCK_TIMEOUT_MS });
}
