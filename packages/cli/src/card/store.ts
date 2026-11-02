// What the card keeps under the Stroq home (`card/`), written so it is whole or not there, read so a
// file somebody else put there is data to check and not a thing to believe.
//
// Writes: the folder is made 0700 and refused when it is a link or not a folder (a link there would
// send the writes wherever it points); a file is written to a temporary name beside it with `wx` (a
// link planted at that name is an error, never a write through it) and renamed into place, 0600.
// Reads: only a regular file of a bounded size, parsed through the strict schemas; anything else reads
// as "nothing cached" and the run checks the sessions again.
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { readSmallRegularFile, writePrivateFileAtomic } from '../live/private-file.js';
import { cardDirIn, cardLastFileIn, cardSessionsFileIn } from '../paths.js';
import {
  LAST_CARD_SCHEMA,
  SESSION_CACHE_SCHEMA,
  lastCardSchema,
  sessionCacheSchema,
  type CacheEntry,
  type LastCard,
  type Moment,
  type SessionSummary,
} from './schema.js';

/** A cache file is a few hundred kilobytes; one past this is not one. */
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_LAST_BYTES = 1024 * 1024;
/** The most transcripts the cache remembers: the newest. */
export const MAX_CACHED = 30_000;

/** Everything a summary depends on, so that a change to any of it is a miss. */
export function cacheKey(parts: {
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly version: string;
  /** The digest of the policy the replay was judged under. */
  readonly policy: string;
}): string {
  return `${parts.bytes}:${parts.mtimeMs}:${parts.version}:${parts.policy}`;
}

/** Makes the folder, or checks the one that is there is a real folder only this user can use. */
export function ensureCardDir(home: string): void {
  const dir = cardDirIn(home);
  let info;
  try {
    info = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${dir} is not a plain folder, so nothing is saved there`);
  const owner = process.getuid?.();
  if ((info.mode & 0o077) !== 0 && owner !== undefined && info.uid === owner) chmodSync(dir, 0o700);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The summaries kept for transcripts, by path. Empty when there is no file or it is not a cache. */
export function readSessionCache(home: string): Map<string, CacheEntry> {
  const read = readSmallRegularFile(cardSessionsFileIn(home), MAX_CACHE_BYTES);
  if (read.kind !== 'text') return new Map();
  const parsed = sessionCacheSchema.safeParse(parse(read.text));
  return parsed.success ? new Map(Object.entries(parsed.data.entries)) : new Map();
}

/** Keeps `entries` (the newest `MAX_CACHED`). Throws when it cannot write: the caller says so and goes on. */
export function writeSessionCache(home: string, entries: ReadonlyMap<string, CacheEntry>): void {
  ensureCardDir(home);
  const newest = [...entries.entries()]
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_CACHED);
  const file = { schema: SESSION_CACHE_SCHEMA, entries: Object.fromEntries(newest) };
  // Through the schema that reads it, so that what is written is what will be accepted.
  const checked = sessionCacheSchema.parse(JSON.parse(JSON.stringify(file)));
  writePrivateFileAtomic(cardSessionsFileIn(home), `${JSON.stringify(checked)}\n`);
}

/** The cached summary of a transcript when its key is the one asked for. */
export function cachedSummary(
  cache: ReadonlyMap<string, CacheEntry>,
  path: string,
  key: string,
): SessionSummary | null {
  const entry = cache.get(path);
  return entry !== undefined && entry.key === key && 'summary' in entry ? entry.summary : null;
}

/**
 * Whether an earlier run gave up on replaying this exact file (its key) for want of time, with no
 * more time than `budgetMs`: a run with more tries it again, and so does any change to the file.
 */
export function cachedUnfinished(
  cache: ReadonlyMap<string, CacheEntry>,
  path: string,
  key: string,
  budgetMs: number,
): boolean {
  const entry = cache.get(path);
  return (
    entry !== undefined && entry.key === key && 'unfinished' in entry && entry.budgetMs >= budgetMs
  );
}

export type LastRead =
  | { readonly kind: 'card'; readonly card: LastCard }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly why: string };

/** The moments of the last card. */
export function readLastCard(home: string): LastRead {
  const read = readSmallRegularFile(cardLastFileIn(home), MAX_LAST_BYTES);
  if (read.kind === 'absent') return { kind: 'none' };
  if (read.kind === 'refused') return { kind: 'unreadable', why: read.why };
  const parsed = lastCardSchema.safeParse(parse(read.text));
  return parsed.success
    ? { kind: 'card', card: parsed.data }
    : { kind: 'unreadable', why: 'it is not a card this version wrote' };
}

/** Keeps the moments of a card for `stroq show`. Throws when it cannot write. */
export function writeLastCard(
  home: string,
  card: { readonly version: string; readonly generated: string; readonly days: number },
  moments: readonly Moment[],
): void {
  ensureCardDir(home);
  const file: LastCard = { schema: LAST_CARD_SCHEMA, ...card, moments: [...moments] };
  const checked = lastCardSchema.parse(JSON.parse(JSON.stringify(file)));
  writePrivateFileAtomic(cardLastFileIn(home), `${JSON.stringify(checked, null, 2)}\n`);
}
