import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * A proxy whose server has closed must be able to exit. The kill ladder is armed by a
 * relayed signal or by the end of the client's input, and cleared once the server has
 * closed; but the queues of lines the server wrote before closing are drained AFTER
 * that, and a withheld flood that crosses the strict cap while they drain asks for the
 * server to be stopped. That request, for a server that is already gone, used to arm a
 * kill timer nothing cleared: the run was over and the process stayed up for the whole
 * grace period.
 */

const BURST_SERVER = join(import.meta.dirname, 'strict-burst-server.mjs');
/** Not a delay anything else in the proxy uses, so the timers of the kill ladder can be told apart. */
const GRACE_MS = 54_321;

let home = '';
let savedHome: string | undefined;
let armed: NodeJS.Timeout[] = [];
let cleared: unknown[] = [];

beforeEach(() => {
  savedHome = process.env['STROQ_HOME'];
  home = mkdtempSync(join(tmpdir(), 'stroq-lingering-'));
  process.env['STROQ_HOME'] = home;
  armed = [];
  cleared = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const timer = realSet(handler, delay, ...rest);
    if (delay === GRACE_MS || delay === GRACE_MS * 2) armed.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: NodeJS.Timeout) => {
    cleared.push(timer);
    realClear(timer);
  }) as unknown as typeof clearTimeout);
});

afterEach(() => {
  // Whatever a failing test left armed must not keep the test process up.
  const realClear = clearTimeout;
  vi.restoreAllMocks();
  for (const timer of armed) realClear(timer);
  if (savedHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function runBurst(strictMaxWithheld: number, lines: number): Promise<number> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.resume();
  stderr.resume();
  process.env['BURST_LINES'] = String(lines);
  try {
    return await runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:lingering',
      server: 'srv',
      cwd: home,
      passEnv: ['BURST_LINES'],
      command: process.execPath,
      args: [BURST_SERVER],
      stdin,
      stdout,
      stderr,
      strict: true,
      strictMaxWithheld,
      shutdownGraceMs: GRACE_MS,
    });
  } finally {
    delete process.env['BURST_LINES'];
  }
}

describe('a strict server that closes while a flood of its lines is still queued', () => {
  it('leaves no kill timer armed once the run is over, when the flood crosses the cap', async () => {
    // Late in the flood, so the server has closed by the time the cap is crossed.
    const code = await runBurst(100, 200);
    expect(code).toBe(1);
    expect(armed.filter((timer) => !cleared.includes(timer))).toEqual([]);
  }, 30_000);

  it('leaves no kill timer armed when it does not cross the cap either', async () => {
    const code = await runBurst(1000, 5);
    expect(code).toBe(0);
    expect(armed.filter((timer) => !cleared.includes(timer))).toEqual([]);
  }, 30_000);
});
