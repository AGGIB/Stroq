import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { openLedger } from '../../src/live/budget.js';
import { policySha256 } from '../../src/live/policy-digest.js';
import { parseHostResult } from '../../src/live/types.js';
import { FakeHostDriver, type Fault } from './fake-driver.js';
import { makeRig, type Rig } from './rig.js';
import { NOW, marksOf, verify } from './verify-harness.js';

/**
 * The fault matrix: for every way a host, a hook or a model can go wrong, the mark each probe gets, the
 * reason, the state of the host as a whole, and how many requests it cost. The double stands in for the
 * host (so this proves the orchestration and the evidence rules, and nothing about a real host), but
 * the hook in `honest` mode is the real engine and the audit entries are the real ones.
 *
 * The line this table exists to hold: a host is verified only by the run in which nothing went wrong.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const PASSED_ALLOW = 'passed:ran';
const STOPPED = 'passed:blocked';
const ARMED = 'passed:armed';
const UNARMED = 'inconclusive:probe-not-armed';
const UNPROVEN = 'inconclusive:deny-not-proven-armed';

type Marks = Record<string, string>;
const same = (mark: string): Marks => ({ allow: mark, deny: mark, 'secret-egress': mark });

// A host is verified only when the allow passed and a deny was stopped AND the same deny, under a hook
// that allows everything, was run by the host and left its file. So the control is part of the check, it
// is on unless it is turned off, and a run with it off can be anything but verified.
describe('every fault, with the control on (as it is unless turned off)', () => {
  const matrix: ReadonlyArray<readonly [Fault, Marks, string, number]> = [
    [
      'honest',
      {
        allow: PASSED_ALLOW,
        deny: STOPPED,
        'secret-egress': STOPPED,
        'deny:control': ARMED,
        'secret-egress:control': ARMED,
      },
      'verified',
      5,
    ],
    [
      'ignore-deny',
      {
        allow: PASSED_ALLOW,
        deny: 'failed:executed-despite-deny',
        'secret-egress': 'failed:executed-despite-deny',
      },
      'failed',
      3,
    ],
    ['never-call-hook', same('failed:hook-bypassed'), 'failed', 3],
    ['crash-fail-open', same('failed:hook-bypassed'), 'failed', 3],
    ['noop-hook', same('failed:hook-bypassed'), 'failed', 3],
    ['refusal', same('not-issued:not-issued'), 'inconclusive', 3],
    [
      'limit',
      {
        allow: 'inconclusive:limit',
        deny: 'not-attempted:limit',
        'secret-egress': 'not-attempted:limit',
      },
      'inconclusive',
      1,
    ],
    [
      'limit-flagged',
      {
        allow: 'inconclusive:limit',
        deny: 'not-attempted:limit',
        'secret-egress': 'not-attempted:limit',
      },
      'inconclusive',
      1,
    ],
    // A stream that cannot be read says nothing of how the host is paid for either, and nothing more is
    // asked of a host that has not said (`verify-billing.test.ts`).
    [
      'garbage',
      {
        allow: 'inconclusive:unparsable-stream',
        deny: 'not-attempted:billing-unknown',
        'secret-egress': 'not-attempted:billing-unknown',
      },
      'inconclusive',
      1,
    ],
    [
      'timeout',
      {
        allow: 'inconclusive:timeout',
        deny: 'not-attempted:timeout',
        'secret-egress': 'not-attempted:timeout',
      },
      'inconclusive',
      1,
    ],
    [
      'host-error',
      {
        allow: 'inconclusive:host-error',
        deny: 'not-attempted:host-error',
        'secret-egress': 'not-attempted:host-error',
      },
      'inconclusive',
      1,
    ],
    [
      'api-billing',
      {
        allow: 'inconclusive:api-billing',
        deny: 'not-attempted:api-billing',
        'secret-egress': 'not-attempted:api-billing',
      },
      'inconclusive',
      1,
    ],
    // The host's own permissions block everything: the hook said deny and nothing ran, which is what a
    // stop looks like, and the control shows it is not the hook's doing, because with the hook out of
    // the way nothing ran either.
    [
      'host-blocks-all',
      {
        allow: 'inconclusive:effect-missing',
        deny: UNARMED,
        'secret-egress': UNARMED,
        'deny:control': UNARMED,
        'secret-egress:control': UNARMED,
      },
      'inconclusive',
      5,
    ],
  ];

  it.each(matrix)('%s', async (fault, expected, state, requests) => {
    const driver = new FakeHostDriver({ fault });
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual(expected);
    expect(result.state).toBe(state);
    // Verified is the one thing only the run in which nothing went wrong can be.
    expect(result.state === 'verified').toBe(fault === 'honest');
    expect(driver.calls).toHaveLength(requests);
    expect(await ledger.peek()).toEqual({ ok: true, used: requests, limit: 30 });
    // A double is a double, and the result says so.
    expect(result.mode).toBe('stand-in');
    // Whatever the run came to, what it wrote down is something the store will take back.
    expect(parseHostResult(JSON.parse(JSON.stringify(result))).ok).toBe(true);
  });

  // A policy that disagrees with the one the check expects is the hook's fault, not the host's, and it is
  // told apart from a host that ignores a deny.
  it('tells a hook that judged otherwise from a host that ignored a deny', async () => {
    const lax: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== 'deny-git-exec'),
    };
    const driver = new FakeHostDriver({ fault: 'honest', hookPolicy: lax });
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: PASSED_ALLOW,
      deny: 'failed:policy-mismatch',
      'secret-egress': STOPPED,
      'secret-egress:control': ARMED,
    });
    expect(result.state).toBe('failed');
    expect(result.probes.find((p) => p.id === 'deny')?.detail).toBe(
      'the audit says allow (no rule); expected deny (deny-git-exec)',
    );
  });

  it('records the evidence of each probe beside its mark', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'ignore-deny' }));
    const byId = Object.fromEntries(result.probes.map((p) => [p.id, p.evidence]));
    expect(byId['allow']).toEqual({ E1: true, E2: true, E3: true, E4: null });
    // E3 is false for a deny whose file appeared; E4 is false because the host passed on nothing of the hook's.
    expect(byId['deny']).toEqual({ E1: true, E2: true, E3: false, E4: false });
  });

  it('records the evidence of a control as the control found it', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }));
    const byId = Object.fromEntries(result.probes.map((p) => [p.id, p.evidence]));
    // The hook is not asked in a control run, so there is no verdict of it to record, and nothing to
    // find the host's words in; the command was issued and its file came.
    expect(byId['deny:control']).toEqual({ E1: true, E2: null, E3: true, E4: null });
  });

  it('keeps the evidence it found for a probe the run then made inconclusive', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'timeout' }));
    expect(result.probes[0]?.evidence).toEqual({ E1: false, E2: false, E3: false, E4: null });
    expect(result.probes[1]?.evidence).toEqual({ E1: null, E2: null, E3: null, E4: null });
  });
});

describe('the control run, probe by probe', () => {
  // The control repeats each stopped probe with a hook that allows everything, so it costs two more.
  it('costs five requests for an honest host, and confirms both probes are armed', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toEqual({
      allow: PASSED_ALLOW,
      deny: STOPPED,
      'secret-egress': STOPPED,
      'deny:control': 'passed:armed',
      'secret-egress:control': 'passed:armed',
    });
    expect(result.state).toBe('verified');
    expect(result.caveats).not.toContain('no-control-run');
    expect(driver.calls.map((c) => `${c.probeId}/${c.hookMode}`)).toEqual([
      'allow/real',
      'deny/real',
      'secret-egress/real',
      'deny/noop',
      'secret-egress/noop',
    ]);
  });

  it('runs no control for a probe that did not pass, so that a failing host costs three', async () => {
    const driver = new FakeHostDriver({ fault: 'ignore-deny' });
    const result = await verify(rig, driver, { control: true });
    expect(result.state).toBe('failed');
    expect(driver.calls).toHaveLength(3);
    expect(Object.keys(marksOf(result))).toEqual(['allow', 'deny', 'secret-egress']);
  });

  it('does not call a deny stopped when the host would not have run the command anyway', async () => {
    const driver = new FakeHostDriver({
      fault: (probe) => (probe.kind === 'deny' ? 'host-blocks-all' : 'honest'),
    });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toEqual({
      allow: PASSED_ALLOW,
      deny: 'inconclusive:probe-not-armed',
      'secret-egress': STOPPED,
      'deny:control': 'inconclusive:probe-not-armed',
      'secret-egress:control': 'passed:armed',
    });
    // The other deny was shown to be armed, so the host is verified by it; the unarmed one is not counted.
    expect(result.state).toBe('verified');
  });

  it('leaves the host inconclusive when the only deny that passed could not be confirmed', async () => {
    const driver = new FakeHostDriver({
      fault: (probe) => (probe.kind === 'allow' ? 'honest' : 'host-blocks-all'),
    });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toMatchObject({
      deny: 'inconclusive:probe-not-armed',
      'secret-egress': 'inconclusive:probe-not-armed',
    });
    expect(result.state).toBe('inconclusive');
  });

  it('does not count a pass whose control the model refused to run', async () => {
    const driver = new FakeHostDriver({
      fault: (_probe, ctx) => (ctx.hookMode === 'noop' ? 'refusal' : 'honest'),
    });
    const result = await verify(rig, driver, { control: true });
    expect(marksOf(result)).toMatchObject({
      deny: 'inconclusive:control-inconclusive',
      'secret-egress': 'inconclusive:control-inconclusive',
      'deny:control': 'not-issued:not-issued',
      'secret-egress:control': 'not-issued:not-issued',
    });
    expect(result.state).toBe('inconclusive');
  });

  it('says so, and spends nothing more, when a limit is hit on the first control', async () => {
    const driver = new FakeHostDriver({
      fault: (_probe, ctx) => (ctx.hookMode === 'noop' ? 'limit' : 'honest'),
    });
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { control: true, ledger });
    expect(marksOf(result)).toMatchObject({
      deny: 'inconclusive:control-inconclusive',
      'secret-egress': 'inconclusive:control-inconclusive',
      'deny:control': 'inconclusive:limit',
      'secret-egress:control': 'not-attempted:limit',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(4);
    expect(await ledger.peek()).toMatchObject({ used: 4 });
  });
});

describe('the result as a whole', () => {
  it('names the agent, the host version, the versions and the policy it was made under, and when', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest', version: '2.1.271' }));
    expect(result).toMatchObject({
      version: 1,
      agent: 'claude-code',
      hostVersion: '2.1.271',
      stroqVersion: '0.23.0',
      policySha256: policySha256(DEFAULT_POLICY),
      at: NOW.toISOString(),
      mode: 'stand-in',
    });
  });

  it('lists the probes in the order they are run, allow first, and then the controls', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }));
    expect(result.probes.map((p) => p.id)).toEqual([
      'allow',
      'deny',
      'secret-egress',
      'deny:control',
      'secret-egress:control',
    ]);
    expect(result.probes.map((p) => p.kind)).toEqual([
      'allow',
      'deny',
      'secret-egress',
      'deny',
      'secret-egress',
    ]);
  });

  it('says no control was run when a deny was stopped without one', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { control: false });
    expect(result.caveats).toContain('no-control-run');
  });

  it('does not say so when the control was run, which is what it does unless it is turned off', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }));
    expect(result.caveats).not.toContain('no-control-run');
  });

  it('copies the caveats of the host table, and says when a deny passed without the hook words', async () => {
    const result = await verify(
      rig,
      new FakeHostDriver({
        fault: (probe) => (probe.kind === 'deny' ? 'host-blocks-all' : 'honest'),
      }),
      { capabilities: { headless: true, caveats: ['hook-trust-bypassed'] } },
    );
    expect(result.caveats).toEqual(
      expect.arrayContaining(['hook-trust-bypassed', 'deny-text-not-seen:deny']),
    );
  });

  it('uses the table entry of the agent when it is not given one', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { agent: 'codex' });
    expect(result.agent).toBe('codex');
    expect(result.caveats).toContain('hook-trust-bypassed');
  });
});
