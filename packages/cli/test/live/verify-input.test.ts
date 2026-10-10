import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { LiveCheckError } from '../../src/live/errors.js';
import type { HostDriver, HostRun } from '../../src/live/types.js';
import { verifyHost } from '../../src/live/verify.js';
import { FakeHostDriver } from './fake-driver.js';
import { finished } from './helpers.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify, verifyOptions } from './verify-harness.js';

/**
 * What `verifyHost` is handed comes from outside: a command line, a driver that talks to a program we
 * do not control. Each of it is looked at before anything is asked, spent or written, and what is wrong
 * with it is said with an error that has a code, and is not a throw somewhere in the middle of a run
 * that has already been paid for.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  vi.useRealTimers();
  rig.cleanup();
});

describe('the options and the context of a run', () => {
  const refused = async (
    options: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ): Promise<{ error: LiveCheckError; driver: FakeHostDriver; taken: number }> => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    let taken = 0;
    const inner = openLedger({ memory: true, limit: 30 });
    const ledger = {
      take: (n: number, reason: string) => {
        taken += 1;
        return inner.take(n, reason);
      },
      peek: () => inner.peek(),
    };
    let error: unknown;
    try {
      await verifyHost(driver, { ...rig.ctx(), ...context }, {
        ...verifyOptions({ ledger }),
        ...options,
      } as never);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LiveCheckError);
    return { error: error as LiveCheckError, driver, taken };
  };

  it.each([
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['not a whole number', 1.5],
    ['text', '3'],
    ['null', null],
  ])('refuses a number of requests that is %s', async (_name, maxRequests) => {
    const { error, driver, taken } = await refused({ maxRequests });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/maxRequests/);
    expect(error.message).toMatch(/^[\x20-\x7e]+$/);
    expect(driver.detections).toBe(0);
    expect(driver.calls).toEqual([]);
    expect(taken).toBe(0);
  });

  it.each([0, 1, 3, 6])('takes %s as the number of requests', async (maxRequests) => {
    const driver = new FakeHostDriver({ fault: 'refusal' });
    await expect(verify(rig, driver, { maxRequests })).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -5],
    ['zero', 0],
    ['not a whole number', 2.5],
    ['text', '5000'],
    ['more than a timer can count', 2 ** 31],
    ['missing', undefined],
  ])('refuses a deadline that is %s', async (_name, deadlineMs) => {
    const { error, driver, taken } = await refused({}, { deadlineMs });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/deadlineMs/);
    expect(driver.detections).toBe(0);
    expect(taken).toBe(0);
  });

  it.each([1, 5_000, 600_000])('takes %s ms as a deadline', async (deadlineMs) => {
    const driver = new FakeHostDriver({ fault: 'refusal' });
    await expect(
      verifyHost(driver, rig.ctx({ deadlineMs }), verifyOptions()),
    ).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['not a whole number', 0.5],
    ['text', '50'],
  ])('refuses a grace that is %s', async (_name, graceMs) => {
    const { error } = await refused({ graceMs });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/graceMs/);
  });

  it('takes a grace of nothing, and refuses a deadline and a grace together that no timer can count', async () => {
    const driver = new FakeHostDriver({ fault: 'refusal' });
    await expect(verify(rig, driver, { graceMs: 0 })).resolves.toMatchObject({ version: 1 });
    const { error } = await refused({ graceMs: 2 ** 30 }, { deadlineMs: 2 ** 30 + 5 });
    expect(error.code).toBe('invalid-option');
  });

  it.each([
    ['not a number', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a time to look for the host that is %s', async (_name, detectMs) => {
    const { error } = await refused({ detectMs });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/detectMs/);
  });

  it.each([
    ['empty', ''],
    ['with a new line', '0.23.0\nfake line'],
    ['longer than a result can hold', 'v'.repeat(81)],
    ['not text', 23],
    ['with an escape in it', '0.23.0\u001b[2J'],
  ])('refuses a version of Stroq that is %s, which the result could not hold', async (_n, v) => {
    const { error } = await refused({ stroqVersion: v });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/stroqVersion/);
  });

  it.each([
    ['without a ledger', { ledger: undefined }],
    ['with a ledger that cannot take', { ledger: { peek: () => Promise.resolve({ ok: true }) } }],
    ['with a mode of its own', { mode: 'real' }],
    ['without a policy', { policy: undefined }],
    ['with a policy that is not one', { policy: { rules: 'all' } }],
  ])('refuses options %s', async (_name, options) => {
    const { error, driver } = await refused(options);
    expect(error.code).toBe('invalid-option');
    expect(driver.detections).toBe(0);
  });

  it('refuses an agent that is not an agent with the same typed error', async () => {
    const { error } = await refused({ agent: '../claude-code' });
    expect(error.code).toBe('invalid-option');
    expect(error.message).toMatch(/not an agent name/);
  });

  it('writes nothing, to the project or the home of the check, for options it refuses', async () => {
    await refused({ maxRequests: -1 });
    expect(existsSync(join(rig.project, '.env'))).toBe(false);
    expect(existsSync(join(rig.stroqHome, 'policy.yaml'))).toBe(false);
  });
});

describe('what a driver says when it is asked for the host', () => {
  const detecting = (detect: HostDriver['detect']): HostDriver => ({
    detect,
    run: () => Promise.resolve(finished([])),
  });

  it('is nothing to wait for ever: a driver that does not answer is a host that is not there', async () => {
    const driver = detecting(() => new Promise(() => undefined));
    const result = await verify(rig, driver, { detectMs: 20 });
    expect(result.state).toBe('not-attempted');
    expect(result.probes[0]).toMatchObject({ mark: 'not-attempted', reason: 'host-not-found' });
    expect(result.caveats).toContain('the driver did not answer when it was asked for the host');
  });

  it('leaves no timer running behind a driver that answered', async () => {
    vi.useFakeTimers();
    const driver = detecting(() => Promise.resolve({ available: false, version: null }));
    await verifyHost(driver, rig.ctx(), verifyOptions());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has a version of nothing for a driver that gives none, which is a version that is not known', async () => {
    const driver = detecting(() => Promise.resolve({ available: true } as never));
    const result = await verify(rig, driver, { maxRequests: 0 });
    expect(result.hostVersion).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['a number', 2],
    ['an object', {}],
  ])('has no version for a driver that gives %s as the version', async (_name, version) => {
    const driver = detecting(() => Promise.resolve({ available: true, version } as never));
    const result = await verify(rig, driver, { maxRequests: 0 });
    expect(result.hostVersion).toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'yes'],
    ['a list', []],
    ['an answer that does not say whether the host is there', { version: '1.0' }],
    ['an answer that says so in text', { available: 'yes' }],
  ])(
    'takes %s for a host that is not there, and says the driver did not say',
    async (_n, value) => {
      const driver = detecting(() => Promise.resolve(value as never));
      const result = await verify(rig, driver);
      expect(result.state).toBe('not-attempted');
      expect(result.probes[0]?.reason).toBe('host-not-found');
      expect(result.probes[0]?.detail).toMatch(/^[\x20-\x7e]+$/);
    },
  );

  it.each(['', '   ', '\n\t', '\u001b[2J'])(
    'gives a note that is %j, which says nothing, the words of a host that is not found',
    async (note) => {
      const driver = detecting(() => Promise.resolve({ available: false, version: null, note }));
      const result = await verify(rig, driver);
      expect(result.probes[0]?.detail).toMatch(/^[\x20-\x7e]+$/);
      expect(result.probes[0]?.detail).not.toBe('');
      if (note.trim() === '') expect(result.probes[0]?.detail).toBe('the host was not found');
    },
  );

  it('does not put a blank note among the caveats of a host that was found', async () => {
    const driver = detecting(() => Promise.resolve({ available: true, version: '1', note: '  ' }));
    const result = await verify(rig, driver, { maxRequests: 0 });
    expect(result.caveats).toEqual([]);
  });

  it('keeps the note a driver gives, as a line of plain characters', async () => {
    const driver = detecting(() =>
      Promise.resolve({ available: false, version: null, note: 'claude is not\non the path' }),
    );
    const result = await verify(rig, driver);
    expect(result.probes[0]?.detail).toBe('claude is not on the path');
  });
});

describe('what a driver says of a request', () => {
  const answering = (run: () => unknown): HostDriver => ({
    detect: () => Promise.resolve({ available: true, version: '1.0.0' }),
    run: () => Promise.resolve(run() as HostRun),
  });

  it.each([
    ['a null in the stream', () => ({ ...finished([]), stream: [null, { type: 'result' }] })],
    ['a number in the stream', () => ({ ...finished([]), stream: [7] })],
    ['billing that is not text', () => ({ ...finished([]), apiKeySource: 5 })],
    ['a provider that is not text', () => ({ ...finished([]), apiProvider: {} })],
    ['no run at all', () => undefined],
    ['text for a run', () => 'DONE'],
  ])(
    'is a run that cannot be read, and not a throw after the request was paid for, with %s',
    async (_name, run) => {
      const ledger = openLedger({ memory: true, limit: 30 });
      const result = await verify(rig, answering(run), { ledger });
      expect(marksOf(result).allow).toBe('inconclusive:unparsable-stream');
      // The request was paid for and the result says what became of it.
      expect(await ledger.peek()).toMatchObject({ used: 1 });
      expect(result.state).toBe('inconclusive');
    },
  );

  it('goes on to the next request when a run was unreadable but the host had said how it is paid for', async () => {
    let n = 0;
    const driver = answering(() => {
      n += 1;
      return n === 1 ? finished([]) : { ...finished([]), stream: [null] };
    });
    const result = await verify(rig, driver);
    expect(n).toBe(3);
    expect(marksOf(result).deny).toBe('inconclusive:unparsable-stream');
  });
});
