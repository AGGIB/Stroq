// The key check's results per transcript, kept under the Stroq home (`card/keys.json`) the way the
// card keeps its other files (`store.ts`): the folder 0700 and never a link, the file written whole to
// a temporary name and renamed, 0600; read only as a regular file of a bounded size through the strict
// schema, so that a file that does not fit reads as "nothing kept" and the transcripts are checked again.
//
// What is kept is true only for the keys it was made under, so the file holds one digest of the key
// index (`key-index.ts`) and its salt; entries made under another digest are not used, and the next
// write drops them.
import { readSmallRegularFile, writePrivateFileAtomic } from '../live/private-file.js';
import { cardKeysFileIn } from '../paths.js';
import {
  KEY_CACHE_SCHEMA,
  keyCacheSchema,
  type CanaryMemoryFile,
  type KeyCacheEntry,
  type KeyCacheFile,
  type SessionKeys,
} from './key-schema.js';
import { MAX_CACHED, ensureCardDir } from './store.js';

/** A cache file is a few hundred kilobytes; one past this is not one. */
const MAX_CACHE_BYTES = 48 * 1024 * 1024;

export interface KeyCache {
  /** The salt the digest was made with; null when there is no cache to take it from. */
  readonly salt: string | null;
  readonly digest: string | null;
  readonly entries: ReadonlyMap<string, KeyCacheEntry>;
  /** The session files found to hold no missing canary, or null. */
  readonly canaries: CanaryMemoryFile | null;
}

export const NO_KEY_CACHE: KeyCache = {
  salt: null,
  digest: null,
  entries: new Map(),
  canaries: null,
};

/** Everything a result depends on in the transcript and the program; the digest covers the keys. */
export function keyCacheKey(parts: {
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly version: string;
}): string {
  return `${parts.bytes}:${parts.mtimeMs}:${parts.version}`;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** What was kept. Empty when there is no file or it is not a cache this version wrote. */
export function readKeyCache(home: string): KeyCache {
  const read = readSmallRegularFile(cardKeysFileIn(home), MAX_CACHE_BYTES);
  if (read.kind !== 'text') return NO_KEY_CACHE;
  const parsed = keyCacheSchema.safeParse(parse(read.text));
  if (!parsed.success) return NO_KEY_CACHE;
  const { salt, digest, entries, canaries } = parsed.data;
  return { salt, digest, entries: new Map(Object.entries(entries)), canaries: canaries ?? null };
}

/** The entries that were made under `digest`; none when the cache was made under another. */
export function entriesUnder(cache: KeyCache, digest: string): ReadonlyMap<string, KeyCacheEntry> {
  return cache.digest === digest ? cache.entries : new Map();
}

/** The kept result of a transcript when its key is the one asked for. */
export function keptKeys(
  entries: ReadonlyMap<string, KeyCacheEntry>,
  path: string,
  key: string,
): SessionKeys | null {
  const entry = entries.get(path);
  return entry !== undefined && entry.key === key ? entry.result : null;
}

/** Keeps `entries` (the newest `MAX_CACHED`) under `digest`. Throws when it cannot write. */
export function writeKeyCache(
  home: string,
  file: {
    readonly salt: string;
    readonly digest: string;
    readonly entries: ReadonlyMap<string, KeyCacheEntry>;
    readonly canaries?: CanaryMemoryFile | null;
  },
): void {
  ensureCardDir(home);
  const newest = [...file.entries.entries()]
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_CACHED);
  const body: KeyCacheFile = {
    schema: KEY_CACHE_SCHEMA,
    salt: file.salt,
    digest: file.digest,
    entries: Object.fromEntries(newest),
    ...(file.canaries === undefined || file.canaries === null ? {} : { canaries: file.canaries }),
  };
  // Through the schema that reads it, so that what is written is what will be accepted.
  const checked = keyCacheSchema.parse(JSON.parse(JSON.stringify(body)));
  writePrivateFileAtomic(cardKeysFileIn(home), `${JSON.stringify(checked)}\n`);
}
