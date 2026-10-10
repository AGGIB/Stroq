import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger, type Ledger } from '../../src/live/budget.js';
import type { HostDriver, HostRun } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { finished } from './helpers.js';
import { makeRig, type Rig } from './rig.js';
import { verifyHost } from '../../src/live/verify.js';
import { marksOf, verify, verifyOptions } from './verify-harness.js';

/**
 * What happens to a run that cannot go on. The requests belong to the owner and are counted before they
 * are made; a host that stops answering, or cannot be paid for, gets no more of them, and nothing is
 * tried again. What was not attempted is said not to have been, which is not the same as having failed.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig(false);
});
afterEach(() => {
  rig.cleanup();
});

const driverOf = (
  run: () => Promise<HostRun> | HostRun,
  over: Partial<HostDriver> = {},
): HostDriver => ({
  detect: () => Promise.resolve({ available: true, version: '1.0.0' }),
  run: () => Promise.resolve().then(run),
  ...over,
});

/** A ledger that writes down what is taken, and when, beside what the driver is asked. */
function recording(limit = 30): { ledger: Ledger; events: string[] } {
  const events: string[] = [];
  const inner = openLedger({ memory: true, limit });
  return {
    events,
    ledger: {
      take: async (n, reason) => {
        events.push(`take ${reason}`);
        return inner.take(n, reason);
      },
      peek: () => inner.peek(),
    },
  };
}

describe('a host that is not there', () => {
  it('makes no request, writes nothing and says so for every probe', async () => {
    const driver = new FakeHostDriver({
      fault: 'honest',
      available: false,
      version: null,
      note: 'claude is not on the path',
    });
    const { ledger, events } = recording();
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'not-attempted:host-not-found',
      deny: 'not-attempted:host-not-found',
      'secret-egress': 'not-attempted:host-not-found',
    });
    expect(result.state).toBe('not-attempted');
    expect(result.hostVersion).toBeNull();
    expect(result.caveats).toContain('claude is not on the path');
    expect(result.probes[0]?.detail).toBe('claude is not on the path');
    expect(driver.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(existsSync(join(rig.project, '.env'))).toBe(false);
    expect(existsSync(join(rig.stroqHome, 'policy.yaml'))).toBe(false);
  });

  it('says the host was not found when the driver gave no reason', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest', available: false }));
    expect(result.probes[0]?.detail).toBe('the host was not found');
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('boom'))],
    [
      'throws',
      () => {
        throw new Error('boom');
      },
    ],
  ])(
    'takes a driver that %s when it looks for the host as a host that is not there',
    async (_how, detect) => {
      const driver = driverOf(() => finished([]), { detect });
      const result = await verify(rig, driver);
      expect(result.state).toBe('not-attempted');
      expect(result.probes[0]).toMatchObject({ mark: 'not-attempted', reason: 'host-not-found' });
      expect(result.caveats).toContain('the driver could not look for the host');
    },
  );
});

describe('the version of the host', () => {
  const versionOf = async (version: string | null): Promise<string | null> =>
    (await verify(rig, new FakeHostDriver({ fault: 'refusal', version }))).hostVersion;

  it('is what the driver found, as a line of plain characters', async () => {
    expect(await versionOf('2.1.271 (Claude Code)')).toBe('2.1.271 (Claude Code)');
    expect(await versionOf('2.1.\u001b[31m271\n')).toBe('2.1.?[31m271');
    expect(await versionOf('v'.repeat(200))).toBe('v'.repeat(80));
  });

  it.each([null, '', '   \n'])('is nothing when the driver found %j', async (version) => {
    expect(await versionOf(version)).toBeNull();
  });
});

describe('the budget', () => {
  it('takes each request from the ledger before it is made, and makes it only once it is taken', async () => {
    const { ledger, events } = recording();
    const driver = driverOf(() => {
      events.push('run');
      return finished([]);
    });
    await verify(rig, driver, { ledger });
    expect(events).toEqual([
      'take claude-code: allow',
      'run',
      'take claude-code: deny',
      'run',
      'take claude-code: secret-egress',
      'run',
    ]);
  });

  it('records which probe each request was for, control or not', async () => {
    const { ledger, events } = recording();
    await verify(rig, new FakeHostDriver({ fault: 'honest' }), { ledger, control: true });
    expect(events).toEqual([
      'take claude-code: allow',
      'take claude-code: deny',
      'take claude-code: deny control',
      'take claude-code: secret-egress',
      'take claude-code: secret-egress control',
    ]);
  });

  it('makes the requests it can pay for and says the rest were not attempted', async () => {
    const ledger = openLedger({ memory: true, limit: 1 });
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { ledger });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'not-attempted:budget',
      'secret-egress': 'not-attempted:budget',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(1);
    expect(await ledger.peek()).toEqual({ ok: true, used: 1, limit: 1 });
  });

  it('does not ask the host when the ledger is already spent, and asks the ledger once', async () => {
    const { ledger, events } = recording(2);
    await ledger.take(2, 'earlier');
    events.length = 0;
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { ledger });
    expect(result.state).toBe('not-attempted');
    expect(Object.values(marksOf(result))).toEqual(Array(3).fill('not-attempted:budget'));
    expect(driver.calls).toEqual([]);
    expect(events).toEqual(['take claude-code: allow']);
    expect(result.probes[0]?.detail).toContain('limit-reached');
  });

  it('makes no request when the ledger file is not a ledger, because it cannot count', async () => {
    const path = join(rig.root, 'ledger', 'ledger.json');
    mkdirSync(join(rig.root, 'ledger'));
    writeFileSync(path, '{"version":1,"limit":30,"used":-5,"entries":[]}');
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { ledger: openLedger({ path, limit: 30 }) });
    expect(result.state).toBe('not-attempted');
    expect(result.probes[0]).toMatchObject({ mark: 'not-attempted', reason: 'budget' });
    expect(result.probes[0]?.detail).toContain('unreadable');
    expect(driver.calls).toEqual([]);
  });

  it('keeps to the number of requests it was given, on top of the ledger', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { maxRequests: 2 });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:control-inconclusive',
      'deny:control': 'not-attempted:max-requests',
      'secret-egress': 'not-attempted:max-requests',
    });
    // Two requests are too few to verify a host: the deny that was stopped has no control to show it armed.
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(2);
  });

  // Each deny is followed by its own control, so the fewest requests that can verify a host are three: the
  // allow, one deny and the control of that deny. The plan's default number of requests is three, and with
  // it an honest host is verified.
  it('verifies a host in the fewest requests that can: the allow, one deny and its control', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const ledger = openLedger({ memory: true, limit: 30 });
    const result = await verify(rig, driver, { maxRequests: 3, ledger });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'passed:blocked',
      'deny:control': 'passed:armed',
      'secret-egress': 'not-attempted:max-requests',
    });
    expect(result.state).toBe('verified');
    expect(driver.calls.map((c) => `${c.probeId}/${c.hookMode}`)).toEqual([
      'allow/real',
      'deny/real',
      'deny/noop',
    ]);
    expect(await ledger.peek()).toMatchObject({ used: 3 });
  });

  it('still verifies a host with one more request, and the second deny is left without its control', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { maxRequests: 4 });
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'passed:blocked',
      'deny:control': 'passed:armed',
      'secret-egress': 'inconclusive:control-inconclusive',
      'secret-egress:control': 'not-attempted:max-requests',
    });
    expect(result.state).toBe('verified');
    expect(driver.calls).toHaveLength(4);
  });

  it('cannot verify a host in fewer than three requests, whatever it does', async () => {
    for (const maxRequests of [0, 1, 2]) {
      const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), { maxRequests });
      expect(result.state, `${maxRequests} requests`).not.toBe('verified');
    }
  });

  it('makes no request at all when it was given none to make', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const result = await verify(rig, driver, { maxRequests: 0 });
    expect(result.state).toBe('not-attempted');
    expect(driver.calls).toEqual([]);
  });

  it('does not count a pass whose control it was not allowed to make', async () => {
    const result = await verify(rig, new FakeHostDriver({ fault: 'honest' }), {
      control: true,
      maxRequests: 2,
    });
    expect(marksOf(result)).toMatchObject({
      deny: 'inconclusive:control-inconclusive',
      'deny:control': 'not-attempted:max-requests',
    });
    expect(result.state).toBe('inconclusive');
  });
});

describe('a host that stops answering', () => {
  it('stops at the first limit: nothing is retried and the ledger is asked once', async () => {
    const { ledger, events } = recording();
    const driver = new FakeHostDriver({ fault: 'limit' });
    const result = await verify(rig, driver, { ledger });
    expect(driver.calls).toHaveLength(1);
    expect(events).toEqual(['take claude-code: allow']);
    expect(result.probes.map((p) => p.mark)).toEqual([
      'inconclusive',
      'not-attempted',
      'not-attempted',
    ]);
  });

  it('stops at a limit in the middle of the run, and keeps what was found before it', async () => {
    const driver = new FakeHostDriver({
      fault: (probe) => (probe.kind === 'deny' ? 'limit' : 'honest'),
    });
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:limit',
      'secret-egress': 'not-attempted:limit',
    });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(2);
  });

  it('stops when nobody is logged in', async () => {
    const driver = driverOf(() => ({
      stream: [
        { type: 'init' },
        { type: 'result', isError: true, text: 'Invalid API key · Please run /login' },
      ],
      exitCode: 1,
      timedOut: false,
      stderrTail: '',
    }));
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:auth',
      deny: 'not-attempted:auth',
      'secret-egress': 'not-attempted:auth',
    });
  });

  it('stops when the driver throws', async () => {
    let calls = 0;
    const driver = driverOf(() => {
      calls += 1;
      throw new Error('spawn claude ENOENT');
    });
    const result = await verify(rig, driver);
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:host-error',
      deny: 'not-attempted:host-error',
      'secret-egress': 'not-attempted:host-error',
    });
    expect(calls).toBe(1);
  });

  // A driver is meant to keep to the deadline it is given. One that does not must not hang the check:
  // it is waited for until the deadline and a short grace, and then it is a run that timed out.
  it('stops at a driver that never answers, once its deadline and a grace have gone by', async () => {
    const hung = driverOf(() => new Promise<HostRun>(() => undefined));
    const result = await verifyHost(
      hung,
      rig.ctx({ deadlineMs: 10 }),
      verifyOptions({ graceMs: 10 }),
    );
    expect(marksOf(result)).toEqual({
      allow: 'inconclusive:timeout',
      deny: 'not-attempted:timeout',
      'secret-egress': 'not-attempted:timeout',
    });
  });

  it('waits a grace of its own after the deadline when none is given, and a prompt driver never needs it', async () => {
    const driver = new FakeHostDriver({ fault: 'refusal' });
    const result = await verify(rig, driver, { graceMs: undefined });
    expect(result.state).toBe('inconclusive');
    expect(driver.calls).toHaveLength(3);
  });

  // How a request is paid for is said by every answer or the run goes no further: a stream that cannot be
  // read says nothing of it, and a host that said so once may stop saying so (a resumed session, a parse
  // that broke) with the account no longer the one it was.
  it('stops at a stream it cannot read after the host has said how it is paid for: it says nothing of the account now', async () => {
    const driver = new FakeHostDriver({
      fault: (probe) => (probe.kind === 'allow' ? 'honest' : 'garbage'),
    });
    const result = await verify(rig, driver);
    expect(driver.calls).toHaveLength(2);
    expect(marksOf(result)).toEqual({
      allow: 'passed:ran',
      deny: 'inconclusive:unparsable-stream',
      'secret-egress': 'not-attempted:billing-unknown',
    });
  });

  it('stops at a stream it cannot read when the host has said nothing of how it is paid for', async () => {
    const driver = new FakeHostDriver({ fault: 'garbage' });
    await verify(rig, driver);
    expect(driver.calls).toHaveLength(1);
  });
});
