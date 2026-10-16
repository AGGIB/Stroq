import { describe, expect, it } from 'vitest';
import { DEFAULT_STRICT_MAX_WITHHELD } from '../../src/mcp/strict-limits.js';
import { POISON_OPENING, errorText, everythingSaid, startRig, eventually } from './strict-rig.js';

/**
 * What a server says on its own initiative: notifications and requests nobody asked
 * for. The default proxy forwards all of it; strict mode forwards five fixed methods
 * that carry no free text and withholds the rest, counts what it withholds, and ends a
 * server that withholds too much.
 */

describe('notifications and requests a server starts', () => {
  it('reach the client by default, sampling requests and text-bearing notifications included', async () => {
    const rig = startRig();
    await rig.handshake();
    rig.call(3, 'notif');
    await rig.answerFor(3);
    const methods = rig.messages().map((m) => m['method']);
    expect(methods).toEqual(
      expect.arrayContaining([
        'notifications/message',
        'sampling/createMessage',
        'notifications/tools/list_changed',
      ]),
    );
    await rig.finish();
  });

  it('are withheld, audited and counted under --strict; only the answer is delivered', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'notif');
    const answer = await rig.answerFor(3);
    expect(JSON.stringify(answer)).toContain('"ok"');
    expect(rig.messages().filter((m) => typeof m['method'] === 'string')).toEqual([]);
    expect(everythingSaid(rig)).not.toContain(POISON_OPENING);
    expect(rig.ruleIds().filter((id) => id === 'mcp-strict-unsolicited')).toHaveLength(3);
    // The audit says what kind of message it was and nothing the server wrote in it.
    const summaries = JSON.stringify(rig.audit());
    expect(summaries).toContain('sampling/createMessage');
    expect(summaries).not.toContain(POISON_OPENING);
    await rig.finish();
  });

  it('answers a withheld server request so the server is not left waiting for the client', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'notif');
    await rig.answerFor(3);
    // The refusal is written to the server after the answer; wait for the server to have it.
    const refusal = () =>
      rig
        .serverLog()
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((m) => m['id'] === 'srv-1');
    await eventually(() => expect(refusal()).toBeDefined());
    expect((refusal()?.['error'] as { code?: number }).code).toBe(-32601);
    expect(JSON.stringify(refusal())).not.toContain(POISON_OPENING);
    await rig.finish();
  });

  it('forwards the progress, list-changed and ping messages that carry no free text', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    for (const [id, tool] of [
      [3, 'progress'],
      [4, 'listchanged'],
      [5, 'serverping'],
    ] as const) {
      rig.call(id, tool);
      await rig.answerFor(id);
    }
    const methods = rig
      .messages()
      .flatMap((m) => (typeof m['method'] === 'string' ? [m['method']] : []));
    expect(methods).toEqual(['notifications/progress', 'notifications/tools/list_changed', 'ping']);
    expect(rig.ruleIds()).toEqual([]);
    await rig.finish();
  });

  it('withholds a progress notification that carries a message', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'progressmsg');
    await rig.answerFor(3);
    expect(rig.messages().some((m) => m['method'] === 'notifications/progress')).toBe(false);
    expect(rig.ruleIds()).toContain('mcp-strict-unsolicited');
    await rig.finish();
  });
});

describe('a server that withholds too much', () => {
  it('is ended after the limit: the waiting request gets a clear error, the exit is non-zero, the audit is bounded', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'floodsampling', { count: 100 });
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain(`more than ${DEFAULT_STRICT_MAX_WITHHELD} withheld`);
    expect(await rig.done).toBe(1);
    expect(rig.stderr()).toContain('strict mode ended the server');
    const ids = rig.ruleIds();
    // The limit's worth, and the one message past it that ended the server: all audited.
    expect(ids.filter((id) => id === 'mcp-strict-unsolicited')).toHaveLength(
      DEFAULT_STRICT_MAX_WITHHELD + 1,
    );
    expect(ids.filter((id) => id === 'mcp-strict-terminated')).toHaveLength(1);
  }, 60_000);

  it('uses the limit it was given', async () => {
    const rig = startRig({ strict: true, strictMaxWithheld: 1 });
    await rig.handshake();
    rig.call(3, 'notif');
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain('more than 1 withheld');
    expect(await rig.done).toBe(1);
  }, 60_000);

  it('does not end a server for log lines, many more than the hostile limit of them', async () => {
    const rig = startRig({ strict: true });
    await rig.handshake();
    rig.call(3, 'flood', { count: 120 });
    const answer = await rig.answerFor(3, 90_000);
    expect(JSON.stringify(answer)).toContain('"ok"');
    expect(await rig.finish()).toBe(0);
    expect(rig.ruleIds().filter((id) => id === 'mcp-strict-unsolicited')).toHaveLength(120);
    expect(rig.ruleIds()).not.toContain('mcp-strict-terminated');
  }, 120_000);

  it('ends it past the separate cap for them, with that cap in the error', async () => {
    const rig = startRig({ strict: true, strictMaxBenign: 30 });
    await rig.handshake();
    rig.call(3, 'flood', { count: 100 });
    const answer = await rig.answerFor(3);
    expect(errorText(answer)).toContain('more than 30 withheld');
    expect(await rig.done).toBe(1);
    expect(rig.ruleIds().filter((id) => id === 'mcp-strict-unsolicited')).toHaveLength(31);
  }, 60_000);

  it('does not count what it forwards or what the client asked for', async () => {
    const rig = startRig({ strict: true, strictMaxWithheld: 1 });
    await rig.handshake();
    for (let id = 3; id < 8; id += 1) {
      rig.call(id, 'progress');
      await rig.answerFor(id);
    }
    expect(await rig.finish()).toBe(0);
  });
});

describe('a server that has been ended', () => {
  it('is delivered nothing more: not the answer it sent after the line that ended it', async () => {
    const rig = startRig({ strict: true, strictMaxWithheld: 1 });
    await rig.handshake();
    rig.call(3, 'notif');
    // The terminated error is what the client is given for 3; the server's own answer
    // ('ok') follows its three messages on the same pipe and arrives after it.
    expect(errorText(await rig.answerFor(3))).toContain('more than 1 withheld');
    const delivered = [...rig.lines()];
    await rig.done;
    expect(rig.lines()).toEqual(delivered);
    expect(rig.lines().some((l) => l.includes('"ok"'))).toBe(false);
  }, 60_000);
});

describe('a server strict mode has ended but that is still running', () => {
  it('is not sent what the client asks next: the request is answered, and never forwarded', async () => {
    const rig = startRig({
      strict: true,
      strictMaxWithheld: 1,
      shutdownGraceMs: 4000,
      env: { STRICT_SERVER_IGNORE_TERM: '1' },
    });
    await rig.handshake();
    rig.call(3, 'notif');
    expect(errorText(await rig.answerFor(3))).toContain('more than 1 withheld');
    // The server ignores the first signal and is still alive for the grace period.
    rig.call(9, 'benign');
    const late = await rig.answerFor(9);
    expect(errorText(late)).toContain('ended this server');
    expect(rig.serverLog().some((line) => line.includes('"id":9'))).toBe(false);
    expect(await rig.done).toBe(1);
  }, 60_000);
});

describe('a request the client cancelled', () => {
  it('has its late answer dropped without counting against the server', async () => {
    const rig = startRig({ strict: true, strictMaxWithheld: 1 });
    await rig.handshake();
    rig.call(4, 'slow');
    await eventually(() => expect(rig.serverLog().some((l) => l.includes('"slow"'))).toBe(true));
    rig.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
    await eventually(() =>
      expect(rig.serverLog().some((l) => l.includes('notifications/cancelled'))).toBe(true),
    );
    rig.call(5, 'benign');
    await rig.answerFor(5);
    // The server answers 4 (late) just before it answers 5: both are in by now.
    expect(rig.messages().some((m) => m['id'] === 4)).toBe(false);
    expect(rig.ruleIds()).toEqual([]);
    expect(await rig.finish()).toBe(0);
  });

  it('is answered late by the default proxy, as it always was', async () => {
    const rig = startRig();
    await rig.handshake();
    rig.call(4, 'slow');
    await eventually(() => expect(rig.serverLog().some((l) => l.includes('"slow"'))).toBe(true));
    rig.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
    rig.call(5, 'benign');
    await rig.answerFor(5);
    expect(rig.messages().some((m) => m['id'] === 4)).toBe(true);
    await rig.finish();
  });
});
