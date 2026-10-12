import { afterEach, beforeEach } from 'vitest';
import { createClaudeDriver } from '../../../src/live/drivers/claude.js';
import { type HostDriver } from '../../../src/live/types.js';
import { NONCE, SESSION } from '../helpers.js';
import { makeRig, type Rig } from '../rig.js';
import { type FakeClaude, isAlive, makeFakeClaude } from './fake-claude.js';
import { linesOf, readFixture, STREAMS, withProvider } from './fixtures.js';

/**
 * The driver against a program that stands in for `claude`: a real process with an argv, an environment, a
 * working directory and pipes, which prints what the cleaned real streams say (and misbehaves on demand).
 * The real `claude` is never started here.
 */
export const HOOK_LINE = '"/usr/local/bin/node" "/opt/stroq/dist/index.js" hook claude-code';

export let rig: Rig;
export let fake: FakeClaude;
beforeEach(() => {
  rig = makeRig(false);
  fake = makeFakeClaude();
});
afterEach(() => {
  fake.cleanup();
  rig.cleanup();
});

export const driverOf = (
  over: Partial<Parameters<typeof createClaudeDriver>[0]> = {},
): HostDriver =>
  createClaudeDriver({ hookLine: HOOK_LINE, bin: fake.bin, killGraceMs: 200, ...over });

/** The env a driver is given by `verifyHost`: nothing of the caller's but what the host needs. */
export const ENV = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: '/home/someone',
  LANG: 'C',
};

export const ctxFor = (over: Parameters<Rig['ctx']>[0] = {}): ReturnType<Rig['ctx']> =>
  rig.ctx({ sessionId: SESSION, nonce: NONCE, env: ENV, deadlineMs: 20_000, ...over });

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The deadline of a request in a test of a host that never ends. It has to be long enough for the stand-in to
 * start, print and start a child of its own on a machine that is busy (a process of Node takes a second or two
 * to start then), and it is what a test of the deadline waits for in full.
 */
export const SLOW_START_MS = 3_000;

export async function untilDead(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (!isAlive(pid)) return true;
    await wait(25);
  }
  return false;
}

export const lines = (stream: keyof typeof STREAMS, provider = true): string[] =>
  linesOf(
    provider
      ? withProvider(readFixture(STREAMS[stream]), 'firstParty')
      : readFixture(STREAMS[stream]),
  );

export const INIT_WITH_KEY = (source: string): string =>
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/project', apiKeySource: source });
export const MORE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'DONE',
});
