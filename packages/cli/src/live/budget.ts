// The owner's budget for live checks.
//
// A live check spends requests on the owner's own account, from a usage limit their real work needs.
// So the cap is not a promise: it is a file that every request is taken from, under a lock, before the
// request is made. The file holds across runs and across processes, and nothing the model or the host
// says can raise it. A file that is not a ledger gives no requests at all, and neither does a ledger
// that was never told where to keep its count: a cap that every run starts over from zero is no cap.
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { withLock } from '@stroq/core';
import { LiveCheckError } from './errors.js';
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

/** The variable that names the ledger file of a live check. */
export const LEDGER_ENV = 'STROQ_LIVE_LEDGER';

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
  /** The file the count is kept in: an absolute path, so that it does not depend on where we are. */
  readonly path?: string | undefined;
  /**
   * Keep the count in memory, where it ends with the process. Has to be said: no path does not mean
   * this. It is for a test or a dry run, and never for a run that spends the owner's requests.
   */
  readonly memory?: boolean | undefined;
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

/** The cap in the file is the owner's; a caller that asks for more does not get it. */
const capOf = (stored: LedgerFile | null, wanted: number): number =>
  Math.min(stored?.limit ?? wanted, wanted);

/** What is in the ledger file, as a count; or why it cannot be read. */
function readCount(
  path: string,
  wanted: number,
): { readonly stored: LedgerFile | null; readonly limit: number } | { readonly problem: string } {
  const read = readLedgerFile(path);
  if (read.kind === 'problem') return { problem: read.problem };
  const stored = read.kind === 'ledger' ? read.ledger : null;
  return { stored, limit: capOf(stored, wanted) };
}

/** One request for requests, with the file read and written. It runs inside the lock. */
function takeLocked(
  path: string,
  wanted: number,
  now: () => Date,
  n: number,
  reason: string,
): TakeResult {
  const counted = readCount(path, wanted);
  if ('problem' in counted) return refused('unreadable', null, wanted, counted.problem);
  const { stored, limit } = counted;
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
}

/** Takes under the lock of the file, or says why the lock could not be had. */
async function takeUnderLock(
  path: string,
  wanted: number,
  options: LedgerOptions,
  n: number,
  reason: string,
): Promise<TakeResult> {
  const now = options.now ?? ((): Date => new Date());
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
    return await withLock(
      `${path}.lock`,
      () => Promise.resolve(takeLocked(path, wanted, now, n, reason)),
      {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      },
    );
  } catch (err) {
    // Only the lock itself can end up here: reading and writing report through `takeLocked`. A
    // directory that cannot be written has no room for the lock either, and that is not a wait.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EROFS' || code === 'ENOSPC'
      ? refused('unwritable', null, wanted, code)
      : refused('busy', null, wanted, 'another run holds the ledger');
  }
}

function fileLedger(path: string, wanted: number, options: LedgerOptions): Ledger {
  return {
    take: (n, reason) =>
      isCount(n)
        ? takeUnderLock(path, wanted, options, n, reason)
        : Promise.resolve(refused('invalid-request', null, wanted, 'not a count')),
    peek() {
      const counted = readCount(path, wanted);
      if ('problem' in counted) return Promise.resolve({ ok: false, problem: counted.problem });
      return Promise.resolve({ ok: true, used: counted.stored?.used ?? 0, limit: counted.limit });
    },
  };
}

const unusable = (problem: string): LiveCheckError => new LiveCheckError('invalid-ledger', problem);

/**
 * The ledger at `options.path`, or, when `memory: true` is said, one in memory. Throws, and does not
 * fall back on anything, for a cap that is not a whole number a ledger file can hold, for no path
 * without `memory: true`, for an empty or relative path, and for a path and `memory: true` together.
 */
export function openLedger(options: LedgerOptions): Ledger {
  if (!isCount(options.limit) || options.limit > MAX_LEDGER_LIMIT)
    throw unusable(`the cap must be a whole number from 1 to ${MAX_LEDGER_LIMIT}`);
  const path = options.path;
  if (options.memory === true) {
    if (path !== undefined) throw unusable('a ledger is kept in memory or in a file, and not both');
    return memoryLedger(options.limit);
  }
  if (path === undefined)
    throw unusable(
      'a ledger needs the absolute path of its file, or {memory: true} said out loud: a count that nothing keeps is no cap',
    );
  if (path === '' || path.includes('\u0000') || !isAbsolute(path))
    throw unusable('the path of a ledger has to be absolute and not empty');
  return fileLedger(path, options.limit, options);
}

/**
 * The ledger of the owner, from the environment: the file `STROQ_LIVE_LEDGER` names, with the cap of
 * `LIVE_REQUEST_LIMIT`. Throws when it is not set, is empty, or does not name a usable place, because a
 * live check that cannot count its requests must not make them.
 */
export function ledgerFromEnv(env: Readonly<Record<string, string | undefined>>): Ledger {
  const path = env[LEDGER_ENV];
  if (path === undefined || path === '')
    throw unusable(`${LEDGER_ENV} is not set: there is no ledger file to count the requests in`);
  try {
    return openLedger({ path, limit: LIVE_REQUEST_LIMIT });
  } catch (err) {
    if (err instanceof LiveCheckError) throw unusable(`${LEDGER_ENV}: ${err.message}`);
    throw err;
  }
}
