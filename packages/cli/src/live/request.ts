// One request to a host, and what it leaves behind.
//
// Four steps, and the order is the point. The request is taken from the ledger first, because a request
// that is made before it is paid for is a request the cap does not hold. The files a probe could leave
// are cleared next, so that one found afterwards was made by this request and by no earlier one. Then the
// host is asked. Only after it has finished is the disk read, and the hook's audit log: a file read
// while the host is still running measures the race and not the host.
import { AuditLog, type AuditEntry } from '@stroq/core';
import { auditFileIn } from '../paths.js';
import type { Ledger } from './budget.js';
import { plainText } from './evidence.js';
import { clearSentinel, readSentinel } from './probes.js';
import {
  REASONS,
  type HostDriver,
  type HostRun,
  type Probe,
  type ProbeContext,
  type SentinelState,
} from './types.js';

export type SessionAudit =
  | { readonly kind: 'read'; readonly entries: readonly AuditEntry[] }
  | { readonly kind: 'unreadable'; readonly problem: string };

/** Everything that was seen of one request, once the host had finished. */
export interface Observation {
  readonly run: HostRun;
  readonly sentinel: SentinelState;
  readonly audit: SessionAudit;
}

export type Requested =
  | { readonly sent: false; readonly reason: string; readonly detail: string }
  | { readonly sent: true; readonly observation: Observation };

/**
 * The entries of one session in the audit log of a throwaway Stroq home. A log that cannot be read
 * (a line cut in half by a hook that was killed) is not an empty one: "the hook left no entry" would
 * be a claim, and a false one, so the caller is told the log could not be read instead.
 */
export async function readSessionAudit(
  stroqHome: string,
  sessionId: string,
): Promise<SessionAudit> {
  try {
    const entries = await new AuditLog(auditFileIn(stroqHome)).readAll();
    return { kind: 'read', entries: entries.filter((entry) => entry.sessionId === sessionId) };
  } catch {
    return { kind: 'unreadable', problem: 'the audit log cannot be read' };
  }
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
  const run = await runGuarded(args.driver, args.probe, args.ctx, args.graceMs);
  return {
    sent: true,
    observation: {
      run,
      sentinel: readSentinel(args.ctx.project, args.probe),
      audit: await readSessionAudit(args.ctx.stroqHome, args.ctx.sessionId),
    },
  };
}
