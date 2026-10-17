import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PLAN, type McpCloak } from '../../src/mcp/cloak.js';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';

/**
 * The strict pump's gate on the server: once the server has been ended, nothing is
 * written to it, whatever the client request was doing when that happened. The pump
 * handles a client line and a server line in two queues that run side by side, so the
 * server can be ended while a client request is awaiting the engine, the cloak or the
 * audit. These tests end it at exactly those points, with the awaits held open by the
 * test, and ask four things of every interleaving:
 *
 * - nothing is written to the server after the end;
 * - every request the client sent is answered, and answered exactly once;
 * - a request is tracked if and only if it was written;
 * - nothing is left unhandled.
 */

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const recorder = (into: string[]): Writable =>
  new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      into.push(chunk.toString());
      done();
    },
  });

const line = (text: string): SplitLine => ({ text, eol: '\n', oversize: false });
const tool = (id: unknown, name = 'fast'): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const request = (id: unknown, method: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method });
const hostile = (n: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id: `s${n}`, method: 'sampling/createMessage', params: {} });

let home = '';
let savedHome: string | undefined;
const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};

beforeEach(() => {
  savedHome = process.env['STROQ_HOME'];
  home = mkdtempSync(join(tmpdir(), 'stroq-pump-gate-'));
  process.env['STROQ_HOME'] = home;
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
});

afterEach(async () => {
  // Let anything still unsettled settle before looking for what it threw.
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onRejection);
  expect(rejections).toEqual([]);
  if (savedHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

interface Rig {
  readonly pump: ReturnType<typeof createPump>;
  readonly ledger: StrictLedger;
  readonly serverWrites: string[];
  readonly clientWrites: string[];
  /** What happened to the ledger and the server's stdin, in order. */
  readonly events: string[];
  readonly judging: Deferred;
  readonly terminated: () => number;
  /** Sends the client's line through the pump and settles when it has been handled. */
  client(text: string): Promise<void>;
  /** Ends the server the way a hostile one is: two requests of its own, over a cap of one. */
  end(): Promise<void>;
  /** The messages the client was given that answer `id`. */
  answers(id: unknown): Record<string, unknown>[];
  /** What was written to the server after `mark`. */
  after(mark: number): string[];
}

function rig(options: { cloak?: McpCloak } = {}): Rig {
  const serverWrites: string[] = [];
  const clientWrites: string[] = [];
  const events: string[] = [];
  const judging = deferred();
  let terminated = 0;
  const ledger = new StrictLedger();
  const track = ledger.track.bind(ledger);
  ledger.track = (request) => {
    events.push(`track:${String(request.id)}`);
    track(request);
  };
  const serverIn = recorder(serverWrites);
  const write = serverIn.write.bind(serverIn) as (chunk: string) => boolean;
  (serverIn as { write: unknown }).write = (chunk: string): boolean => {
    events.push(`write:${(JSON.parse(chunk) as { id?: unknown }).id ?? '-'}`);
    return write(chunk);
  };
  const engine = {
    pre: async (event: { toolName: string }) => {
      if (event.toolName.endsWith('__slow')) await judging.promise;
      return {
        decision: { effect: 'allow', ruleId: 'test', reason: 'ok' },
        classes: [],
        provenance: [],
        secrets: [],
      };
    },
    post: async () => ({
      scan: { verdict: 'clean', score: 0, matches: [] },
      taint: null,
      scanned: true,
      atoms: [],
      provenanceError: null,
    }),
  } as unknown as StroqEngine;
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:gate', server: 'srv', cwd: tmpdir() },
    pending: new PendingTable(),
    clientIn: new PassThrough(),
    serverIn,
    serverOut: new PassThrough(),
    clientOut: recorder(clientWrites),
    cloak: options.cloak ?? null,
    strict: {
      ledger,
      maxWithheld: 1,
      scan: () => 'ok',
      terminate: () => {
        terminated += 1;
      },
      note: () => undefined,
    },
  });
  const parsed = (): Record<string, unknown>[] =>
    clientWrites
      .join('')
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  return {
    pump,
    ledger,
    serverWrites,
    clientWrites,
    events,
    judging,
    terminated: () => terminated,
    client: (text) => pump.onClientLine(line(text)),
    end: async () => {
      await pump.onServerLine(line(hostile(1)));
      await pump.onServerLine(line(hostile(2)));
    },
    answers: (id) =>
      parsed().filter(
        (message) => message['id'] === id && ('result' in message || 'error' in message),
      ),
    after: (mark) => serverWrites.slice(mark),
  };
}

const endedError = (answer: Record<string, unknown> | undefined): string =>
  String((answer?.['error'] as { message?: unknown } | undefined)?.message);

describe('a tools/call that is being judged when the server is ended', () => {
  it('is not written, not tracked, and answered once', async () => {
    const r = rig();
    const handling = r.client(tool(7, 'slow'));
    await r.end();
    expect(r.terminated()).toBe(1);
    const mark = r.serverWrites.length;
    r.judging.resolve();
    await handling;
    expect(r.after(mark)).toEqual([]);
    expect(r.events.filter((event) => event.endsWith(':7'))).toEqual([]);
    expect(r.ledger.size).toBe(0);
    expect(r.answers(7)).toHaveLength(1);
    expect(endedError(r.answers(7)[0])).toContain('ended this server');
  });

  it('is tracked and written together, in that order, when the server is still there', async () => {
    const r = rig();
    const handling = r.client(tool(7, 'slow'));
    expect(r.ledger.size).toBe(0);
    r.judging.resolve();
    await handling;
    expect(r.events).toEqual(['track:7', 'write:7']);
    expect(r.ledger.size).toBe(1);
  });
});

describe('a tools/call that restores a cloaked value', () => {
  const cloakWith = (auditing: Deferred) => {
    const auditUncloak = vi.fn(() => auditing.promise);
    const cloak = {
      planUncloak: async () => ({ ...EMPTY_PLAN, values: new Map([['<<p>>', 'v']]) }),
      applyUncloak: (params: unknown) => ({ value: params, replacements: [] }),
      auditUncloak,
    } as unknown as McpCloak;
    return { cloak, auditUncloak };
  };

  it('is not written when the server is ended while its restore is being audited', async () => {
    const auditing = deferred();
    const { cloak, auditUncloak } = cloakWith(auditing);
    const r = rig({ cloak });
    const handling = r.client(tool(7));
    await vi.waitFor(() => expect(auditUncloak).toHaveBeenCalled());
    await r.end();
    const mark = r.serverWrites.length;
    auditing.resolve();
    await handling;
    expect(r.after(mark)).toEqual([]);
    expect(r.events.filter((event) => event.endsWith(':7'))).toEqual([]);
    expect(r.ledger.size).toBe(0);
    expect(r.answers(7)).toHaveLength(1);
    expect(endedError(r.answers(7)[0])).toContain('ended this server');
  });

  it('does not even audit a restore it is not going to make, when the server was ended before', async () => {
    const auditing = deferred();
    const { cloak, auditUncloak } = cloakWith(auditing);
    const r = rig({ cloak });
    const handling = r.client(tool(7, 'slow'));
    await r.end();
    r.judging.resolve();
    await handling;
    expect(auditUncloak).not.toHaveBeenCalled();
    expect(r.answers(7)).toHaveLength(1);
  });

  it('is written once, restored, when the server is still there', async () => {
    const auditing = deferred();
    const { cloak } = cloakWith(auditing);
    const r = rig({ cloak });
    const handling = r.client(tool(7));
    auditing.resolve();
    await handling;
    expect(r.events).toEqual(['track:7', 'write:7']);
  });
});

describe('requests that overlap', () => {
  it('are each gated on their own: the one written before the end is answered by the end, the other is refused', async () => {
    const r = rig();
    const slow = r.client(tool(7, 'slow'));
    await r.client(request(5, 'tools/list'));
    expect(r.events).toEqual(['track:5', 'write:5']);
    await r.end();
    // 5 was in the ledger when the server was ended: the end answered it.
    expect(r.answers(5)).toHaveLength(1);
    const mark = r.serverWrites.length;
    r.judging.resolve();
    await slow;
    expect(r.after(mark)).toEqual([]);
    expect(r.answers(7)).toHaveLength(1);
    expect(r.ledger.size).toBe(0);
  });

  it('the answer a request written before the end was given is the only one: the late response is dropped', async () => {
    const r = rig();
    await r.client(request(5, 'tools/list'));
    await r.end();
    await r.pump.onServerLine(
      line(JSON.stringify({ jsonrpc: '2.0', id: 5, result: { tools: [] } })),
    );
    expect(r.answers(5)).toHaveLength(1);
    expect(endedError(r.answers(5)[0])).toContain('ended this server');
  });
});

describe('a cancel notification', () => {
  const cancel = (id: unknown): string =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id },
    });

  it('handled before the end is forwarded, and the request it cancels is not answered by the end', async () => {
    const r = rig();
    await r.client(request(5, 'tools/list'));
    await r.client(cancel(5));
    expect(r.events).toEqual(['track:5', 'write:5', 'write:-']);
    await r.end();
    expect(r.answers(5)).toEqual([]);
    expect(r.ledger.size).toBe(0);
  });

  it('that arrives after the end is not forwarded', async () => {
    const r = rig();
    await r.client(request(5, 'tools/list'));
    await r.end();
    const mark = r.serverWrites.length;
    await r.client(cancel(5));
    expect(r.after(mark)).toEqual([]);
    expect(r.answers(5)).toHaveLength(1);
  });
});

describe('the time between ending the server and its exit', () => {
  it('has nothing written to the server, of whatever kind, while every request is answered', async () => {
    const r = rig();
    await r.end();
    const mark = r.serverWrites.length;
    await r.client(request(1, 'tools/list'));
    await r.client(tool(2));
    await r.client(request(3, 'ping'));
    await r.client(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await r.client(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', result: {} }));
    await r.client(JSON.stringify([{ jsonrpc: '2.0', id: 4, method: 'tools/list' }]));
    await r.client('not json at all');
    await r.client(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }));
    expect(r.after(mark)).toEqual([]);
    for (const id of [1, 2, 3, 6]) expect(r.answers(id)).toHaveLength(1);
    expect(r.ledger.size).toBe(0);
  });

  it('has nothing written to the server for what the server itself sends', async () => {
    const r = rig();
    await r.end();
    const mark = r.serverWrites.length;
    await r.pump.onServerLine(line(hostile(3)));
    await r.pump.onServerLine(line(hostile(4)));
    expect(r.after(mark)).toEqual([]);
    expect(r.terminated()).toBe(1);
  });
});

describe('the refusal of a request the server made, when the server is ended meanwhile', () => {
  it('is not written to it', async () => {
    const r = rig();
    // Two server lines at once, as nothing but a test does: the first is still being
    // audited when the second ends the server.
    const first = r.pump.onServerLine(line(hostile(1)));
    const second = r.pump.onServerLine(line(hostile(2)));
    await Promise.all([first, second]);
    expect(r.terminated()).toBe(1);
    expect(r.serverWrites.filter((text) => text.includes('"id":"s1"'))).toEqual([]);
    expect(r.serverWrites.filter((text) => text.includes('"id":"s2"'))).toEqual([]);
  });
});
