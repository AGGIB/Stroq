import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, loadPolicyFile, type Policy } from '@stroq/core';
import { openLedger } from '../../src/live/budget.js';
import { policySha256, writePolicy } from '../../src/live/policy-digest.js';
import type { HostDriver } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { FAKE } from './helpers.js';
import { makeRig, type Rig } from './rig.js';
import { marksOf, verify } from './verify-harness.js';

/**
 * A probe is a probe only while the policy in force denies it (or, for the allow, allows it), and the hook
 * a host runs has to judge under that same policy, or the check would be comparing the hook with a
 * policy that is not its own. So the policy is asked first, in process, and then written where the hook
 * will read it.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const edited = (change: (rule: Policy['rules'][number]) => Policy['rules'][number]): Policy => ({
  ...DEFAULT_POLICY,
  rules: DEFAULT_POLICY.rules.map(change),
});
const without = (id: string): Policy => ({
  ...DEFAULT_POLICY,
  rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== id),
});

describe('a probe the policy does not deny', () => {
  it('is skipped and not failed, and costs no request', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ limit: 30 });
    const result = await verify(rig, driver, { policy: without('deny-git-exec'), ledger });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'skipped:skipped-policy-allows',
      'secret-egress': 'passed:blocked',
    });
    expect(result.probes[1]?.detail).toBe(
      'the active policy gives allow (no rule) for this command, not a deny',
    );
    expect(result.probes[1]?.evidence).toEqual({ E1: null, E2: null, E3: null, E4: null });
    // The other deny was stopped, so the host is verified by it.
    expect(result.state).toBe('verified');
    expect(driver.calls.map((c) => c.probeId)).toEqual(['allow', 'secret-egress']);
    expect(await ledger.peek()).toMatchObject({ used: 2 });
  });

  it('leaves the host inconclusive when no deny is left to show it by', async () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.filter(
        (rule) => rule.id !== 'deny-git-exec' && rule.id !== 'deny-secret-egress',
      ),
    };
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { policy });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'skipped:skipped-policy-allows',
      'secret-egress': 'skipped:skipped-policy-allows',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(1);
  });

  it('is skipped too when the policy asks and does not deny', async () => {
    const policy = edited((rule) =>
      rule.id === 'deny-git-exec' ? { ...rule, effect: 'ask' as const } : rule,
    );
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { policy });
    expect(result.probes[1]).toMatchObject({ mark: 'skipped', reason: 'skipped-policy-allows' });
    expect(result.probes[1]?.detail).toContain('ask (deny-git-exec)');
  });

  it('is not a reason to doubt the allow probe, which is run if the policy allows it', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), {
      policy: without('deny-git-exec'),
    });
    expect(result.probes[0]).toMatchObject({ mark: 'passed', reason: 'ran' });
  });
});

describe('an allow probe that the policy does not allow', () => {
  const denyAll: Policy = { version: 1, threshold: 0.6, default: 'deny', rules: [] };

  it('is skipped, and the check cannot be verified without it', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { policy: denyAll });
    expect(result.probes[0]).toMatchObject({
      mark: 'skipped',
      reason: 'skipped-policy-blocks-allow',
    });
    // The denies are denied by the default, which has no rule; the hook says the same.
    expect(marksOf(result)).toMatchObject({
      deny: 'passed:blocked',
      'secret-egress': 'passed:blocked',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls.map((c) => c.probeId)).toEqual(['deny', 'secret-egress']);
  });
});

describe('the rule that decided', () => {
  it('is the one the active policy calls it, which is what the audit entry is held to', async () => {
    const policy = edited((rule) =>
      rule.id === 'deny-secret-egress' ? { ...rule, id: 'my-egress-rule' } : rule,
    );
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { policy });
    expect(marksOf(result)['secret-egress']).toBe('passed:blocked');
    expect(result.probes[2]?.evidence.E4).toBe(true);
  });

  it('is held against the policy in force and not the default: a hook under another policy is told apart', async () => {
    const policy = edited((rule) =>
      rule.id === 'deny-secret-egress' ? { ...rule, id: 'my-egress-rule' } : rule,
    );
    const driver = new FakeHostDriver({ fault: 'honest', hookPolicy: DEFAULT_POLICY });
    const result = await verify(rig, driver, { policy });
    expect(marksOf(result)['secret-egress']).toBe('failed:policy-mismatch');
    expect(result.probes[2]?.detail).toBe(
      'the audit says deny (deny-secret-egress); expected deny (my-egress-rule)',
    );
    expect(result.state).toBe('failed');
  });
});

describe('the policy the hook is given', () => {
  it('is written to the home of the check, for the hook to read', async () => {
    const policy = without('deny-git-exec');
    await verify(rig, new FakeHostDriver({ fault: 'refusal' }), { policy });
    expect(loadPolicyFile(join(rig.stroqHome, 'policy.yaml'))).toEqual(policy);
  });

  it('is written when it is the default too, so that the hook never falls back on a file that was there', async () => {
    writePolicy(rig.stroqHome, without('deny-git-exec'));
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }));
    expect(loadPolicyFile(join(rig.stroqHome, 'policy.yaml'))).toEqual(DEFAULT_POLICY);
    expect(result.state).toBe('verified');
  });

  it('is named in the result by its digest', async () => {
    const policy = without('deny-git-exec');
    const result = await verify(rig, new FakeHostDriver({ fault: 'refusal' }), { policy });
    expect(result.policySha256).toBe(policySha256(policy));
    expect(result.policySha256).not.toBe(policySha256(DEFAULT_POLICY));
  });
});

describe('the evidence belongs to the hook', () => {
  it('has no audit entry from the check itself: asking the policy in process leaves nothing in the home', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'never-call-hook' }));
    expect(await rig.audit()).toEqual([]);
    expect(marksOf(result)).toEqual({
      allow: 'failed:hook-bypassed',
      deny: 'failed:hook-bypassed',
      'secret-egress': 'failed:hook-bypassed',
    });
  });

  it('says it cannot tell, and does not say the hook left nothing, when the audit log cannot be read', async () => {
    const inner = new FakeHostDriver({ fault: 'honest' });
    const driver: HostDriver = {
      detect: () => inner.detect(),
      run: async (probe, ctx) => {
        const run = await inner.run(probe, ctx);
        appendFileSync(join(ctx.stroqHome, 'audit.jsonl'), '{"truncated":\n');
        return run;
      },
    };
    // One request: the next hook could not append to a log that is damaged either, which is its own failure.
    const result = await verify(rig, driver, { maxRequests: 1 });
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:audit-unreadable',
      deny: 'not-attempted:max-requests',
      'secret-egress': 'not-attempted:max-requests',
    });
    expect(result.probes[0]?.evidence).toMatchObject({ E1: true, E2: null, E3: true });
    expect(result.state).toBe('inconclusive');
  });

  it('puts a run that went wrong before an audit log that cannot be read', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: (_probe, ctx) => {
        mkdirSync(ctx.stroqHome, { recursive: true });
        writeFileSync(join(ctx.stroqHome, 'audit.jsonl'), 'not json\n');
        return Promise.resolve({ stream: [], exitCode: null, timedOut: true, stderrTail: '' });
      },
    };
    expect((await verify(rig, driver)).probes[0]).toMatchObject({ reason: 'timeout' });
  });
});

describe('what a run does to the directories it is given', () => {
  it('writes the made-up key into the .env of the project, where the index looks for it', async () => {
    await verify(rig, new FakeHostDriver({ fault: 'refusal' }));
    expect(readFileSync(join(rig.project, '.env'), 'utf8')).toBe(`STROQ_LIVE_API_KEY=${FAKE}\n`);
  });

  it('does not take for the work of a request a file that an earlier run left', async () => {
    mkdirSync(join(rig.project, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(rig.project, '.git', 'hooks', 'pre-commit'), 'old');
    writeFileSync(join(rig.project, 'stroq-live-allow.txt'), 'old');
    writeFileSync(join(rig.project, 'stroq-live-egress.txt'), 'old');
    const result = await verify(rig, new FakeHostDriver({ fault: 'refusal' }));
    expect(marksOf(result)).toEqual({
      allow: 'not-issued:not-issued',
      deny: 'not-issued:not-issued',
      'secret-egress': 'not-issued:not-issued',
    });
    expect(existsSync(join(rig.project, 'stroq-live-egress.txt'))).toBe(false);
  });

  it('gives each request a nonce and a session of its own', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    await verify(rig, driver, { control: true });
    const nonces = driver.calls.map((c) => c.nonce);
    const sessions = driver.calls.map((c) => c.sessionId);
    expect(new Set(nonces).size).toBe(5);
    expect(new Set(sessions).size).toBe(5);
    const audited = await rig.audit();
    // The audit has an entry for each request the hook was in, with that request's nonce in it.
    for (const call of driver.calls.filter((c) => c.hookMode === 'real')) {
      expect(
        audited.some((e) => e.sessionId === call.sessionId && e.summary.includes(call.nonce)),
      ).toBe(true);
    }
  });

  it('uses the ids of a real run when none are given: a uuid for a session and a nonce nobody can guess', async () => {
    const driver = new FakeHostDriver({ fault: 'refusal' });
    await verify(rig, driver, { ids: {} });
    for (const call of driver.calls) {
      expect(call.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(call.nonce).toMatch(/^stroq-live-[0-9a-f]{16}$/);
    }
    expect(new Set(driver.calls.map((c) => c.nonce)).size).toBe(3);
  });
});

describe('what the result says produced it', () => {
  const plain = (): HostDriver => {
    const inner = new FakeHostDriver({ fault: 'refusal' });
    return { detect: () => inner.detect(), run: (probe, ctx) => inner.run(probe, ctx) };
  };

  it('is a stand-in when the driver says it is, whatever the caller says', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'refusal' }), { mode: 'live' });
    expect(result.mode).toBe('stand-in');
  });

  it('is a stand-in when the caller says so, whatever the driver says', async () => {
    expect((await verify(rig, plain(), { mode: 'stand-in' })).mode).toBe('stand-in');
  });

  it('is live only when neither says otherwise', async () => {
    expect((await verify(rig, plain())).mode).toBe('live');
    expect((await verify(rig, plain(), { mode: 'live' })).mode).toBe('live');
  });
});

describe('the time of the result', () => {
  it('is the time of the run when no clock is given', async () => {
    const before = Date.now();
    const result = await verify(rig, new FakeHostDriver({ fault: 'refusal' }), { now: undefined });
    const at = Date.parse(result.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe('an agent that is not an agent', () => {
  it.each(['', '../claude-code', 'Claude', 'a b', 'x'.repeat(40)])(
    'is refused before anything is asked or written: %j',
    async (agent) => {
      const driver = new FakeHostDriver({ fault: 'honest' });
      await expect(verify(rig, driver, { agent })).rejects.toThrow(/not an agent name/);
      expect(driver.detections).toBe(0);
      expect(driver.calls).toEqual([]);
    },
  );
});
