// `stroq card --json`, read as strictly as it is written: the console takes the card's data from a
// child process and shows it, so what it accepts is checked here, field by field, and refused whole
// when it does not fit.
import { z } from 'zod';
import { CARD_SCHEMA } from './data.js';
import { momentSchema } from './schema.js';

const count = z.number().int().nonnegative().max(1_000_000_000);
const text = z.string().max(2_000);

const counts = z
  .object({
    commands: count,
    toldByText: count,
    keysSent: count,
    keysStopped: count,
    keysSeen: count,
    autorunRepos: count,
  })
  .strict();

const coverage = z
  .object({
    found: count,
    agents: z.object({ claudeCode: count, codex: count }).strict(),
    checked: count,
    fromCache: count,
    notChecked: count,
    tooSlow: count,
    tooLarge: count,
    placeholders: count,
    placeholderNames: z.array(text).max(64),
    unreadable: count,
    older: count,
    keys: z.enum(['checked', 'not-finished', 'no-sessions']),
    keysChecked: count,
    keysFromCache: count,
    keysNotChecked: count,
    keysIncomplete: count,
    folders: z.object({ found: count, checked: count, capped: z.boolean() }).strict(),
    looked: z.array(text).max(8),
    cacheSaved: z.boolean(),
  })
  .strict();

const timing = z
  .object({
    totalMs: count,
    replayed: count,
    workers: count,
    replayMs: count,
    keysMs: count,
  })
  .strict();

export const cardDataSchema = z
  .object({
    schema: z.literal(CARD_SCHEMA),
    version: text,
    generated: text,
    days: z.number().int().min(1).max(365),
    counts,
    moments: z.array(momentSchema).max(99),
    coverage,
    timing,
  })
  .strict();
