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

export const AGENTS = ['claude-code', 'codex'] as const;
export type CardAgent = (typeof AGENTS)[number];
const agent = z.enum(AGENTS);

/** What a flagged text said and where the agent read it. */
const readSchema = z.object({ tool: text, source: text, at: text, excerpt: text }).strict();

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
    moments: z.array(toldMomentSchema).max(MAX_TOLD_PER_SESSION),
  })
  .strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

const cacheEntrySchema = z
  .object({ key: text, mtimeMs: z.number().nonnegative(), summary: sessionSummarySchema })
  .strict();

export const SESSION_CACHE_SCHEMA = 'stroq-card-sessions/1';
export const sessionCacheSchema = z
  .object({
    schema: z.literal(SESSION_CACHE_SCHEMA),
    entries: z.record(z.string().max(4_096), cacheEntrySchema),
  })
  .strict();
export type SessionCacheFile = z.infer<typeof sessionCacheSchema>;
export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export const MOMENT_KINDS = ['told-by-text', 'key-sent', 'key-seen', 'autorun-repo'] as const;
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
