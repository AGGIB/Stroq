import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { vi } from 'vitest';
import { boundContractCapture } from '../../src/mcp/tool-contract-record.js';
import { createToolApprovalConnection } from '../../src/mcp/proxy-tool-approval.js';
import { createPump } from '../../src/mcp/proxy-pump.js';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';

/** The real strict pump with a real approval connection over a recording, in-memory store. */

export const line = (value: unknown): SplitLine => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  eol: '\n',
  oversize: false,
});
export const list = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
export const call = (id: number, name = 'lookup') => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});
export const result = (id: number, extra = {}) => ({
  jsonrpc: '2.0',
  id,
  result: {
    tools: [{ name: 'lookup', description: 'safe', inputSchema: { type: 'object' } }],
    ...extra,
  },
});
export const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export function rig(
  options: {
    deny?: boolean;
    scan?: 'ok' | 'timeout';
    maxWithheld?: number;
    policyCheck?: () => 'current' | 'changed' | 'unavailable';
  } = {},
) {
  const server: string[] = [];
  const client: string[] = [];
  const roots = new Map<unknown, unknown>();
  let approved = false;
  let revision = 0;
  let afterSend: ReturnType<typeof deferred> | null = null;
  let gateDelay: ReturnType<typeof deferred> | null = null;
  const binding = { id: 'binding-' + '0'.repeat(64), server: 'srv' };
  const store = {
    observe: vi.fn(async (_binding: unknown, value: unknown) => {
      revision += 1;
      return { capture: boundContractCapture(binding as never, value), revision: String(revision) };
    }),
    invalidate: vi.fn(async () => undefined),
    withApproved: vi.fn(
      async (_binding: unknown, _sha: string, _name: string | null, send: () => void) => {
        if (gateDelay) await gateDelay.promise;
        if (!approved) return false;
        send();
        if (afterSend) await afterSend.promise;
        return true;
      },
    ),
  };
  const approval = createToolApprovalConnection({
    store: store as never,
    binding: binding as never,
  });
  const record = (output: string[]) =>
    new Writable({
      write(chunk, _encoding, done) {
        output.push(chunk.toString());
        done();
      },
    });
  const judging = deferred();
  let slow = false;
  const engine = {
    pre: async () => {
      if (slow) await judging.promise;
      return {
        decision: { effect: options.deny ? 'deny' : 'allow', ruleId: 'test', reason: 'ok' },
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
    abandon: async () => undefined,
  } as unknown as StroqEngine;
  const ledger = new StrictLedger();
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:test', server: 'srv', cwd: process.cwd() },
    pending: new PendingTable(),
    clientIn: new PassThrough(),
    serverIn: record(server),
    serverOut: new PassThrough(),
    clientOut: record(client),
    toolApproval: approval,
    ...(options.policyCheck === undefined
      ? {}
      : { policyContinuity: { check: options.policyCheck } }),
    strict: {
      ledger,
      maxWithheld: options.maxWithheld ?? 20,
      scan: () => options.scan ?? 'ok',
      terminate: () => {},
      note: () => {},
    },
  });
  const serverSplit = async (split: SplitLine): Promise<void> => {
    pump.onServerIngress?.(split);
    await pump.onServerLine(split);
  };
  return {
    pump,
    approval,
    store,
    server,
    client,
    ledger,
    judging,
    slow: () => {
      slow = true;
    },
    approve: () => {
      approved = true;
    },
    revoke: () => {
      approved = false;
    },
    afterSend: () => {
      afterSend = deferred();
      return afterSend;
    },
    delay: () => {
      gateDelay = deferred();
      return gateDelay;
    },
    clientLine: async (value: unknown) => {
      const l = line(value);
      pump.onClientIngress?.(l);
      await pump.onClientLine(l);
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'method' in value &&
        value.method === 'tools/list' &&
        'id' in value
      ) {
        const sent = server
          .map((raw) => JSON.parse(raw))
          .filter((message) => message.method === 'tools/list' && !message.params?.cursor)
          .at(-1);
        if (sent) roots.set(value.id, sent.id);
      }
    },
    serverLine: async (value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'id' in value) {
        const original = roots.get(value.id);
        if (original) value = { ...value, id: original };
      }
      await serverSplit(line(value));
    },
    /** A server line exactly as given, oversize flag included. */
    serverSplit,
    parsed: () => client.map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}
export type ApprovalRig = ReturnType<typeof rig>;
