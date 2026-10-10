// One request to a host, and what it leaves behind.
//
// Four steps, and the order is the point. The request is taken from the ledger first, because a request
// that is made before it is paid for is a request the cap does not hold. The files a probe could leave
// are cleared next, so that one found afterwards was made by this request and by no earlier one, and
// the audit log is looked at so that what the hook adds can be told from what was there. Then the host
// is asked. Only after it has finished is the disk read, and the hook's audit log: a file read while the
// host is still running measures the race and not the host.
import { AuditLog, type AuditEntry } from '@stroq/core';
import { auditFileIn } from '../paths.js';
import type { Ledger } from './budget.js';
import { isWellFormedRun, plainText } from './evidence.js';
import { clearSentinel, readSentinel } from './probes.js';
import {
  REASONS,
  type HostDriver,
  type HostRun,
  type Probe,
  type ProbeContext,
  type SentinelState,
} from './types.js';

/** What the hook's audit log held of one request: the entries it added, or why that cannot be said. */
export type RequestAudit =
  | { readonly kind: 'read'; readonly entries: readonly AuditEntry[] }
  | { readonly kind: 'unreadable'; readonly problem: string };

/** Everything that was seen of one request, once the host had finished. */
export interface Observation {
  readonly run: HostRun;
  readonly sentinel: SentinelState;
  readonly audit: RequestAudit;
}

export type Requested =
  | { readonly sent: false; readonly reason: string; readonly detail: string }
  | { readonly sent: true; readonly observation: Observation };

const UNREADABLE = 'the audit log cannot be read';

/** Where the audit log of a throwaway Stroq home has got to: the number of its newest entry. */
export type AuditPosition =
  | { readonly kind: 'at'; readonly seq: number }
  | { readonly kind: 'unreadable'; readonly problem: string };

/**
 * Every entry of the log, or why it cannot be had. A log that cannot be read (a line cut in half by a
 * hook that was killed), or one with an entry that is not an entry, is not an empty one: "the hook left no
 * entry" would be a claim, and a false one, so the caller is told the log could not be read instead.
 */
async function entriesOf(stroqHome: string): Promise<readonly AuditEntry[] | null> {
  try {
    const entries = await new AuditLog(auditFileIn(stroqHome)).readAll();
    const sound = entries.every(
      (entry) => typeof entry === 'object' && entry !== null && Number.isInteger(entry.seq),
    );
    return sound ? entries : null;
  } catch {
    return null;
  }
}

/** Where the log is now. The hook's entries for a request are the ones that come after this. */
export async function auditPosition(stroqHome: string): Promise<AuditPosition> {
  const entries = await entriesOf(stroqHome);
  if (entries === null) return { kind: 'unreadable', problem: UNREADABLE };
  return { kind: 'at', seq: entries.reduce((newest, entry) => Math.max(newest, entry.seq), 0) };
}

/**
 * The entries added to the audit log since `position`. They are not picked by session: the home is the
 * check's own, so they are the hook's, and a host is free to give its hook a session of its own choosing.
 */
export async function readAuditAfter(
  stroqHome: string,
  position: AuditPosition,
): Promise<RequestAudit> {
  if (position.kind === 'unreadable') return { kind: 'unreadable', problem: position.problem };
  const entries = await entriesOf(stroqHome);
  if (entries === null) return { kind: 'unreadable', problem: UNREADABLE };
  return { kind: 'read', entries: entries.filter((entry) => entry.seq > position.seq) };
}

/** What a run is taken to have been when the driver did not return one: it never got to the end. */
const didNotRun = (message: string): HostRun => ({
  stream: [],
  exitCode: null,
  timedOut: false,
  stderrTail: plainText(message, 200),
});

const HUNG: HostRun = { stream: [], exitCode: null, timedOut: true, stderrTail: '' };

/**
 * What an answer that is not in the shape of a run is taken to have been: a run whose stream could not be
 * read. A driver is code that talks to a program we do not control; what it returns is looked at before
 * it is used, so that a null where an event should be is a run that cannot be read and not a throw after
 * the request has been taken from the ledger.
 */
const NOT_A_RUN: HostRun = {
  stream: [],
  exitCode: 0,
  timedOut: false,
  stderrTail: '',
  unparsedLines: 1,
};

/**
 * Asks the driver, and never waits longer than the request's deadline and a short grace after it: a
 * driver is meant to enforce its own deadline, and one that does not must not hang the check. A
 * driver that throws, or that throws before it returns a promise, is a run that did not get to the end.
 */
async function runGuarded(
  driver: HostDriver,
  probe: Probe,
  ctx: ProbeContext,
  graceMs: number,
): Promise<HostRun> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<HostRun>((resolve) => {
    timer = setTimeout(() => resolve(HUNG), ctx.deadlineMs + graceMs);
    timer.unref();
  });
  const answered = Promise.resolve()
    .then(() => driver.run(probe, ctx))
    .catch((err: unknown) => didNotRun(err instanceof Error ? err.message : String(err)));
  try {
    return await Promise.race([answered, hung]);
  } finally {
    clearTimeout(timer);
  }
}

export async function makeRequest(args: {
  readonly driver: HostDriver;
  readonly ledger: Ledger;
  /** Why the request is made, as the ledger records it. */
  readonly label: string;
  readonly probe: Probe;
  readonly ctx: ProbeContext;
  readonly graceMs: number;
}): Promise<Requested> {
  const taken = await args.ledger.take(1, args.label);
  if (!taken.ok)
    return {
      sent: false,
      reason: REASONS.budget,
      detail: plainText(`the ledger refused the request: ${taken.why} (${taken.problem})`),
    };
  clearSentinel(args.ctx.project, args.probe);
  const before = await auditPosition(args.ctx.stroqHome);
  const answer: unknown = await runGuarded(args.driver, args.probe, args.ctx, args.graceMs);
  const run = isWellFormedRun(answer) ? answer : NOT_A_RUN;
  return {
    sent: true,
    observation: {
      run,
      sentinel: readSentinel(args.ctx.project, args.probe),
      audit: await readAuditAfter(args.ctx.stroqHome, before),
    },
  };
}
