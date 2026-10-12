// The doing of `stroq prove`: a folder of its own, the host driven in it, the result kept, and the folder
// gone, however it ends.
//
// The folder (`live/throwaway.ts`) holds the project the host is started in, the made-up key, the HOME and
// the Stroq home the hook writes its audit log to. It is removed in a `finally`, and also when the process
// is told to stop (Ctrl-C, a hang-up, a termination): a signal ends a process without running a `finally`,
// so what has to be undone is registered with `onInterrupt`, and a handler runs it before the signal is
// raised again for what it was going to do. The host is started in a process group of its own and does not
// see Ctrl-C, so the same handler ends it.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Policy } from '@stroq/core';
import { hookCommand } from './hook-command.js';
import { LiveCheckError } from '../live/errors.js';
import type { Ledger } from '../live/budget.js';
import { writeHostResult, type StoredSlot } from '../live/store.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../live/throwaway.js';
import type { HostDriver, HostResult } from '../live/types.js';
import { verifyHost } from '../live/verify.js';
import type { IdSource } from '../live/verify-types.js';
import { liveLastFileIn, liveResultFileIn, liveStandInFileIn, stroqHome } from '../paths.js';
import { onInterrupt, runInterruptCleanups } from '../ui/cleanup.js';
import { probeName } from './prove-text.js';
import type { SignalSource } from './prove-types.js';

/** How long one request may take: a host that has not answered by then is stopped. */
export const REQUEST_DEADLINE_MS = 90_000;

/** The line `stroq init` writes for `agent`, for the Stroq that is running (not the npx cache's copy of it). */
export function defaultHookLine(agent: string): string {
  const launched = resolve(process.argv[1] ?? '');
  let entry = launched;
  try {
    entry = realpathSync(launched);
  } catch {
    // Not a file we can resolve: the line is built from the path as it was given.
  }
  return hookCommand(process.execPath, entry, agent);
}

/** The environment as the plain record a child process takes. */
export const stringsOf = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

/** The signals that end a process without running a `finally`. */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Runs what is registered for an interrupt when one of the signals comes, then ends the process as it would end. */
function listenForSignals(
  source: SignalSource,
  reraise: (signal: NodeJS.Signals) => void,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const stopListening = (): void => {
    for (const [signal, handler] of handlers) source.off(signal, handler);
    handlers.clear();
  };
  for (const signal of ENDING_SIGNALS) {
    const handler = (): void => {
      stopListening();
      runInterruptCleanups();
      reraise(signal);
    };
    handlers.set(signal, handler);
    source.on(signal, handler);
  }
  return stopListening;
}

/** Says which request is being made, so that a minute of silence is not taken for a hang. */
function withProgress(driver: HostDriver, say: (text: string) => void, limit: number): HostDriver {
  let made = 0;
  return {
    detect: () => driver.detect(),
    run: (probe, ctx) => {
      made += 1;
      const control = ctx.hookMode === 'noop' ? ', hook out of the way' : '';
      say(`  request ${made} (of up to ${limit}): ${probeName(probe.id)}${control} ...\n`);
      return driver.run(probe, ctx);
    },
    ...(driver.mode === undefined ? {} : { mode: driver.mode }),
  };
}

export interface CheckInput {
  readonly agent: string;
  readonly driver: HostDriver;
  readonly policy: Policy;
  readonly stroqVersion: string;
  readonly ledger: Ledger;
  readonly maxRequests: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly controller: AbortController;
  readonly signals: SignalSource;
  readonly reraise: (signal: NodeJS.Signals) => void;
  readonly say: (text: string) => void;
  readonly warn: (text: string) => void;
  readonly now?: (() => Date) | undefined;
  readonly ids?: Partial<IdSource> | undefined;
}

/**
 * Makes the folder, runs the check in it, and removes it. Throws what the check throws, after the folder
 * is gone.
 */
export async function runCheck(input: CheckInput): Promise<HostResult> {
  const made = createThrowawayRoot('stroq-prove-');
  const forgetCleanup = onInterrupt(() => {
    input.controller.abort();
    removeThrowawayRoot(made.root);
  });
  const stopListening = listenForSignals(input.signals, input.reraise);
  try {
    return await verifyHost(
      withProgress(input.driver, input.say, input.maxRequests),
      {
        project: made.project,
        stroqHome: made.stroqHome,
        home: made.home,
        env: stringsOf(input.env),
        deadlineMs: REQUEST_DEADLINE_MS,
      },
      {
        agent: input.agent,
        policy: input.policy,
        stroqVersion: input.stroqVersion,
        ledger: input.ledger,
        maxRequests: input.maxRequests,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.ids === undefined ? {} : { ids: input.ids }),
      },
    );
  } finally {
    stopListening();
    forgetCleanup();
    try {
      removeThrowawayRoot(made.root);
    } catch (err) {
      input.warn(
        `stroq prove: could not remove ${made.root}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** The file a result was kept in, from the slot it went to. */
export function fileOfSlot(slot: StoredSlot, agent: string): string {
  const home = stroqHome();
  if (slot === 'stand-in') return liveStandInFileIn(home, agent);
  return slot === 'last' ? liveLastFileIn(home, agent) : liveResultFileIn(home, agent);
}

export type Kept =
  | { readonly kept: true; readonly file: string }
  | { readonly kept: false; readonly problem: string };

/** Keeps the result where `stroq doctor` reads it. A result that cannot be kept is still shown. */
export function keep(result: HostResult): Kept {
  try {
    return { kept: true, file: fileOfSlot(writeHostResult(stroqHome(), result), result.agent) };
  } catch (err) {
    return { kept: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What an error that stopped the check says, for a person. A temporary directory with a long name is the one
 * thing here a person can mend: the audit log keeps 300 characters of a command, and the commands of the
 * probes hold the path of the folder the check runs in.
 */
export function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof LiveCheckError && err.code === 'invalid-option' && /so long/.test(message)
    ? `${message}. Set TMPDIR to a shorter directory and run it again`
    : message;
}
