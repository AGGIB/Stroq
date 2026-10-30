import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPump } from '../../src/mcp/proxy-pump.js';
import { createToolApprovalConnection } from '../../src/mcp/proxy-tool-approval.js';
import { boundContractCapture } from '../../src/mcp/tool-contract-record.js';
import { OrderedQueue } from '../../src/mcp/pump-stream.js';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';
import * as toolApprovals from '../../src/mcp/proxy-tool-approval.js';

const live: ReturnType<typeof createPump>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const pump of live.splice(0)) await pump.close?.();
});
const line = (value: unknown): SplitLine => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  eol: '\n',
  oversize: false,
});
const tool = (name: string) => ({
  name,
  description: 'bounded fixture',
  inputSchema: { type: 'object' },
});
function rig(
  options: {
    timeoutMs?: number;
    scan?: () => 'ok' | 'timeout';
    guard?: Promise<void>;
    queue?: OrderedQueue;
  } = {},
) {
  const writes: string[] = [];
  const replies: string[] = [];
  const binding = { id: 'binding-' + '0'.repeat(64), server: 'srv' };
  const store = {
    invalidate: vi.fn(async () => {}),
    observe: vi.fn(async (_binding: unknown, value: unknown) => ({
      capture: boundContractCapture(binding as never, value),
    })),
    withApproved: vi.fn(
      async (_b: unknown, _sha: string, _name: string | null, write: () => void) => {
        if (options.guard) await options.guard;
        write();
        return true;
      },
    ),
  };
  const approval = createToolApprovalConnection({
    binding: binding as never,
    store: store as never,
  });
  const record = (target: string[]) =>
    new Writable({
      write(chunk, _enc, done) {
        target.push(chunk.toString());
        done();
      },
    });
  const engine = {
    pre: async () => ({
      decision: { effect: 'allow', ruleId: 'fixture', reason: 'ok' },
      classes: [],
      provenance: [],
      secrets: [],
    }),
    post: async () => ({
      scan: { verdict: 'clean', score: 0, matches: [] },
      taint: null,
      scanned: true,
      atoms: [],
      provenanceError: null,
    }),
    abandon: async () => {},
  } as unknown as StroqEngine;
  const ledger = new StrictLedger();
  const serverIn = record(writes);
  const clientIn = new PassThrough();
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:pages', server: 'srv', cwd: process.cwd() },
    pending: new PendingTable(),
    clientIn,
    serverIn,
    serverOut: new PassThrough(),
    clientOut: record(replies),
    toolApproval: approval,
    toolPaginationTimeoutMs: options.timeoutMs ?? 1000,
    ...(options.queue === undefined
      ? {}
      : { enqueueToServer: (task: () => Promise<void>) => options.queue!.run(task) }),
    strict: {
      ledger,
      maxWithheld: 20,
      scan: options.scan ?? (() => 'ok'),
      terminate: () => {},
      note: () => {},
    },
  });
  live.push(pump);
  const parsed = () => replies.map((v) => JSON.parse(v) as Record<string, unknown>);
  return {
    pump,
    store,
    ledger,
    writes,
    replies,
    parsed,
    serverIn,
    clientIn,
    client: async (v: unknown) => {
      const l = line(v);
      pump.onClientIngress?.(l);
      await pump.onClientLine(l);
    },
    server: async (v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in v && v.id === 7) {
        const sent = writes
          .map((raw) => JSON.parse(raw))
          .filter((m) => m.method === 'tools/list' && !m.params?.cursor)
          .at(-1);
        if (sent) v = { ...v, id: sent.id };
      }
      const l = line(v);
      pump.onServerIngress?.(l);
      await pump.onServerLine(l);
    },
    next: async () => {
      await vi.waitFor(() => expect(writes.some((v) => JSON.parse(v).params?.cursor)).toBe(true));
      return writes.map((v) => JSON.parse(v)).find((v) => v.params?.cursor);
    },
  };
}
const root = { jsonrpc: '2.0', id: 7, method: 'tools/list' };
const response = (id: unknown, tools: unknown[], nextCursor?: unknown) => ({
  jsonrpc: '2.0',
  id,
  result: { tools, ...(nextCursor === undefined ? {} : { nextCursor }) },
});

describe('bounded complete MCP listings in the actual strict pump', () => {
  it('holds all pages, uses private IDs, then publishes only one scanned aggregate', async () => {
    const r = rig();
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    expect(r.replies).toEqual([]);
    expect(r.store.observe).not.toHaveBeenCalled();
    const request = await r.next();
    expect(request.method).toBe('tools/list');
    expect(request.params).toEqual({ cursor: 'next' });
    expect(request.id).not.toBe(7);
    await r.server(response(request.id, [tool('second')]));
    expect(r.parsed()).toEqual([
      { jsonrpc: '2.0', id: 7, result: { tools: [tool('first'), tool('second')] } },
    ]);
    expect(r.replies.join('')).not.toContain(String(request.id));
    expect(r.store.observe).toHaveBeenCalledTimes(1);
    expect(r.ledger.size).toBe(0);
  });
  it('times out once and ignores a late private page without leaking its ID', async () => {
    const r = rig({ timeoutMs: 20 });
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    const request = await r.next();
    await vi.waitFor(() => expect(r.parsed().filter((v) => v.id === 7)).toHaveLength(1));
    await r.server(response(request.id, [tool('second')]));
    expect(r.parsed()).toHaveLength(1);
    expect(r.parsed()[0]?.error).toBeDefined();
    expect(r.store.observe).not.toHaveBeenCalled();
    expect(r.replies.join('')).not.toContain(request.id);
  });
  it('fails a cycle or duplicate across pages before observation', async () => {
    for (const [tools, cursor] of [
      [[tool('first')], undefined],
      [[tool('second')], 'next'],
    ] as const) {
      const r = rig();
      await r.client(root);
      await r.server(response(7, [tool('first')], 'next'));
      const request = await r.next();
      await r.server(response(request.id, [...tools], cursor));
      await vi.waitFor(() => expect(r.parsed()).toHaveLength(1));
      expect(r.parsed()[0]?.error).toBeDefined();
      expect(r.store.observe).not.toHaveBeenCalled();
    }
  });
  it('routes strict scan failure on a private page to the original request only', async () => {
    let timeout = false;
    const r = rig({ scan: () => (timeout ? 'timeout' : 'ok') });
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    const request = await r.next();
    timeout = true;
    await r.server(response(request.id, [tool('second')]));
    await vi.waitFor(() => expect(r.parsed()).toHaveLength(1));
    expect(r.parsed()[0]?.id).toBe(7);
    expect(r.parsed()[0]?.error).toBeDefined();
    expect(r.replies.join('')).not.toContain(request.id);
    expect(r.store.observe).not.toHaveBeenCalled();
  });
  it('aborts held discovery synchronously on list_changed and never answers late pages twice', async () => {
    const r = rig();
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    const request = await r.next();
    await r.server({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    await r.server(response(request.id, [tool('second')]));
    await vi.waitFor(() => expect(r.parsed().filter((v) => v.id === 7)).toHaveLength(1));
    expect(r.store.observe).not.toHaveBeenCalled();
    expect(r.replies.join('')).not.toContain(request.id);
  });
  it('invalidates unknown reserved responses after a completed listing', async () => {
    const r = rig();
    await r.client(root);
    await r.server(response(7, [tool('first')]));
    await r.server(response('stroq-tools:unknown:1', []));
    await r.client({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'first', arguments: {} },
    });
    expect(r.writes.join('')).not.toContain('tools/call');
    expect(r.replies.join('')).not.toContain('stroq-tools:unknown:1');
  });
  it('checks the absolute deadline again inside the physical discovery write guard', async () => {
    let release = () => {};
    const guard = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ guard, timeoutMs: 1000 });
    await r.client(root);
    const serving = r.server(response(7, [tool('first')]));
    await vi.waitFor(() => expect(r.store.withApproved).toHaveBeenCalledTimes(1));
    const later = Date.now() + 2000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    release();
    await serving;
    await vi.waitFor(() => expect(r.parsed().filter((v) => v.id === 7)).toHaveLength(1));
    expect(r.parsed()[0]?.error).toBeDefined();
    expect(r.replies.join('')).not.toContain('bounded fixture');
  });

  it('does not retarget a late original response after a duplicate active root ID', async () => {
    const r = rig();
    await r.client(root);
    await r.client(root);
    await r.server(response(7, [tool('old')]));
    await vi.waitFor(() => expect(r.parsed().filter((v) => v.id === 7)).toHaveLength(1));
    expect(r.store.observe).not.toHaveBeenCalled();
    expect(
      r.writes.map((v) => JSON.parse(v)).filter((v) => v.method === 'tools/list'),
    ).toHaveLength(1);
    expect(r.parsed()[0]?.error).toBeDefined();
  });

  it('keeps first-root backpressure in the client queue before dispatching another root', async () => {
    const r = rig();
    const original = r.serverIn.write.bind(r.serverIn) as (chunk: string) => boolean;
    (r.serverIn as { write: unknown }).write = (chunk: string) => {
      original(chunk);
      return false;
    };
    const queue = new OrderedQueue();
    const first = line(root);
    r.pump.onClientIngress?.(first);
    queue.run(() => r.pump.onClientLine(first));
    await vi.waitFor(() => expect(r.writes).toHaveLength(1));
    expect(r.clientIn.isPaused()).toBe(true);
    const second = line({ ...root, id: 8 });
    r.pump.onClientIngress?.(second);
    queue.run(() => r.pump.onClientLine(second));
    await Promise.resolve();
    expect(r.writes).toHaveLength(1);
    r.serverIn.emit('drain');
    await vi.waitFor(() => expect(r.writes).toHaveLength(2));
    r.serverIn.emit('drain');
    await queue.idle();
  });
  it('scans the complete aggregate as well as both individual pages', async () => {
    const scan = vi.fn<() => 'ok' | 'timeout'>(() => 'ok');
    const r = rig({ scan });
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    const request = await r.next();
    await r.server(response(request.id, [tool('second')]));
    expect(scan).toHaveBeenCalledTimes(3);
    expect(r.store.observe).toHaveBeenCalledTimes(1);
    let count = 0;
    const failed = rig({ scan: () => (++count === 3 ? 'timeout' : 'ok') });
    await failed.client(root);
    await failed.server(response(7, [tool('first')], 'next'));
    const next = await failed.next();
    await failed.server(response(next.id, [tool('second')]));
    expect(failed.store.observe).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(failed.parsed()[0]?.error).toBeDefined());
  });
  it('cancels a held root silently and never publishes a late page', async () => {
    const refusals = vi.spyOn(toolApprovals, 'auditToolApprovalRefusal');
    const r = rig();
    await r.client(root);
    await r.server(response(7, [tool('first')], 'next'));
    const request = await r.next();
    await r.client({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await r.server(response(request.id, [tool('second')]));
    expect(r.parsed()).toEqual([]);
    expect(r.store.observe).not.toHaveBeenCalled();
    expect(r.ledger.size).toBe(0);
    expect(refusals).not.toHaveBeenCalled();
  });
  it('does not accept a server response echoing the private client root ID instead of its wire ID', async () => {
    const r = rig();
    await r.client(root);
    const raw = line(response(7, [tool('first')]));
    r.pump.onServerIngress?.(raw);
    await r.pump.onServerLine(raw);
    await vi.waitFor(() => expect(r.parsed().filter((v) => v.id === 7)).toHaveLength(1));
    expect(r.parsed()[0]?.error).toBeDefined();
    expect(r.store.observe).not.toHaveBeenCalled();
  });
  it('consumes cancellation at ingress despite client backpressure and preserves the replacement walk', async () => {
    const queue = new OrderedQueue();
    const r = rig({ queue });
    await r.client(root);
    const first = JSON.parse(r.writes[0]!).id;
    const original = r.serverIn.write.bind(r.serverIn) as (chunk: string) => boolean;
    (r.serverIn as { write: unknown }).write = (chunk: string) => {
      const accepted = original(chunk);
      return JSON.parse(chunk).id === 99 ? false : accepted;
    };
    const ping = line({ jsonrpc: '2.0', id: 99, method: 'ping' });
    r.pump.onClientIngress?.(ping);
    queue.run(() => r.pump.onClientLine(ping));
    const cancel = line({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    });
    r.pump.onClientIngress?.(cancel);
    queue.run(() => r.pump.onClientLine(cancel));
    const fresh = line(root);
    r.pump.onClientIngress?.(fresh);
    queue.run(() => r.pump.onClientLine(fresh));
    try {
      await vi.waitFor(() => expect(r.writes).toHaveLength(2));
      expect(r.clientIn.isPaused()).toBe(true);
      await r.server(response(first, [tool('old')]));
      expect(r.parsed()).toEqual([]);
      expect(r.store.observe).not.toHaveBeenCalled();
    } finally {
      r.serverIn.emit('drain');
      await queue.idle();
    }
    const next = r.writes
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.method === 'tools/list')
      .at(-1)!;
    expect(next.id).not.toBe(first);
    await r.server(response(next.id, [tool('new')]));
    expect(r.parsed()).toEqual([{ jsonrpc: '2.0', id: 7, result: { tools: [tool('new')] } }]);
    expect(r.store.observe).toHaveBeenCalledTimes(1);
    expect(
      r.writes
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.method === 'notifications/cancelled'),
    ).toEqual([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: first } },
    ]);
  });
  it('consumes cancellation while the final approval guard is awaiting without a second queued invalidation', async () => {
    let release = () => {};
    const guard = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({ guard });
    const refusals = vi.spyOn(toolApprovals, 'auditToolApprovalRefusal');
    await r.client(root);
    const serving = r.server(response(7, [tool('old')]));
    await vi.waitFor(() => expect(r.store.withApproved).toHaveBeenCalledTimes(1));
    const cancel = line({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    });
    r.pump.onClientIngress?.(cancel);
    release();
    await serving;
    expect(r.parsed()).toEqual([]);
    await r.pump.onClientLine(cancel);
    expect(r.parsed()).toEqual([]);
    expect(refusals).not.toHaveBeenCalled();
  });
  // A malformed cancellation is refused on its own: it neither cancels the walk (which would
  // leave the root unanswered) nor reaches the server, and the walk is answered as usual.
  it.each([{ jsonrpc: '1.0' }, { extra: true }])(
    'does not take malformed cancellation %j for one',
    async (extra) => {
      const r = rig();
      await r.client(root);
      const malformed = line({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 7 },
        ...extra,
      });
      r.pump.onClientIngress?.(malformed);
      await r.pump.onClientLine(malformed);
      expect(r.writes.some((raw) => raw.includes('notifications/cancelled'))).toBe(false);
      await r.server(response(7, [tool('first')]));
      await vi.waitFor(() => expect(r.parsed()).toHaveLength(1));
      expect(r.parsed()[0]).toMatchObject({ id: 7, result: { tools: [{ name: 'first' }] } });
    },
  );
});
