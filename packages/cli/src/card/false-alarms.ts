// The moments a person said were false alarms, so that the card stops listing them.
//
// A mark is a digest of what the moment says (its kind, its session and every row `stroq show` prints
// for it) and of what those words leave out: the whole command, and what a folder's settings run. A
// moment whose evidence changes (one more key in the session, another command in a folder's task, one
// more hook, another decision of the policy) is a new moment and is listed again: a mark answers for
// what the person read and nothing else. The counts on the card do not change, since
// they are what the rules found; only the list of what is worth a look does, and the card says how
// many it left out.
//
// The file is under the Stroq home, where the hook refuses an agent's own writes, and the command that
// writes it needs a terminal of the person's own (`commands/show.ts`) and is refused through an agent's
// shell (`stroq-commands.ts` in core). A file that cannot be read leaves nothing out: a mark only ever
// hides, so a mark that cannot be checked is not one.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readSmallRegularFile, writePrivateFileAtomic } from '../live/private-file.js';
import { cardFalseAlarmsFileIn } from '../paths.js';
import { MAX_TEXT, MOMENT_KINDS, type Moment } from './schema.js';
import { ensureCardDir } from './store.js';

export const FALSE_ALARMS_SCHEMA = 'stroq-card-false-alarms/1';
/** The most marks kept. A person who reaches it clears them before marking more. */
export const MAX_MARKS = 500;
/**
 * How many hex digits of a key `stroq show` prints as the moment's id, and a mark is asked for by: 48
 * bits, so that no moment can be made to share the id of another by trying.
 */
export const ID_LENGTH = 12;
const MAX_BYTES = 2 * 1024 * 1024;

const DIGEST = /^[0-9a-f]{64}$/;

const markSchema = z
  .object({
    key: z.string().regex(DIGEST),
    kind: z.enum(MOMENT_KINDS),
    /** The sentence the card printed, for the list of marks. */
    line: z.string().max(MAX_TEXT),
    /** ISO 8601: when the person marked it. */
    marked: z.string().max(40),
  })
  .strict();
export type FalseAlarm = z.infer<typeof markSchema>;

const fileSchema = z
  .object({
    schema: z.literal(FALSE_ALARMS_SCHEMA),
    marks: z.array(markSchema).max(MAX_MARKS),
  })
  .strict();

export type FalseAlarmsRead =
  | { readonly kind: 'marks'; readonly marks: readonly FalseAlarm[] }
  /** `newer`: the file names a schema of its own that is not this version's; it is left as it is. */
  | { readonly kind: 'unreadable'; readonly why: string; readonly newer: boolean };

/**
 * The digest a mark is kept under: everything the moment says, but not its number or its next steps,
 * and the evidence its words leave out (`moments.ts`): a whole command, what a folder's settings run.
 */
export function momentKey(
  moment: Pick<Moment, 'kind' | 'session' | 'line' | 'groups'>,
  evidence: string,
): string {
  const session = moment.session === undefined ? null : [moment.session.agent, moment.session.id];
  return createHash('sha256')
    .update(JSON.stringify([moment.kind, session, moment.line, moment.groups, evidence]))
    .digest('hex');
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The marks. No file is no mark; a file that does not read as one is `unreadable`. */
export function readFalseAlarms(home: string): FalseAlarmsRead {
  const read = readSmallRegularFile(cardFalseAlarmsFileIn(home), MAX_BYTES);
  if (read.kind === 'absent') return { kind: 'marks', marks: [] };
  if (read.kind === 'refused') return { kind: 'unreadable', why: read.why, newer: false };
  const raw = parse(read.text);
  const parsed = fileSchema.safeParse(raw);
  if (parsed.success) return { kind: 'marks', marks: parsed.data.marks };
  const schema = (raw as { schema?: unknown } | undefined)?.schema;
  const newer =
    typeof schema === 'string' &&
    schema.startsWith('stroq-card-false-alarms/') &&
    schema !== FALSE_ALARMS_SCHEMA;
  return {
    kind: 'unreadable',
    why: newer ? 'a newer version of Stroq wrote it' : 'it is not a file this version wrote',
    newer,
  };
}

/** The digests to leave out of a card, and whether the file could be read. */
export function falseAlarmKeys(home: string): {
  readonly keys: ReadonlySet<string>;
  readonly unreadable: boolean;
} {
  const read = readFalseAlarms(home);
  return read.kind === 'marks'
    ? { keys: new Set(read.marks.map((m) => m.key)), unreadable: false }
    : { keys: new Set(), unreadable: true };
}

function write(home: string, marks: readonly FalseAlarm[]): void {
  ensureCardDir(home);
  const checked = fileSchema.parse({ schema: FALSE_ALARMS_SCHEMA, marks: [...marks] });
  writePrivateFileAtomic(cardFalseAlarmsFileIn(home), `${JSON.stringify(checked, null, 2)}\n`);
}

export type MarkResult =
  | { readonly kind: 'marked' }
  | { readonly kind: 'already' }
  | { readonly kind: 'full' }
  | { readonly kind: 'no-key' }
  | { readonly kind: 'unreadable'; readonly why: string; readonly newer: boolean };

/** Marks a moment of the last card. Throws when the file cannot be written. */
export function markFalseAlarm(home: string, moment: Moment, now: Date): MarkResult {
  if (moment.key === undefined) return { kind: 'no-key' };
  const read = readFalseAlarms(home);
  if (read.kind === 'unreadable') return read;
  if (read.marks.some((m) => m.key === moment.key)) return { kind: 'already' };
  if (read.marks.length >= MAX_MARKS) return { kind: 'full' };
  write(home, [
    ...read.marks,
    { key: moment.key, kind: moment.kind, line: moment.line, marked: now.toISOString() },
  ]);
  return { kind: 'marked' };
}

export type ClearResult =
  { readonly kind: 'cleared'; readonly count: number } | { readonly kind: 'newer' };

/**
 * Takes every mark back: the card lists those moments again. A file this version cannot read is
 * replaced as well, since clearing is how a person gets out of one; a newer version's is left alone.
 */
export function clearFalseAlarms(home: string): ClearResult {
  const read = readFalseAlarms(home);
  if (read.kind === 'unreadable' && read.newer) return { kind: 'newer' };
  const count = read.kind === 'marks' ? read.marks.length : 0;
  if (count > 0 || read.kind === 'unreadable') write(home, []);
  return { kind: 'cleared', count };
}
