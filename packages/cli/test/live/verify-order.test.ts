import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { expectedDecision } from '../../src/live/expectation.js';
import type { HostDriver } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { finished } from './helpers.js';
import { makeRig, type Rig } from './rig.js';
import { verify } from './verify-harness.js';

// The real engine, counted: the questions put to it are what these tests are about.
vi.mock('../../src/live/expectation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/live/expectation.js')>();
  return { ...actual, expectedDecision: vi.fn(actual.expectedDecision) };
});

/**
 * The policy is asked about every probe before the first request is made. A question that fails
 * after a request has been spent would lose what that request found; asked first, it costs nothing.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
  vi.mocked(expectedDecision).mockClear();
});
afterEach(() => {
  rig.cleanup();
});

describe('what comes before the first request', () => {
  it('is a question to the policy about each of the three probes', async () => {
    let asked = -1;
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => {
        if (asked < 0) asked = vi.mocked(expectedDecision).mock.calls.length;
        return Promise.resolve(finished([]));
      },
    };
    await verify(rig, driver);
    expect(asked).toBe(3);
  });

  it('is the whole of a run that cannot ask: nothing is spent, and nothing was made', async () => {
    const real = vi.mocked(expectedDecision).getMockImplementation();
    if (real === undefined) throw new Error('the mock has no implementation');
    vi.mocked(expectedDecision)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => Promise.reject(new Error('the engine broke')));
    const driver = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ limit: 30 });
    await expect(verify(rig, driver, { ledger })).rejects.toThrow('the engine broke');
    expect(driver.calls).toEqual([]);
    expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 30 });
  });
});
