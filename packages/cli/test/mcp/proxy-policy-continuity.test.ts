import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PLAN, type McpCloak } from '../../src/mcp/cloak.js';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const line = (value: unknown): SplitLine => ({
  text: JSON.stringify(value),
  eol: '\n',
  oversize: false,
});
const call = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'lookup', arguments: { sentinel: 'private-value' } },
});
let home: string;
let oldHome: string | undefined;
beforeEach(() => {
  oldHome = process.env['STROQ_HOME'];
  home = mkdtempSync(join(tmpdir(), 'stroq-policy-gate-'));
  process.env['STROQ_HOME'] = home;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function rig(options: { cloak?: McpCloak; continuity?: boolean; strict?: boolean } = {}) {
  const server: string[] = [];
  const client: string[] = [];
  const judging = deferred();
  let state: 'current' | 'changed' | 'unavailable' = 'current';
  const check = vi.fn(() => state);
  const engine = {
    pre: async () => {
      await judging.promise;
      return {
        decision: { effect: 'allow', ruleId: 'fixture', reason: 'allowed' },
        classes: [],
        provenance: [],
        secrets: [],
      };
    },
  } as unknown as StroqEngine;
  const record = (into: string[]) =>
    new Writable({
      write(chunk, _encoding, done) {
        into.push(chunk.toString());
        done();
      },
    });
  const pending = new PendingTable();
  const ledger = new StrictLedger();
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:fixture', server: 'fixture', cwd: tmpdir() },
    pending,
    clientIn: new PassThrough(),
    serverIn: record(server),
    serverOut: new PassThrough(),
    clientOut: record(client),
    ...(options.cloak === undefined ? {} : { cloak: options.cloak }),
    ...(options.continuity === false ? {} : { policyContinuity: { check }, home }),
    ...(options.strict === true
      ? {
          strict: {
            ledger,
            maxWithheld: 20,
            scan: () => 'ok' as const,
            terminate: () => {},
            note: () => {},
          },
        }
      : {}),
  });
  return {
    server,
    client,
    pending,
    ledger,
    judging,
    check,
    pump,
    set: (value: typeof state) => {
      state = value;
    },
    send: (value: unknown) => pump.onClientLine(line(value)),
  };
}

describe('the final physical MCP policy continuity gate', () => {
  it.each(['changed', 'unavailable'] as const)(
    'withholds a call when the policy becomes %s while engine.pre is pending',
    async (state) => {
      const r = rig({ strict: true });
      const handling = r.send(call(7));
      r.set(state);
      r.judging.resolve();
      await handling;
      expect(r.server).toEqual([]);
      expect(r.ledger.size).toBe(0);
      expect(r.pending.take(7)).toBeUndefined();
      expect(r.client).toHaveLength(1);
      expect(JSON.parse(r.client[0]!)).toMatchObject({ id: 7, result: { isError: true } });
      expect(r.client.join('')).toContain(`mcp-policy-${state}`);
      expect(r.client.join('')).toContain('Restart');
      const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
      expect(audit).toContain(`mcp-policy-${state}`);
      expect(audit).not.toContain('private-value');
      expect(r.client.join('')).not.toContain(home);
    },
  );

  it('latches the refusal even if a supplied guard later reports current', async () => {
    const r = rig();
    r.judging.resolve();
    r.set('changed');
    await r.send(call(1));
    r.set('current');
    await r.send(call(2));
    expect(r.server).toEqual([]);
    expect(r.client).toHaveLength(2);
  });

  it('turns a failed continuity check into a fixed unavailable refusal', async () => {
    const r = rig();
    r.check.mockImplementation(() => {
      throw new Error('/private/fixture/policy-secret');
    });
    r.judging.resolve();
    await r.send(call(1));
    expect(r.server).toEqual([]);
    expect(r.client.join('')).toContain('mcp-policy-unavailable');
    expect(r.client.join('')).not.toContain('policy-secret');
  });

  it('still refuses when the private audit cannot be appended', async () => {
    mkdirSync(join(home, 'audit.jsonl'));
    const r = rig();
    r.set('changed');
    r.judging.resolve();
    await r.send(call(1));
    expect(r.server).toEqual([]);
    expect(r.client).toHaveLength(1);
    expect(r.client.join('')).toContain('mcp-policy-changed');
  });

  it('does not bind an injected engine to an ambient policy source', async () => {
    const r = rig({ continuity: false });
    r.set('unavailable');
    r.judging.resolve();
    await r.send(call(1));
    expect(r.server).toHaveLength(1);
    expect(r.check).not.toHaveBeenCalled();
  });

  it('keeps initialization and lifecycle messages available after a policy refusal', async () => {
    const r = rig();
    r.judging.resolve();
    r.set('changed');
    await r.send(call(1));
    await r.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await r.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    expect(r.server).toHaveLength(2);
    expect(r.server.join('')).not.toContain('tools/call');
  });

  it('rechecks after the asynchronous cloak preparation audit', async () => {
    const auditing = deferred();
    const auditUncloak = vi.fn(() => auditing.promise);
    const cloak = {
      planUncloak: async () => ({ ...EMPTY_PLAN, values: new Map([['<<p>>', 'value']]) }),
      applyUncloak: (value: unknown) => ({ value, replacements: [] }),
      auditUncloak,
    } as unknown as McpCloak;
    const r = rig({ cloak });
    r.judging.resolve();
    const handling = r.send(call(1));
    await vi.waitFor(() => expect(auditUncloak).toHaveBeenCalledOnce());
    r.set('changed');
    auditing.resolve();
    await handling;
    expect(r.server).toEqual([]);
    expect(r.client).toHaveLength(1);
    expect(r.client.join('')).toContain('mcp-policy-changed');
  });
});
