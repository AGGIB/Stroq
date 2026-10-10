import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { FakeHostDriver } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * The control is part of the check and is on unless it is turned off. These are the runs in which it is
 * off: what can still be seen without it (a host that ignores a deny, a hook that is bypassed), and what
 * cannot (a deny that was stopped is not proven to matter, so no host is verified).
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const PASSED_ALLOW = 'passed:ran';
const UNPROVEN = 'inconclusive:deny-not-proven-armed';
const same = (mark: string): Record<string, string> => ({
  allow: mark,
  deny: mark,
  'secret-egress': mark,
});

// With the control turned off the denies that were stopped are not proven to be anything: the host's own
// rules, or a command that could not run here, would have left the file absent just the same.
describe('a run with the control turned off', () => {
  it('can verify no host: a deny that was stopped is not proven armed', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger, control: false });
    expect(marksOf(result)).toEqual({
      allow: PASSED_ALLOW,
      deny: UNPROVEN,
      'secret-egress': UNPROVEN,
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(3);
    expect(await ledger.peek()).toMatchObject({ used: 3 });
    expect(result.caveats).toContain('no-control-run');
    expect(result.probes.find((p) => p.id === 'deny')?.detail).toMatch(/no control run was made/);
  });

  it('keeps the evidence of the stopped denies, which was good', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { control: false });
    expect(result.probes[1]?.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
  });

  it('still fails a host that ignores a deny, which needs no control to be seen', async () => {
    const driver = new FakeHostDriver({ fault: 'ignore-deny' });
    const result = await verify(rig, driver, { control: false });
    expect(result.state).toBe('failed');
    expect(driver.calls).toHaveLength(3);
  });

  it.each(['never-call-hook', 'crash-fail-open', 'noop-hook'] as const)(
    'still fails a hook that is bypassed (%s)',
    async (fault) => {
      const result = await verify(rig, new FakeHostDriver({ fault }), { control: false });
      expect(marksOf(result)).toEqual(same('failed:hook-bypassed'));
      expect(result.state).toBe('failed');
    },
  );

  it('does not verify a host whose own rules block everything, with or without the control', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'host-blocks-all' }), {
      control: false,
    });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:effect-missing',
      deny: UNPROVEN,
      'secret-egress': UNPROVEN,
    });
    expect(result.state).toBe('inconclusive');
  });
});
