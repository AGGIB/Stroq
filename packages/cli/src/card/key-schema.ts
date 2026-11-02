// What the card keeps of the key check, per transcript, and reads back as strictly as it writes it.
//
// For each key a transcript touched: the key's number (never the key; see `key-index.ts`), where it
// went (the tier, the route, the host or program, all names the check already made safe), when, and
// how many times. Nothing in it is a value or a hash of one. The file is read back through these
// schemas and refused whole when it does not fit: a file somebody else put there is data to check.
import { z } from 'zod';
import type { Route, Tier } from '../sent/place.js';
import { MAX_TEXT } from './schema.js';

const text = z.string().max(MAX_TEXT);
const count = z.number().int().nonnegative().max(1_000_000_000);

const TIER_NAMES = [
  'third_party',
  'maybe',
  'seen',
  'own_service',
  'blocked',
] as const satisfies readonly Tier[];
const tier = z.enum(TIER_NAMES);

const ROUTE_NAMES = [
  'command',
  'command-near',
  'command-ran',
  'command-unread',
  'post',
  'secret-store',
  'ssh',
  'git-push',
  'publish',
  'web-fetch',
  'web-search',
  'mcp',
  'write',
  'write-script',
  'write-sent',
  'write-push',
  'arguments',
  'result',
  'prompt',
  'reply',
  'record',
  'cut',
] as const satisfies readonly Route[];
// A route added to `Route` and not here fails to compile: an unknown route would be refused on read.
const ALL_ROUTES: [Exclude<Route, (typeof ROUTE_NAMES)[number]>] extends [never] ? true : never =
  true;
void ALL_ROUTES;
const route = z.enum(ROUTE_NAMES);

const thenSchema = z
  .object({
    route,
    host: text.nullable(),
    at: text.nullable(),
    detail: text.optional(),
    tier: tier.optional(),
  })
  .strict();

const placeSchema = z
  .object({
    tier,
    route,
    tool: text.optional(),
    detail: text.optional(),
    host: text.optional(),
    local: z.literal(true).optional(),
    spilled: z.literal(true).optional(),
    blocked: z.enum(['stroq', 'user']).optional(),
    wouldBe: tier.optional(),
    saidStopped: z.literal(true).optional(),
    connector: z.literal(true).optional(),
    service: text.optional(),
    then: thenSchema.optional(),
    cut: z.enum(['variables', 'key-files', 'folders']).optional(),
  })
  .strict();

/**
 * The most hits one transcript's result holds (a key has one for each distance it reached that no later,
 * nearer sighting hides); a result with more is used once and not kept.
 */
export const MAX_HITS = 2_000;
/** The most keys an index numbers (`MAX_KEYS` in `sent/keys.ts`, with the canaries found in sessions). */
const MAX_KEY_NUMBER = 20_000;

const hitSchema = z
  .object({
    /** The key's number in the index the result was made under. */
    k: z.number().int().nonnegative().max(MAX_KEY_NUMBER),
    place: placeSchema,
    /** The earliest time the key was seen in this place: ISO 8601, or empty when no record gave one. */
    at: text,
    /**
     * The latest time it was seen there, the same way: empty if any sighting in this place had no
     * time, so that the window cannot cut it. The card's window is applied to this, by event time.
     */
    last: text,
    subagent: text.optional(),
    times: count,
    seen: count,
    later: count,
  })
  .strict();
export type StoredHit = z.infer<typeof hitSchema>;

export const sessionKeysSchema = z
  .object({ id: text, hits: z.array(hitSchema).max(MAX_HITS) })
  .strict();
export type SessionKeys = z.infer<typeof sessionKeysSchema>;

const entrySchema = z
  .object({ key: text, mtimeMs: z.number().nonnegative(), result: sessionKeysSchema })
  .strict();
export type KeyCacheEntry = z.infer<typeof entrySchema>;

/**
 * The session files read for a canary `stroq canary` planted whose decoy is gone, and found to hold
 * none of the canaries then missing: by path, with the size and date they had. True while the same
 * canaries are missing (`signature`). Paths and numbers only.
 */
const canaryMemorySchema = z
  .object({
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.record(z.string().max(4_096), text),
  })
  .strict();
export type CanaryMemoryFile = z.infer<typeof canaryMemorySchema>;

export const KEY_CACHE_SCHEMA = 'stroq-card-keys/2';
export const keyCacheSchema = z
  .object({
    schema: z.literal(KEY_CACHE_SCHEMA),
    /** Random, made once with the cache; what the digest is salted with. */
    salt: z.string().regex(/^[0-9a-f]{32}$/),
    /** The digest of the key index the entries were made under (`key-index.ts`). */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    entries: z.record(z.string().max(4_096), entrySchema),
    canaries: canaryMemorySchema.optional(),
  })
  .strict();
export type KeyCacheFile = z.infer<typeof keyCacheSchema>;
