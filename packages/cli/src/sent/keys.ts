// The keys `stroq sent` looks for, held in memory and nowhere else.
//
// They come from the same places the live guard's index reads: `~/.aws/credentials`,
// `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`, the `.env*` files of each project folder
// (not `.env.example` and the like), and credential-shaped variables in the environment
// this command runs with. The rules for what counts as a key are the core's own
// (`extractSourceSecretsWhole`, `extractEnv`), so the two can never disagree. Canaries planted
// with `stroq canary` are read too, from the decoy files it planted (`canaries.ts`).
//
// The folders sessions ran in hold `.env` files a repository or the agent wrote, and the agent
// can append to the user's own. So no key is left out in silence. The home files, the decoys and
// the environment are taken first, and each folder may add only so many keys of its own: one
// folder's junk cannot push out the user's keys or another folder's. A file is read whole, past
// the limits of the live index's extractor, up to a size. Whatever is still left out (a file past
// that size, keys past a cap, `.env` files past the number read in a folder) is counted and named,
// and the report says the comparison was not complete.
//
// Unlike the index, nothing is written: no `~/.stroq/secrets.json`, no temporary copy.
// A value lives in this process for the length of the run, and is never printed, stored,
// or put into an error message. A file that cannot be read is counted, not described.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOME_SECRET_SOURCES,
  displayPath,
  extractEnv,
  extractSourceSecretsWhole,
  projectEnvFiles,
} from '@stroq/core';
import {
  CANARY_PREFIX,
  canariesIn,
  canariesNotFound,
  decoyFiles,
  isCanaryValue,
} from './canaries.js';
import { keyName } from './names.js';
import { keyForms, textMatcher } from './needles.js';
import { pieceTable } from './pieces.js';
import { readHead } from './regular-file.js';

/** One key this machine holds: its name, where it was read from, and the value to look for. */
export interface Key {
  /** As the file or the environment names it, e.g. `aws_secret_access_key`. */
  readonly name: string;
  /** `~/.aws/credentials`, a project's `.env` path, or `env`. */
  readonly source: string;
  /** Never printed, stored or put in a message. */
  readonly value: string;
  /** A canary planted with `stroq canary`: a decoy, not a key to rotate. */
  readonly canary?: true;
  /** Every other place the same value was read: other key files, or `env`. Never printed. */
  readonly alsoIn?: readonly string[];
}

export interface KeySet {
  readonly keys: readonly Key[];
  /** The files that gave at least one key, as a report shows a path. */
  readonly files: readonly string[];
  /** Every source file that was read, as an absolute path. */
  readonly paths: readonly string[];
  /** How many keys came from the environment only. */
  readonly envKeys: number;
  /** Files that exist but could not be read. */
  readonly unreadable: number;
  /** True when keys were found but left out by a cap: of one folder, or of the whole run. */
  readonly truncated: boolean;
  /**
   * Key files not read whole, as a report shows a path: larger than `MAX_KEY_FILE_BYTES`, past
   * what their reader reads, or holding keys left out by a cap.
   */
  readonly partial: readonly string[];
  /** `.env` files not read at all: past `MAX_FOLDER_ENV_FILES` in their folder. */
  readonly skippedFiles: number;
  /** Lines named like a key whose value is not compared: too short, a placeholder, a path. */
  readonly rejectedLines: number;
  /** Env files one folder below a project folder read, which are not read. */
  readonly subfolderEnvFiles: number;
  /** Canaries `stroq canary` planted whose value is in no file read: not looked for. */
  readonly canariesNotFound: number;
  /**
   * Session files whose check for planted canaries was cut short: they held more values of a
   * canary's shape than are hashed in one file, which may be tampering.
   */
  readonly canaryCheckCut?: number;
}

export interface KeySources {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Project folders whose `.env*` files are read, in order; repeats are read once. */
  readonly projectDirs: readonly string[];
  /** Stroq's own folder, for the canaries `stroq canary` planted. None are read without it. */
  readonly stroqHome?: string;
}

/** Cap on keys held: what the matcher stays fast with over every session on a machine. */
export const MAX_KEYS = 10_000;
/** Cap on the keys one project folder's `.env` files may add. */
export const MAX_FOLDER_KEYS = 2_000;
/** A key file is read up to this size; past it, the rest is not read, and that is said. */
export const MAX_KEY_FILE_BYTES = 4 * 1024 * 1024;
/** `.env` files read in one folder, by name; past it, the rest are counted and not read. */
export const MAX_FOLDER_ENV_FILES = 256;
/**
 * Bytes of `.env` files read in one folder, all of them together: a folder of many large files is
 * read to here, and what is past it is counted and named, not read.
 */
export const MAX_FOLDER_BYTES = 8 * 1024 * 1024;

/**
 * A source file's text, or null when it is missing, a folder, or unreadable. A FIFO or a device
 * where a key file should be is refused without waiting on it, and counted as a file that could
 * not be read, as a permission error is. Missing is the normal case, and a folder named `.env` is
 * a Python environment. `cut` says the file is larger than was read.
 */
function readSource(
  path: string,
  max: number = MAX_KEY_FILE_BYTES,
): {
  readonly text: string | null;
  readonly cut: boolean;
  readonly failed: boolean;
} {
  const read = readHead(path, max);
  if (read.kind === 'text') return { text: read.text, cut: read.cut, failed: false };
  return {
    text: null,
    cut: false,
    failed: read.kind === 'not-regular' || read.kind === 'failed',
  };
}

/**
 * Where a key was read, in the order a key found in several places is named by: a home file,
 * then a project file, then a decoy, then the environment.
 */
const RANK = { home: 0, project: 1, decoy: 2, env: 3 } as const;
type Origin = keyof typeof RANK;

/** The keys as they are found: who names each, and what was left out. */
function keyPool() {
  const byValue = new Map<string, { readonly key: Key; readonly rank: number }>();
  /** Every place each value held was read. */
  const placesOf = new Map<string, Set<string>>();
  let truncated = false;
  return {
    /**
     * Takes a key found in `origin`. A value already held is renamed if this place names keys
     * before the one that held it; a new value is held while `room` says there is room.
     * False when it was left out.
     */
    add(found: Key, origin: Origin, room: () => boolean): boolean {
      // A name is printed: one that does not have the shape of a name is a fixed label.
      const named = { ...found, name: keyName(found.name) };
      // A canary is known by its shape, in whichever file it was pasted.
      const key: Key = isCanaryValue(found.value) ? { ...named, canary: true } : named;
      const held = byValue.get(found.value);
      if (held !== undefined) {
        placesOf.get(found.value)?.add(found.source);
        if (RANK[origin] < held.rank) byValue.set(found.value, { key, rank: RANK[origin] });
        return true;
      }
      if (byValue.size >= MAX_KEYS || !room()) {
        truncated = true;
        return false;
      }
      byValue.set(found.value, { key, rank: RANK[origin] });
      placesOf.set(found.value, new Set([found.source]));
      return true;
    },
    keys: (): Key[] =>
      [...byValue.values()].map(({ key }) => {
        const others = [...(placesOf.get(key.value) ?? [])].filter((s) => s !== key.source);
        return others.length === 0 ? key : { ...key, alsoIn: others };
      }),
    truncated: (): boolean => truncated,
  };
}

/** What reading the key files found, beside the keys. */
interface Reading {
  readonly paths: string[];
  /** Each file read, as a report shows it, with where it was read. */
  readonly read: { readonly source: string; readonly origin: Origin }[];
  readonly partial: Set<string>;
  unreadable: number;
  skippedFiles: number;
  rejected: number;
}

/**
 * Reads one key file into the pool, at most `max` bytes of it, and notes it as partial when not
 * all of it was taken. The bytes read, for a folder's budget.
 */
function readFile(
  path: string,
  origin: Origin,
  pool: ReturnType<typeof keyPool>,
  reading: Reading,
  home: string,
  room: () => boolean = () => true,
  max: number = MAX_KEY_FILE_BYTES,
): number {
  const { text, cut, failed } = readSource(path, max);
  if (failed) reading.unreadable += 1;
  if (text === null) return 0;
  reading.paths.push(path);
  const source = displayPath(path, home);
  reading.read.push({ source, origin });
  const found =
    origin === 'decoy'
      ? { secrets: canariesIn(text), cut: false, rejected: 0 }
      : // A URL's password is a key here, though the live guard's index leaves it out.
        extractSourceSecretsWhole(path, text, { urlPasswords: true });
  reading.rejected += found.rejected;
  let whole = !cut && !found.cut;
  for (const secret of found.secrets)
    whole = pool.add({ name: secret.name, source, value: secret.value }, origin, room) && whole;
  if (!whole) reading.partial.add(source);
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Reads one project folder's `.env*` files, each adding keys while the folder has room, and all of
 * them together up to `MAX_FOLDER_BYTES`: the file that budget cuts is named, the ones past it are
 * counted.
 */
function readFolder(
  dir: string,
  pool: ReturnType<typeof keyPool>,
  reading: Reading,
  home: string,
): void {
  const { files, found } = projectEnvFiles(dir, MAX_FOLDER_ENV_FILES);
  reading.skippedFiles += found - files.length;
  let added = 0;
  const room = (): boolean => {
    if (added >= MAX_FOLDER_KEYS) return false;
    added += 1;
    return true;
  };
  let bytes = 0;
  for (const path of files) {
    const left = MAX_FOLDER_BYTES - bytes;
    if (left <= 0) reading.skippedFiles += 1;
    else
      bytes += readFile(
        path,
        'project',
        pool,
        reading,
        home,
        room,
        Math.min(MAX_KEY_FILE_BYTES, left),
      );
  }
}

/** Folders below a project folder never looked in for env files: too many, or not the project's. */
const NOT_PROJECT_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', 'vendor']);
/** Subfolders of one project folder looked in for env files, at most. */
const MAX_SUBFOLDERS = 256;

/**
 * The env files one folder below a project folder, which are not read: counted for "Not checked".
 * A subfolder that is itself a project folder read is not counted.
 */
function subfolderEnvFiles(dir: string, read: ReadonlySet<string>): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries
    .filter((e) => e.isDirectory() && !NOT_PROJECT_FOLDERS.has(e.name))
    .slice(0, MAX_SUBFOLDERS)
    .map((e) => join(dir, e.name))
    .filter((sub) => !read.has(sub))
    .reduce((sum, sub) => sum + projectEnvFiles(sub, 0).found, 0);
}

/**
 * Every key on this machine, one per value. The home files, the decoys and the environment are
 * taken first, so no project folder can crowd them out; then each project folder in the order
 * given, each adding at most `MAX_FOLDER_KEYS`. The first place a value is found in names it: the
 * home files, then the project files in the order given, then the decoys, then the environment.
 */
export function loadKeys(sources: KeySources): KeySet {
  const pool = keyPool();
  const reading: Reading = {
    paths: [],
    read: [],
    partial: new Set(),
    unreadable: 0,
    skippedFiles: 0,
    rejected: 0,
  };
  const homeFiles = HOME_SECRET_SOURCES.map((rel) => join(sources.home, rel));
  for (const path of homeFiles) readFile(path, 'home', pool, reading, sources.home);
  const decoys = sources.stroqHome === undefined ? [] : decoyFiles(sources.stroqHome);
  for (const path of decoys) readFile(path, 'decoy', pool, reading, sources.home);
  for (const found of extractEnv(sources.env))
    pool.add({ name: found.name, source: 'env', value: found.value }, 'env', () => true);
  const folders = new Set(sources.projectDirs);
  for (const dir of folders) readFolder(dir, pool, reading, sources.home);
  let subfolderFiles = 0;
  for (const dir of folders) subfolderFiles += subfolderEnvFiles(dir, folders);
  const keys = pool.keys();
  const used = new Set(keys.map((k) => k.source));
  // In the order a key is named by: the home files, the project files, then the decoys.
  const ordered = [...reading.read].sort((a, b) => RANK[a.origin] - RANK[b.origin]);
  const files = [...new Set(ordered.map((r) => r.source))].filter((source) => used.has(source));
  const canaries = keys.filter((k) => k.canary === true).map((k) => k.value);
  return {
    keys,
    files,
    paths: reading.paths,
    envKeys: keys.filter((k) => k.source === 'env').length,
    unreadable: reading.unreadable,
    truncated: pool.truncated(),
    partial: [...reading.partial],
    skippedFiles: reading.skippedFiles,
    rejectedLines: reading.rejected,
    subfolderEnvFiles: subfolderFiles,
    canariesNotFound:
      sources.stroqHome === undefined ? 0 : canariesNotFound(sources.stroqHome, canaries),
  };
}

/** A key found in a text, with the spellings of it the text holds. */
export interface FoundKey {
  /** The key's index in the finder's `keys`. */
  readonly index: number;
  readonly key: Key;
  /** The spellings present: the value, its JSON-escaped form, its URL-encoded form. */
  readonly forms: readonly string[];
}

export interface KeyFinder {
  readonly keys: readonly Key[];
  /** The keys whose value is in `text`, in any spelling, in the order of `keys`. */
  find(text: string): FoundKey[];
  /**
   * Whether `text` holds any key, ignoring case: for a host or a path about to be printed,
   * which a URL parser may have lower-cased.
   */
  holds(text: string): boolean;
  /**
   * Whether `text` holds six characters or more of any key, in any case, as it is or URL-encoded:
   * for a host, a path or a program name about to be printed (`pieces.ts`).
   */
  hasPiece(text: string): boolean;
  /** How many texts the search for keys was cut short in (`needles.ts`). */
  cuts(): number;
}

export function keyFinder(keys: readonly Key[]): KeyFinder {
  const matcher = textMatcher(keys.map((k) => k.value));
  let lower: ReturnType<typeof textMatcher> | null = null;
  // A canary's prefix is the same for every one, and documented: only the letters drawn after it
  // are its secret.
  const pieces = pieceTable(
    keys.map((k) =>
      k.canary === true && k.value.startsWith(CANARY_PREFIX)
        ? k.value.slice(CANARY_PREFIX.length)
        : k.value,
    ),
  );
  return {
    keys,
    hasPiece: (text) => pieces.has(text),
    cuts: () => matcher.cuts() + (lower?.cuts() ?? 0),
    holds(text: string): boolean {
      if (text.length === 0) return false;
      lower ??= textMatcher(keys.map((k) => k.value.toLowerCase()));
      return lower.find(text.toLowerCase()).size > 0;
    },
    find(text: string): FoundKey[] {
      if (text.length === 0) return [];
      return [...matcher.find(text)]
        .sort((a, b) => a - b)
        .map((index) => {
          const key = keys[index] as Key;
          return { index, key, forms: keyForms(key.value).filter((f) => text.includes(f)) };
        });
    },
  };
}
