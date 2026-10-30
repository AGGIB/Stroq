import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpCallControlGuard,
  createMcpCallControlsStore,
} from '../../src/mcp/call-control.js';
import type { McpCallControlAction } from '../../src/mcp/call-control-types.js';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';
import type { ToolApprovalConnection } from '../../src/mcp/proxy-tool-approval.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';
import { EMPTY_PLAN, type McpCloak } from '../../src/mcp/cloak.js';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
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
  params: { name: 'lookup', arguments: { sentinel: 'PRIVATE_VALUE' } },
});
let home: string;
const controlId = '11111111-2222-4333-8444-555555555555';
const invocationSha256 = 'a'.repeat(64);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-call-pump-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
async function decide(action: McpCallControlAction) {
  const store = createMcpCallControlsStore({ home });
  const state = await store.read();
  return store.decide({
    controlId,
    invocationSha256,
    action,
    operationId: randomUUID(),
    expectedRevision: state.revision,
    expectedEventId: state.controls[0]?.eventId ?? null,
  });
}
function rig(
  options: {
    strict?: boolean;
    cloak?: McpCloak;
    approval?: ToolApprovalConnection;
    slow?: boolean;
    guarded?: boolean;
  } = {},
) {
  const server: string[] = [];
  const client: string[] = [];
  const judging = deferred();
  const ledger = new StrictLedger();
  const record = (into: string[]) =>
    new Writable({
      write(chunk, _e, done) {
        into.push(chunk.toString());
        done();
      },
    });
  let drain = () => {};
  const serverIn = options.slow
    ? new Writable({
        highWaterMark: 1,
        write(chunk, _e, done) {
          server.push(chunk.toString());
          drain = done;
        },
      })
    : record(server);
  const pending = new PendingTable();
  const pump = createPump({
    ctx: {
      engine: {
        pre: async () => {
          await judging.promise;
          return {
            decision: { effect: 'allow', ruleId: 'fixture', reason: 'allowed' },
            classes: [],
            provenance: [],
            secrets: [],
          };
        },
      } as unknown as StroqEngine,
      sessionId: 'mcp:fixture',
      server: 'fixture',
      cwd: tmpdir(),
    },
    pending,
    clientIn: new PassThrough(),
    serverIn,
    serverOut: new PassThrough(),
    clientOut: record(client),
    home,
    ...(options.guarded === false
      ? {}
      : { callControl: createMcpCallControlGuard({ home, controlId, invocationSha256 }) }),
    ...(options.approval === undefined ? {} : { toolApproval: options.approval }),
    ...(options.cloak === undefined ? {} : { cloak: options.cloak }),
    ...(options.strict
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
    pump,
    drain: () => drain(),
    send: (value: unknown) => pump.onClientLine(line(value)),
  };
}
// The native call-control store is POSIX-only: on Windows it refuses with `mcp-call-control-unsupported`
// (`call-control-files.ts`), so there is nothing here to exercise.
describe.skipIf(process.platform === 'win32')('final native MCP call-control dispatch', () => {
  it.each([
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"ping","params":{"name":"lookup"}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","meth\\u006fd":"ping","params":{"name":"lookup"}}',
    '[{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"ping","params":{"name":"lookup"}}]',
    '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"nested":{"a":1,"a":2}}}',
    '{"method":"tools\\u002fcall"',
  ])(
    'refuses ambiguous or unreadable controlled wire bytes before any forward: %s',
    async (text) => {
      await decide('configure-paused');
      const r = rig();
      r.judging.resolve();
      await r.pump.onClientLine({ text, eol: '\n', oversize: false });
      expect(r.server).toEqual([]);
      expect(r.client).toHaveLength(1);
      expect(r.client.join('')).toContain('mcp-call-control-invalid-message');
      expect(r.ledger.size).toBe(0);
    },
  );
  it.each([false, true])(
    'withholds after pause during policy wait, strict=%s, then resumes same connection',
    async (strict) => {
      await decide('configure-paused');
      await decide('resume');
      const r = rig({ strict });
      const waiting = r.send(call(1));
      const paused = await decide('pause');
      r.judging.resolve();
      await waiting;
      expect(r.server).toEqual([]);
      expect(r.ledger.size).toBe(0);
      expect(r.pending.take(1)).toBeUndefined();
      expect(r.client).toHaveLength(1);
      expect(r.client.join('')).toContain('mcp-call-control-paused');
      const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
      expect(audit).not.toContain('PRIVATE_VALUE');
      expect(JSON.parse(audit.trim().split('\n').at(-1)!).mcpCallControl).toMatchObject({
        controlId,
        eventId: paused.event.id,
        reason: 'paused',
      });
      await r.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect(r.server).toHaveLength(1);
      await decide('resume');
      await r.send(call(3));
      expect(r.server).toHaveLength(2);
    },
  );
  it('rechecks after asynchronous cloak audit and preserves legacy unconfigured forwarding', async () => {
    await decide('configure-paused');
    await decide('resume');
    const auditing = deferred();
    const auditUncloak = vi.fn(() => auditing.promise);
    const cloak = {
      planUncloak: async () => ({ ...EMPTY_PLAN, values: new Map([['<<p>>', 'value']]) }),
      applyUncloak: (value: unknown) => ({ value, replacements: [] }),
      auditUncloak,
    } as unknown as McpCloak;
    const r = rig({ cloak });
    r.judging.resolve();
    const wait = r.send(call(1));
    await vi.waitFor(() => expect(auditUncloak).toHaveBeenCalledOnce());
    await decide('pause');
    auditing.resolve();
    await wait;
    expect(r.server).toEqual([]);
    const legacy = rig({ guarded: false });
    legacy.judging.resolve();
    await legacy.send(call(2));
    expect(legacy.server).toHaveLength(1);
  });
  it('releases pause lease before stream drain so a pause can complete while the sent call drains', async () => {
    await decide('configure-paused');
    await decide('resume');
    const r = rig({ slow: true });
    r.judging.resolve();
    const waiting = r.send(call(1));
    await vi.waitFor(() => expect(r.server).toHaveLength(1));
    await decide('pause');
    expect(r.client).toEqual([]);
    r.drain();
    await waiting;
    await r.send(call(2));
    expect(r.server).toHaveLength(1);
    expect(r.client).toHaveLength(1);
  });
  it('does not produce a second refusal when approval lock release throws after synchronous write', async () => {
    await decide('configure-paused');
    await decide('resume');
    const approval = {
      onClientIngress: () => {},
      onServerIngress: () => {},
      clientValid: () => true,
      admit: () => true,
      canCall: () => true,
      track: () => {},
      dispatch: async (_line: SplitLine, _name: string, write: () => void) => {
        write();
        throw Error('release');
      },
    } as unknown as ToolApprovalConnection;
    const r = rig({ approval });
    r.judging.resolve();
    await r.send(call(1));
    expect(r.server).toHaveLength(1);
    expect(r.client).toEqual([]);
    await r.send(call(2));
    expect(r.server).toHaveLength(1);
    expect(r.client).toHaveLength(1);
    expect(r.client.join('')).toContain('mcp-call-control-unavailable');
  });
  it('rereads authority immediately after the approval wait before strict tracking or writing', async () => {
    await decide('configure-paused');
    await decide('resume');
    const blocked = deferred();
    let entered = false;
    const approval = {
      onClientIngress: () => {},
      onServerIngress: () => {},
      clientValid: () => true,
      admit: () => true,
      canCall: () => true,
      track: () => {},
      dispatch: async (_line: SplitLine, _name: string, write: () => void) => {
        entered = true;
        await blocked.promise;
        write();
        return true;
      },
    } as unknown as ToolApprovalConnection;
    const r = rig({ approval, strict: true });
    r.judging.resolve();
    const waiting = r.send(call(1));
    await vi.waitFor(() => expect(entered).toBe(true));
    rmSync(join(home, 'mcp-call-controls', 'history.json'));
    blocked.resolve();
    await waiting;
    expect(r.server).toEqual([]);
    expect(r.ledger.size).toBe(0);
    expect(r.pending.take(1)).toBeUndefined();
    expect(r.client).toHaveLength(1);
    expect(r.client.join('')).toContain('mcp-call-control-unavailable');
  });
});
