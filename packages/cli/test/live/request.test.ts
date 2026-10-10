import { mkdirSync, writeFileSync } from 'node:fs';
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
 * One request to a host is four steps that must stay in this order: take the request from the ledger,
 * clear the files the probe could leave, ask the host, and only then read the disk. A request that
 * is made before it is paid for, or a file that is read before the host has finished, is a check that
 * measures something other than the host.
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

  it('is unreadable for a request when the log was damaged before the request began', async () => {
    mkdirSync(rig.stroqHome, { recursive: true });
    writeFileSync(join(rig.stroqHome, 'audit.jsonl'), '{"truncated":\n');
    const requested = await makeRequest(args(new FakeHostDriver({ fault: 'refusal' })));
    if (!requested.sent) throw new Error('expected the request to be sent');
    expect(requested.observation.audit).toEqual(unreadable);
  });
});
