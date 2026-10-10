// The file a ledger keeps: how many host requests this machine's owner has spent on live checks.
//
// The reader is strict because the file is a cap. A reader that took a damaged file for an empty one
// would hand the cap back to whoever damaged it, so a file that is not exactly a ledger is a problem
// to report and never a ledger to mend. The file is read by `readSmallRegularFile`, so a FIFO or a
// device in its place is refused without waiting; the tests run the reader in a child process, where a
// path that blocks costs a time limit and not a hung suite.
import { z } from 'zod';
import { readSmallRegularFile, writePrivateFileAtomic } from './private-file.js';

/** A ledger holds thirty requests and a short list of why; nothing like this size is a ledger. */
export const MAX_LEDGER_BYTES = 64 * 1024;
/** The largest cap a ledger file can hold, and so the largest one a ledger is opened with. */
export const MAX_LEDGER_LIMIT = 100_000;
/** The newest entries are kept; `used` keeps counting. 200 of them are far below the byte cap. */
export const MAX_LEDGER_ENTRIES = 200;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isRealTime = (text: string): boolean => {
  const time = new Date(text);
  return !Number.isNaN(time.getTime()) && time.toISOString() === text;
};

const LedgerFileSchema = z
  .strictObject({
    version: z.literal(1),
    limit: z.number().int().min(1).max(MAX_LEDGER_LIMIT),
    used: z.number().int().min(0).max(1_000_000_000),
    entries: z
      .array(
        z.strictObject({
          at: z.string().regex(ISO_TIME).refine(isRealTime),
          reason: z.string().regex(/^[\x20-\x7e]{1,80}$/),
        }),
      )
      .max(MAX_LEDGER_ENTRIES),
  })
  // Every entry is at least one request, so a count below the number of entries was lowered by hand.
  .refine((ledger) => ledger.used >= ledger.entries.length);

export interface LedgerFile {
  readonly version: 1;
  /** The cap, as the file that holds it says. */
  readonly limit: number;
  readonly used: number;
  readonly entries: readonly { readonly at: string; readonly reason: string }[];
}

export type LedgerRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ledger'; readonly ledger: LedgerFile }
  | { readonly kind: 'problem'; readonly problem: string };

/** The ledger at `path`; that there is none; or why what is there is not one. Never throws. */
export function readLedgerFile(path: string): LedgerRead {
  const read = readSmallRegularFile(path, MAX_LEDGER_BYTES);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'refused')
    return {
      kind: 'problem',
      problem: read.why === 'too large' ? 'larger than 64 KiB' : read.why,
    };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { kind: 'problem', problem: 'not JSON' };
  }
  const parsed = LedgerFileSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    return {
      kind: 'problem',
      problem: `does not match the ledger format (${where === '' ? 'whole file' : where})`,
    };
  }
  return { kind: 'ledger', ledger: parsed.data };
}

/** Written whole or not at all, to the owner alone. Throws when it cannot. */
export function writeLedgerFile(path: string, ledger: LedgerFile): void {
  writePrivateFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`);
}
