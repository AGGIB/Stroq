// What the card keeps of each replay (`card/sessions.json`), and how a run reads it and writes it back.
//
// A summary is kept under the transcript's path with any key taken out, for the exact file (size and
// date), the Stroq version, the policy and the keys of the run (the digest of the key index). A summary
// is used only when all of that is the same, and even then it is cleaned of the keys of today before it
// is used: it was cleaned of the keys known when it was written, and a key added since may be in it. A
// replay that was cut off by the time limit is kept as unfinished for the same stamp, so that the next
// run does not wait for it again.
import type { CacheEntry, SessionSummary } from './schema.js';
import { scrubSummary, type Scrub } from './scrub.js';
import { cacheKey, cachedSummary, cachedUnfinished, writeSessionCache } from './store.js';
import type { WindowSession } from './window.js';

/** What a kept summary depends on besides the file itself. */
export interface ReplayCacheKeys {
  readonly version: string;
  /** The digest of the policy the replay is judged under. */
  readonly policy: string;
  /** The digest of the key index of the run; empty when it looked for no key. */
  readonly keys: string;
  /** Takes any key of today out of a text. */
  readonly scrub: Scrub;
}

/** The stamp of a file under these keys: what a kept summary must match. */
export const entryKey = (s: Pick<WindowSession, 'bytes' | 'mtimeMs'>, k: ReplayCacheKeys): string =>
  cacheKey({
    bytes: s.bytes,
    mtimeMs: s.mtimeMs,
    version: k.version,
    policy: k.policy,
    keys: k.keys,
  });

/** The name a transcript is kept under: its path with any key taken out. */
export const pathKey = (s: Pick<WindowSession, 'path'>, k: ReplayCacheKeys): string =>
  k.scrub(s.path);

/** The kept summary of a session, cleaned of today's keys; null when none matches. */
export function lookupSummary(
  cache: ReadonlyMap<string, CacheEntry>,
  s: WindowSession,
  k: ReplayCacheKeys,
): SessionSummary | null {
  const kept = cachedSummary(cache, pathKey(s, k), entryKey(s, k));
  return kept === null ? null : scrubSummary(kept, k.scrub);
}

/** Whether a replay of this exact file was cut off before, with no less time than `budgetMs`. */
export const lookupUnfinished = (
  cache: ReadonlyMap<string, CacheEntry>,
  s: WindowSession,
  k: ReplayCacheKeys,
  budgetMs: number,
): boolean => cachedUnfinished(cache, pathKey(s, k), entryKey(s, k), budgetMs);

/** What a run adds to what was kept. */
export interface ReplayChanges {
  readonly sessions: readonly WindowSession[];
  /** Replays that finished, by place in the window. */
  readonly fresh: ReadonlyMap<number, SessionSummary>;
  /** Replays cut off by the time limit, by place in the window, with the time they had. */
  readonly cutOff: ReadonlyMap<number, number>;
}

const summaryOf = (entry: CacheEntry): SessionSummary | null =>
  'summary' in entry ? entry.summary : null;

/**
 * Cleans what was kept of the keys of today (paths and summaries), adds the changes, and writes the
 * file when anything changed. False when it could not be written.
 */
export function saveReplays(
  stroqHome: string,
  old: ReadonlyMap<string, CacheEntry>,
  k: ReplayCacheKeys,
  changes: ReplayChanges,
): boolean {
  const next = new Map<string, CacheEntry>();
  let changed = changes.fresh.size > 0 || changes.cutOff.size > 0;
  for (const [path, entry] of old) {
    const cleanPath = k.scrub(path);
    const kept = summaryOf(entry);
    const cleaned = kept === null ? entry : { ...entry, summary: scrubSummary(kept, k.scrub) };
    if (cleanPath !== path || JSON.stringify(cleaned) !== JSON.stringify(entry)) changed = true;
    next.set(cleanPath, cleaned as CacheEntry);
  }
  if (!changed) return true;
  for (const [index, summary] of changes.fresh) {
    const s = changes.sessions[index] as WindowSession;
    next.set(pathKey(s, k), { key: entryKey(s, k), mtimeMs: s.mtimeMs, summary });
  }
  for (const [index, budgetMs] of changes.cutOff) {
    const s = changes.sessions[index] as WindowSession;
    next.set(pathKey(s, k), {
      key: entryKey(s, k),
      mtimeMs: s.mtimeMs,
      budgetMs,
      unfinished: true,
    });
  }
  try {
    writeSessionCache(stroqHome, next);
    return true;
  } catch {
    return false;
  }
}
