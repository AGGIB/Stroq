import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLedger, type Ledger } from '../../src/live/budget.js';
import { auditPosition, makeRequest, readAuditAfter } from '../../src/live/request.js';
import type { HostDriver, HostRun, Probe, ProbeContext } from '../../src/live/types.js';
import { FakeHostDriver } from './fake-driver.js';
import { NONCE, auditEntry, finished } from './helpers.js';
import { probe } from './probe-helpers.js';
import { makeRig, type Rig } from './rig.js';

/**
 * One request to a host is four steps that must stay in this order: clear the files the probe could leave
 * and look at the audit log, take the request from the ledger, ask the host, and only then read the disk.
 * Whatever can refuse a request is done before it is paid for: a request that cannot be judged (a file that
 * cannot be cleared, a log that cannot be read) is a request that must not be made. And a request that is
 * made before it is paid for, or a file that is read before the host has finished, is a check that measures
 * something other than the host.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => {
  rig.cleanup();
});

const args = (
  driver: HostDriver,
  over: { ledger?: Ledger; probe?: Probe; ctx?: ProbeContext } = {},
) => ({
  driver,
  ledger: over.ledger ?? openLedger({ memory: true, limit: 30 }),
  label: 'claude-code: allow',
  probe: over.probe ?? probe('allow'),
  ctx: over.ctx ?? rig.ctx(),
  graceMs: 50,
});

describe('makeRequest', () => {
  it('pays for the request before it is made, and makes it only once it is paid for', async () => {
    const order: string[] = [];
    const ledger: Ledger = {
      take: (n, reason) => {
        order.push(`take ${n} ${reason}`);
        return Promise.resolve({ ok: true, used: 1, limit: 30 });
      },
      peek: () => Promise.resolve({ ok: true, used: 1, limit: 30 }),
    };
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => {
        order.push('run');
        return Promise.resolve(finished([]));
      },
    };
    await makeRequest(args(driver, { ledger }));
    expect(order).toEqual(['take 1 claude-code: allow', 'run']);
  });

  it('does not make the request when the ledger refuses it, and says the budget is why', async () => {
    const ledger = openLedger({ memory: true, limit: 1 });
    await ledger.take(1, 'earlier');
    const driver = new FakeHostDriver({ fault: 'honest' });
    const requested = await makeRequest(args(driver, { ledger }));
    expect(driver.calls).toEqual([]);
    expect(requested).toEqual({
      sent: false,
      reason: 'budget',
      detail: expect.stringContaining('limit-reached'),
    });
  });

  it('clears the file and looks at the log before it takes the request, so that nothing is paid for that cannot be judged', async () => {
    writeFileSync(join(rig.project, 'stroq-live-allow.txt'), `${NONCE}\n`);
    let leftWhenPaid: boolean | undefined;
    const ledger: Ledger = {
      take: () => {
        leftWhenPaid = existsSync(join(rig.project, 'stroq-live-allow.txt'));
        return Promise.resolve({ ok: true, used: 1, limit: 30 });
      },
      peek: () => Promise.resolve({ ok: true, used: 1, limit: 30 }),
    };
    await makeRequest(args(new FakeHostDriver({ fault: 'refusal' }), { ledger }));
    expect(leftWhenPaid).toBe(false);
  });

  it('takes away what an earlier request left before it asks the host', async () => {
    writeFileSync(join(rig.project, 'stroq-live-allow.txt'), `${NONCE}\n`);
    const requested = await makeRequest(args(new FakeHostDriver({ fault: 'refusal' })));
    expect(requested).toMatchObject({
      sent: true,
      observation: { sentinel: { exists: false, content: null } },
    });
  });

  it('reads the disk and the audit log after the host has finished', async () => {
    const requested = await makeRequest(args(new FakeHostDriver({ fault: 'honest' })));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.sentinel).toEqual({ exists: true, content: `${NONCE}\n` });
    expect(requested.observation.audit).toMatchObject({ kind: 'read' });
    expect(requested.observation.run.stream.some((e) => e.type === 'tool_use')).toBe(true);
  });

  it('hands the driver the probe and the context it was given, as they are', async () => {
    const seen: unknown[] = [];
    const p = probe('allow');
    const ctx = rig.ctx();
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: (given, context) => {
        seen.push(given, context);
        return Promise.resolve(finished([]));
      },
    };
    await makeRequest(args(driver, { probe: p, ctx }));
    expect(seen[0]).toBe(p);
    expect(seen[1]).toBe(ctx);
  });

  it('turns a driver that throws into a run that did not get to the end', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => Promise.reject(new Error('spawn claude ENOENT\u001b[2J')),
    };
    const requested = await makeRequest(args(driver));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.run).toMatchObject({
      stream: [],
      exitCode: null,
      timedOut: false,
    });
    expect(requested.observation.run.stderrTail).toMatch(/^[\x20-\x7e]*$/);
    expect(requested.observation.run.stderrTail).toContain('ENOENT');
  });

  it('turns a driver that rejects with something that is not an error the same way', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => Promise.reject('plain text, not an Error'),
    };
    const requested = await makeRequest(args(driver));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.run.stderrTail).toBe('plain text, not an Error');
  });

  // A driver is code that talks to a program we do not control, and an error it rejects with can be anything,
  // an object that has no way to be written as text included. That is a run that did not get to the end.
  it('turns a driver that rejects with an object that cannot be written as text the same way', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => Promise.reject(Object.create(null) as never),
    };
    const requested = await makeRequest(args(driver));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.run).toMatchObject({ exitCode: null, timedOut: false });
    expect(requested.observation.run.stderrTail).toMatch(/^[\x20-\x7e]+$/);
  });

  it('turns a driver that throws before it returns a promise the same way', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => {
        throw new Error('sync failure');
      },
    };
    const requested = await makeRequest(args(driver));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.run.exitCode).toBeNull();
    expect(requested.observation.run.stderrTail).toContain('sync failure');
  });

  it('does not wait for ever for a driver that never answers', async () => {
    const driver: HostDriver = {
      detect: () => Promise.resolve({ available: true, version: null }),
      run: () => new Promise<HostRun>(() => undefined),
    };
    const requested = await makeRequest(args(driver, { ctx: rig.ctx({ deadlineMs: 10 }) }));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.run).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('leaves no timer running behind a driver that answered', async () => {
    vi.useFakeTimers();
    try {
      await makeRequest(args(new FakeHostDriver({ fault: 'refusal' })));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the audit log of a request', () => {
  const unreadable = { kind: 'unreadable', problem: 'the audit log cannot be read' } as const;

  it('starts at nothing in a home with no audit log, and has nothing added to it', async () => {
    const position = await auditPosition(rig.stroqHome);
    expect(position).toEqual({ kind: 'at', seq: 0 });
    expect(await readAuditAfter(rig.stroqHome, position)).toEqual({ kind: 'read', entries: [] });
  });

  it('reads the entries added after the position it was given, and only those', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    await driver.run(probe('allow'), rig.ctx({ sessionId: 'session-one' }));
    const position = await auditPosition(rig.stroqHome);
    expect(position).toMatchObject({ kind: 'at', seq: expect.any(Number) });
    await driver.run(probe('deny'), rig.ctx({ sessionId: 'session-two' }));
    const read = await readAuditAfter(rig.stroqHome, position);
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.entries.map((e) => e.sessionId)).toEqual(['session-two']);
  });

  // The session is the host's to choose: it may not be the one the check gave it, and the nonce is what
  // ties an entry to a request.
  it('does not pick entries by session', async () => {
    const position = await auditPosition(rig.stroqHome);
    await new FakeHostDriver({ fault: 'honest' }).run(
      probe('allow'),
      rig.ctx({ sessionId: 'a-session-the-host-made-up' }),
    );
    const read = await readAuditAfter(rig.stroqHome, position);
    expect(read).toMatchObject({ kind: 'read' });
    expect(read.kind === 'read' ? read.entries.length : 0).toBeGreaterThan(0);
  });

  it('says the log cannot be read, and does not throw, when a line of it is damaged', async () => {
    mkdirSync(rig.stroqHome, { recursive: true });
    writeFileSync(
      join(rig.stroqHome, 'audit.jsonl'),
      `${JSON.stringify(auditEntry())}\n{"truncated":\n`,
    );
    expect(await auditPosition(rig.stroqHome)).toEqual(unreadable);
    expect(await readAuditAfter(rig.stroqHome, { kind: 'at', seq: 0 })).toEqual(unreadable);
  });

  it('says the log cannot be read when what is in it is not an entry', async () => {
    mkdirSync(rig.stroqHome, { recursive: true });
    for (const line of ['null', '[]', '{"seq":"1"}', '{"phase":"pre"}', '7']) {
      writeFileSync(join(rig.stroqHome, 'audit.jsonl'), `${line}\n`);
      expect(await auditPosition(rig.stroqHome)).toEqual(unreadable);
    }
  });

  it('cannot say what was added after a position it could not have', async () => {
    mkdirSync(rig.stroqHome, { recursive: true });
    const read = await readAuditAfter(rig.stroqHome, unreadable);
    expect(read).toEqual(unreadable);
  });

  it('is what a request observes: the entries of that request and not the ones before it', async () => {
    const driver = new FakeHostDriver({ fault: 'honest' });
    const first = await makeRequest(args(driver, { probe: probe('allow') }));
    const second = await makeRequest(
      args(driver, { probe: probe('deny'), ctx: rig.ctx({ sessionId: 'two' }) }),
    );
    if (!first.sent || !second.sent) throw new Error('expected both requests to be sent');
    expect(first.observation.audit).toMatchObject({ kind: 'read' });
    const seen = (r: typeof first): readonly string[] =>
      r.observation.audit.kind === 'read'
        ? r.observation.audit.entries.map((e) => e.sessionId)
        : [];
    expect(seen(first)).toHaveLength(1);
    expect(seen(second)).toEqual(['two']);
  });

  // A request made over a log that cannot be read can only end as one whose hook cannot be told: it is paid for
  // from the owner's requests and judged by nothing. So it is not made, and nothing is taken from the ledger.
  it('is not made when the log was damaged before the request began, and nothing is paid for', async () => {
    mkdirSync(rig.stroqHome, { recursive: true });
    writeFileSync(join(rig.stroqHome, 'audit.jsonl'), '{"truncated":\n');
    const ledger = openLedger({ memory: true, limit: 30 });
    const driver = new FakeHostDriver({ fault: 'refusal' });
    const requested = await makeRequest(args(driver, { ledger }));
    expect(requested).toEqual({
      sent: false,
      reason: 'audit-unreadable',
      detail: 'the audit log cannot be read',
    });
    expect(driver.calls).toEqual([]);
    expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 30 });
  });
});

// A model has the run of the project while a request is made, and what it leaves there can make the next
// request unsafe to clear for. That is a thing to say, with the requests before it kept, and not a throw.
describe('a probe file that cannot be cleared', () => {
  const notPaidFor = async (
    ledger: Ledger,
    driver: FakeHostDriver,
    requested: Awaited<ReturnType<typeof makeRequest>>,
  ): Promise<void> => {
    expect(requested.sent).toBe(false);
    expect(driver.calls).toEqual([]);
    expect(await ledger.peek()).toMatchObject({ used: 0 });
  };

  it.skipIf(process.platform === 'win32')(
    'is a request that is not made, for a way to it that leads out of the project through a link',
    async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'stroq-live-request-'));
      try {
        mkdirSync(join(elsewhere, 'hooks'));
        writeFileSync(join(elsewhere, 'hooks', 'pre-commit'), "the owner's own hook");
        symlinkSync(elsewhere, join(rig.project, '.git'));
        const ledger = openLedger({ memory: true, limit: 30 });
        const driver = new FakeHostDriver({ fault: 'honest' });
        const requested = await makeRequest(args(driver, { ledger, probe: probe('deny') }));
        expect(requested).toMatchObject({ sent: false, reason: 'unsafe-directory' });
        if (requested.sent) return;
        expect(requested.detail).toMatch(/link/);
        await notPaidFor(ledger, driver, requested);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is a request that is not made, for a way to it that cannot be gone through',
    async () => {
      mkdirSync(join(rig.project, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(rig.project, '.git', 'hooks', 'pre-commit'), 'left by the model');
      chmodSync(join(rig.project, '.git'), 0o000);
      try {
        const ledger = openLedger({ memory: true, limit: 30 });
        const driver = new FakeHostDriver({ fault: 'honest' });
        const requested = await makeRequest(args(driver, { ledger, probe: probe('deny') }));
        expect(requested).toMatchObject({ sent: false, reason: 'cannot-clear' });
        if (requested.sent) return;
        expect(requested.detail).toMatch(/^[\x20-\x7e]+$/);
        await notPaidFor(ledger, driver, requested);
      } finally {
        chmodSync(join(rig.project, '.git'), 0o700);
      }
    },
  );
});
