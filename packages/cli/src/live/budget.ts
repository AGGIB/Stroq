// The owner's budget for live checks.
//
// A live check spends requests on the owner's own account, from a usage limit their real work needs.
// So the cap is not a promise: it is a file that every request is taken from, under a lock, before the
// request is made. The file holds across runs and across processes, and nothing the model or the host
// says can raise it. A file that is not a ledger gives no requests at all.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withLock } from '@stroq/core';
import {
  MAX_LEDGER_ENTRIES,
  MAX_LEDGER_LIMIT,
  readLedgerFile,
  writeLedgerFile,
  type LedgerFile,
} from './ledger-file.js';

export { authTextOf, limitTextOf } from './limit-text.js';

/** What the owner has set aside for live checks, in all, on this machine. */
export const LIVE_REQUEST_LIMIT = 30;

/** A request is a few milliseconds under the lock, so a wait of this long means the lock is stuck. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const MAX_REASON_CHARS = 80;

export type TakeRefusal =
  'limit-reached' | 'invalid-request' | 'unreadable' | 'unwritable' | 'busy';

export type TakeResult =
  | { readonly ok: true; readonly used: number; readonly limit: number }
  | {
      readonly ok: false;
      readonly why: TakeRefusal;
      /** How many are spent, when that could be read. */
      readonly used: number | null;
      readonly limit: number;
      readonly problem: string;
    };

export type PeekResult =
  | { readonly ok: true; readonly used: number; readonly limit: number }
  | { readonly ok: false; readonly problem: string };

export interface Ledger {
  /** Takes `n` requests, if that leaves the total within the cap; takes none otherwise. */
  take(n: number, reason: string): Promise<TakeResult>;
  /** What is spent and what the cap is, for a message; or why that cannot be said. */
  peek(): Promise<PeekResult>;
}

export interface LedgerOptions {
  /** The file. Absent or empty: the ledger lives in memory and ends with the process. */
  readonly path?: string | undefined;
  /** The cap this caller wants. The file's own cap is honoured when it is lower. */
  readonly limit: number;
  readonly lockTimeoutMs?: number;
  readonly now?: () => Date;
}

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** A reason is written to a file that is printed: plain ASCII, one short line. */
function cleanReason(reason: string): string {
  const cleaned = reason.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_REASON_CHARS);
  return cleaned === '' ? '-' : cleaned;
}

function refused(
  why: TakeRefusal,
  used: number | null,
  limit: number,
  problem: string,
): TakeResult {
  return { ok: false, why, used, limit, problem };
}

function memoryLedger(limit: number): Ledger {
  let used = 0;
  return {
    take: (n) => {
      if (!isCount(n))
        return Promise.resolve(refused('invalid-request', used, limit, 'not a count'));
      if (used + n > limit)
        return Promise.resolve(refused('limit-reached', used, limit, `${used} of ${limit} spent`));
      used += n;
      return Promise.resolve({ ok: true, used, limit });
    },
    peek: () => Promise.resolve({ ok: true, used, limit }),
  };
}

function fileLedger(path: string, wanted: number, options: LedgerOptions): Ledger {
  const now = options.now ?? ((): Date => new Date());
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  // The cap in the file is the owner's; a caller that asks for more does not get it.
  const capOf = (stored: LedgerFile | null): number => Math.min(stored?.limit ?? wanted, wanted);

  /** One request for requests, with the file read and written inside the lock. */
  const takeLocked = (n: number, reason: string): TakeResult => {
    const read = readLedgerFile(path);
    if (read.kind === 'problem') return refused('unreadable', null, wanted, read.problem);
    const stored = read.kind === 'ledger' ? read.ledger : null;
    const limit = capOf(stored);
    const used = stored?.used ?? 0;
    if (used + n > limit) return refused('limit-reached', used, limit, `${used} of ${limit} spent`);
    const next: LedgerFile = {
      version: 1,
      limit: stored?.limit ?? wanted,
      used: used + n,
      entries: [
        ...(stored?.entries ?? []),
        { at: now().toISOString(), reason: cleanReason(reason) },
      ].slice(-MAX_LEDGER_ENTRIES),
    };
    try {
      writeLedgerFile(path, next);
    } catch (err) {
      return refused(
        'unwritable',
        used,
        limit,
        (err as NodeJS.ErrnoException).code ?? 'write failed',
      );
    }
    return { ok: true, used: next.used, limit };
  };

  return {
    async take(n, reason) {
      if (!isCount(n)) return refused('invalid-request', null, wanted, 'not a count');
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      } catch (err) {
        return refused(
          'unwritable',
          null,
          wanted,
          (err as NodeJS.ErrnoException).code ?? 'mkdir failed',
        );
      }
      try {
        return await withLock(`${path}.lock`, () => Promise.resolve(takeLocked(n, reason)), {
          timeoutMs: lockTimeoutMs,
        });
      } catch (err) {
        // Only the lock itself can end up here: reading and writing report through `takeLocked`. A
        // directory that cannot be written has no room for the lock either, and that is not a wait.
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'EACCES' || code === 'EROFS' || code === 'ENOSPC'
          ? refused('unwritable', null, wanted, code)
          : refused('busy', null, wanted, 'another run holds the ledger');
      }
    },
    peek() {
      const read = readLedgerFile(path);
      if (read.kind === 'problem') return Promise.resolve({ ok: false, problem: read.problem });
      const stored = read.kind === 'ledger' ? read.ledger : null;
      return Promise.resolve({ ok: true, used: stored?.used ?? 0, limit: capOf(stored) });
    },
  };
}

/**
 * The ledger at `options.path` (the caller passes `process.env.STROQ_LIVE_LEDGER`), or one in memory
 * when there is no path. Throws for a cap that is not a whole number a ledger file can hold.
 */
export function openLedger(options: LedgerOptions): Ledger {
  if (!isCount(options.limit) || options.limit > MAX_LEDGER_LIMIT)
    throw new Error(`the cap must be a whole number from 1 to ${MAX_LEDGER_LIMIT}`);
  const path = options.path;
  return path === undefined || path === ''
    ? memoryLedger(options.limit)
    : fileLedger(path, options.limit, options);
}
