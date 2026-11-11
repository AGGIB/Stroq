// The shapes the card keeps on disk and prints as JSON, read as strictly as they are written.
//
// Two files live under the Stroq home (`card/`): one summary per transcript (so that the next run
// reads only what changed) and the last card's moments (what `stroq show N` prints). Both are read
// back through these schemas and refused whole when they do not fit: a file somebody else put there is
// data to be checked, not a thing to be trusted. Neither holds a key's value: a summary has only the
// command and the excerpt the audit already redacted, and the main thread scrubs them again with the
// keys it knows before they are written.
import { z } from 'zod';

/** The longest any one stored string is. */
export const MAX_TEXT = 2_000;

const text = z.string().max(MAX_TEXT);
const count = z.number().int().nonnegative().max(1_000_000_000);

export const AGENTS = ['claude-code', 'codex', 'cursor'] as const;
export type CardAgent = (typeof AGENTS)[number];
const agent = z.enum(AGENTS);

/**
 * What a flagged text said and where the agent read it. `source` is the longest form of it the replay
 * had, and `name` the name of the file when that form was whole (see `read-name.ts`); a summary that
 * has no `name` does not know it.
 */
const readSchema = z
  .object({ tool: text, source: text, name: text.optional(), at: text, excerpt: text })
  .strict();

/** One command a text told the agent to run, as a session summary keeps it. */
export const toldMomentSchema = z
  .object({
    shape: z.enum(['pipe_shell', 'encoded', 'pkg']),
    pkg: text.optional(),
    tool: text,
    command: text,
    at: text,
    decision: z.enum(['allow', 'ask', 'deny', 'none']),
    read: readSchema,
  })
  .strict();
export type ToldMoment = z.infer<typeof toldMomentSchema>;

/** The most commands a text told one session to run that a summary keeps in full. */
export const MAX_TOLD_PER_SESSION = 5;

/**
 * The hours a summary keeps its counts by: the newest this many. Ten thousand hours is more than a
 * year, the longest window, so what is dropped is older than any window can reach.
 */
export const MAX_HOURS = 10_000;

/**
 * What happened in one hour of a session: the hour as whole hours since 1970 (or null for events whose
 * record gave no time that reads as one), the shell commands the agent ran in it, and how many of them a
 * text told it to run. The card's window is applied to these when the card is made, by when each event
 * happened and not by when the file was last written to.
 */
export const hourSchema = z.tuple([z.number().int().nonnegative().nullable(), count, count]);
export type SessionHour = z.infer<typeof hourSchema>;

export const sessionSummarySchema = z
  .object({
    agent,
    sessionId: text,
    cwd: text.nullable(),
    first: text.nullable(),
    last: text.nullable(),
    /** Shell commands the agent ran. */
    commands: count,
    /** How many of them a text told it to run (all of them, though only some are kept below). */
    told: count,
    /** The commands a text told it to run, the newest `MAX_TOLD_PER_SESSION`, oldest first. */
    moments: z.array(toldMomentSchema).max(MAX_TOLD_PER_SESSION),
    /** `commands` and `told` by the hour they happened in, oldest first. */
    hours: z.array(hourSchema).max(MAX_HOURS),
  })
  .strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** A replay that was cut off by the time limit, kept for this exact file so that it is not waited for again. */
const unfinishedSchema = z
  .object({
    key: text,
    mtimeMs: z.number().nonnegative(),
    /** The time the replay had when it was cut off: a run with more is let try again. */
    budgetMs: z.number().int().nonnegative().max(86_400_000),
    unfinished: z.literal(true),
  })
  .strict();
const doneEntrySchema = z
  .object({ key: text, mtimeMs: z.number().nonnegative(), summary: sessionSummarySchema })
  .strict();
const cacheEntrySchema = z.union([doneEntrySchema, unfinishedSchema]);

export const SESSION_CACHE_SCHEMA = 'stroq-card-sessions/2';
export const sessionCacheSchema = z
  .object({
    schema: z.literal(SESSION_CACHE_SCHEMA),
    entries: z.record(z.string().max(4_096), cacheEntrySchema),
  })
  .strict();
export type SessionCacheFile = z.infer<typeof sessionCacheSchema>;
export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export const MOMENT_KINDS = [
  'told-by-text',
  'key-sent',
  'key-maybe',
  'key-seen',
  'autorun-repo',
] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** One block of `stroq show`: a title and rows of label and value. */
const groupSchema = z
  .object({
    title: text,
    rows: z.array(z.tuple([text, text])).max(16),
  })
  .strict();

const sessionRefSchema = z.object({ agent, id: text, path: text, cwd: text.nullable() }).strict();

export const momentSchema = z
  .object({
    n: z.number().int().min(1).max(99),
    kind: z.enum(MOMENT_KINDS),
    /** The sentence on the card. */
    line: text,
    session: sessionRefSchema.optional(),
    groups: z.array(groupSchema).max(8),
    /** Commands to dig deeper, ready to paste. */
    next: z.array(text).max(4),
    /**
     * The digest a false-alarm mark is kept under (`false-alarms.ts`). A card an older version kept
     * has none, and its moments cannot be marked until the card is made again.
     */
    key: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type Moment = z.infer<typeof momentSchema>;

export const LAST_CARD_SCHEMA = 'stroq-card-last/1';
export const lastCardSchema = z
  .object({
    schema: z.literal(LAST_CARD_SCHEMA),
    version: text,
    generated: text,
    days: z.number().int().min(1).max(365),
    moments: z.array(momentSchema).max(99),
  })
  .strict();
export type LastCard = z.infer<typeof lastCardSchema>;
