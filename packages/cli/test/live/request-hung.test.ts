import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_PACKAGE, TSX_ARGS } from './child.js';

/**
 * The check gives up on a driver that does not answer: after the deadline of a request and a short grace,
 * and after the time a driver is given to say whether its host is there. That only works if the timers that
 * do the giving up keep the process alive. A timer that does not leaves a process whose driver holds nothing
 * (it has not started its host, or the host is already gone) with an empty event loop, and Node ends it on
 * the spot with nothing said, which a script reads as a check that was all right.
 */
const CHILD = fileURLToPath(new URL('./hung-child.ts', import.meta.url));
/** Far above what the child needs, and below the 90 s the test is given; it ends a hang. */
const CHILD_TIMEOUT_MS = 60_000;

describe('a driver that never answers and holds nothing', () => {
  it('is waited for until its deadline, and then it is a run that timed out, in a process nothing else keeps alive', () => {
    const child = spawnSync(process.execPath, [...TSX_ARGS, CHILD], {
      cwd: CLI_PACKAGE,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    // The process ended by itself, having got to the end, and not early with the check unfinished.
    expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
    expect(JSON.parse(child.stdout) as unknown).toEqual({
      found: {
        available: false,
        version: null,
        note: 'the driver did not answer when it was asked for the host',
      },
      timedOut: true,
    });
  }, 90_000);
});
