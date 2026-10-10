import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeHostDriver, type Fault } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * What the hook is said to have done is read from its own audit log, request by request. These are the
 * ways that reading went wrong before: a host that gave its hook a session of its own looked like a hook
 * that never ran; and a hook that never ran for one request looked as if it had, because the log held
 * the entries of an earlier one. And two ways a run can fool a reading that only looks for the nonce.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const PASSED = {
  allow: 'passed:ran',
  deny: 'passed:blocked',
  'secret-egress': 'passed:blocked',
};

describe('a host that gives its hook a session of its own', () => {
  it('is not taken for a hook that never ran: the nonce, and not the session, ties an entry to a request', async () => {
    const driver = new FakeHostDriver({ fault: 'honest', hostSession: true });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toMatchObject(PASSED);
    expect(result.state).toBe('verified');
    // The entries are there, under sessions the check never asked for.
    const sessions = new Set((await rig.audit()).map((entry) => entry.sessionId));
    expect([...sessions].every((id) => id.startsWith('host-chose-'))).toBe(true);
    expect(sessions.size).toBeGreaterThan(0);
  });
});

describe('a hook that never ran for one request, after it ran for another', () => {
  it('is bypassed for that request, although the log holds the entries of the first', async () => {
    const fault = (probe: { kind: string }): Fault =>
      probe.kind === 'deny' ? 'never-call-hook' : 'honest';
    const result = await verify(rig, new FakeHostDriver({ fault }), { control: false });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'failed:hook-bypassed',
      'secret-egress': 'passed:blocked',
    });
    expect(result.state).toBe('failed');
    // The log was not empty when the deny probe was judged: the allow probe had left its entry.
    expect((await rig.audit()).length).toBeGreaterThan(0);
  });

  it('is not a hook that left no entry when the log has entries of its own for the request', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { control: false });
    expect(marksOf(result)).toMatchObject(PASSED);
  });
});

describe('a model that does more than the one command', () => {
  it('makes a request inconclusive when the hook was asked about a second command', async () => {
    const driver = new FakeHostDriver({ fault: 'extra-command' });
    const result = await verify(rig, driver, { control: false });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:extra-activity',
      deny: 'inconclusive:extra-activity',
      'secret-egress': 'inconclusive:extra-activity',
    });
    expect(result.state).toBe('inconclusive');
  });

  it('makes a request inconclusive, and not a pass, when the command was changed', async () => {
    const driver = new FakeHostDriver({ fault: 'altered-command' });
    const result = await verify(rig, driver, { control: false });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:command-altered',
      deny: 'inconclusive:command-altered',
      'secret-egress': 'inconclusive:command-altered',
    });
    expect(result.state).toBe('inconclusive');
    expect(result.probes[0]?.evidence.E1).toBe(false);
  });

  it('does not let a control stand on a command that was changed', async () => {
    const driver = new FakeHostDriver({
      fault: (_probe, ctx) => (ctx.hookMode === 'noop' ? 'altered-command' : 'honest'),
    });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toMatchObject({
      deny: 'inconclusive:control-inconclusive',
      'deny:control': 'inconclusive:command-altered',
    });
    expect(result.state).toBe('inconclusive');
  });
});
