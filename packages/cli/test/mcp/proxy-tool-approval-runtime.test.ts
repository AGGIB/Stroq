import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { createMcpToolContractsStore } from '../../src/mcp/tool-contracts.js';
import * as toolApprovals from '../../src/mcp/proxy-tool-approval.js';

const roots: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
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
  abandon: async () => undefined,
} as unknown as StroqEngine;

function start(paginated = false) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-tool-approval-live-'));
  roots.push(root);
  for (const name of ['home', 'project', 'entry', 'server', 'data'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const home = join(root, 'home');
  const source = join(root, 'data', 'tools.json');
  const calls = join(root, 'data', 'calls');
  writeFileSync(
    source,
    JSON.stringify({
      tools: [
        { name: 'look:up', description: 'First local contract', inputSchema: { type: 'object' } },
      ],
    }),
  );
  writeFileSync(join(root, 'entry', 'index.js'), '// isolated fixture runtime binding\n');
  const server = join(root, 'server', 'server.mjs');
  writeFileSync(
    server,
    `import{createInterface}from'node:readline';import{readFileSync,appendFileSync}from'node:fs';const[source,log]=process.argv.slice(2);createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${paginated}&&!m.params?.cursor?{tools:[],nextCursor:'next'}:JSON.parse(readFileSync(source,'utf8'))})+'\\n');else if(m.method==='tools/call'){appendFileSync(log,m.params.name+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ok'}]}})+'\\n');}else if(m.method==='notifications/fixture/change')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n');});`,
  );
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let carry = '';
  let errors = '';
  const messages: Record<string, unknown>[] = [];
  stdout.on('data', (chunk) => {
    carry += chunk.toString();
    let nl;
    while ((nl = carry.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(carry.slice(0, nl)) as Record<string, unknown>);
      carry = carry.slice(nl + 1);
    }
  });
  stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  const before = process.env['STROQ_HOME'];
  process.env['STROQ_HOME'] = home;
  const done = runMcpProxy({
    engine,
    sessionId: 'mcp:fixture',
    server: 'server:raw',
    client: 'cursor',
    cwd: join(root, 'project'),
    command: process.execPath,
    args: [server, source, calls],
    passEnv: [],
    strict: true,
    toolApproval: true,
    runtimeEntry: join(root, 'entry', 'index.js'),
    stdin,
    stdout,
    stderr,
    shutdownGraceMs: 30,
  });
  let ended = false;
  stops.push(async () => {
    if (ended) return;
    ended = true;
    stdin.end();
    await done;
    if (before === undefined) delete process.env['STROQ_HOME'];
    else process.env['STROQ_HOME'] = before;
  });
  /** A string is sent as it is, so a test can write JSON that `JSON.stringify` would not. */
  const send = (message: unknown) =>
    stdin.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  const answer = async (id: number) => {
    await vi.waitFor(() => expect(messages.some((m) => m.id === id)).toBe(true), {
      timeout: 10000,
    });
    return messages.find((m) => m.id === id)!;
  };
  const snapshot = async () => {
    const store = createMcpToolContractsStore({ home });
    let result: Awaited<ReturnType<typeof store.list>> | undefined;
    await vi.waitFor(async () => {
      result = await store.list();
      expect(result.records).toHaveLength(1);
    });
    return { store, snapshot: result!.records[0]! };
  };
  return {
    home,
    source,
    calls,
    send,
    answer,
    snapshot,
    messages,
    audit: (): Record<string, unknown>[] => {
      try {
        return readFileSync(join(home, 'audit.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    errors: () => errors,
    call: (id: number, name = 'look:up') =>
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }),
    list: (id: number) => send({ jsonrpc: '2.0', id, method: 'tools/list' }),
    callLog: () => {
      try {
        return readFileSync(calls, 'utf8');
      } catch {
        return '';
      }
    },
  };
}

describe('real opt-in proxy with the protected native approval store', () => {
  it.each([false, true])(
    'withholds discovery and requires fresh exact decisions (paginated=%s)',
    async (paginated) => {
      const refusals = vi.spyOn(toolApprovals, 'auditToolApprovalRefusal');
      const r = start(paginated);
      r.list(1);
      expect((await r.answer(1)).error).toBeDefined();
      expect(refusals).toHaveBeenCalledTimes(1);
      expect(refusals.mock.calls[0]?.[1]).toBe('tools/list');
      expect(r.audit()).toMatchObject([
        {
          phase: 'pre',
          tool: 'mcp__server_raw__tool_contract',
          decision: { effect: 'deny', ruleId: 'mcp-tool-contract-not-approved' },
        },
      ]);
      r.call(2);
      await r.answer(2);
      expect(r.callLog()).toBe('');
      const first = await r.snapshot();
      const a = first.snapshot.capture!.tools[0]!;
      await first.store.decide({
        bindingId: first.snapshot.binding.id,
        expectedRevision: first.snapshot.revision,
        expectedCaptureSha256: first.snapshot.capture!.sha256,
        toolId: a.id,
        expectedContractSha256: a.sha256,
        action: 'approve',
      });
      r.list(3);
      expect((await r.answer(3)).result).toBeDefined();
      r.call(4, 'look/up');
      expect((await r.answer(4)).error).toBeDefined();
      expect(r.callLog()).toBe('');
      r.call(5);
      expect((await r.answer(5)).result).toBeDefined();
      expect(r.callLog()).toBe('look:up\n');
      writeFileSync(
        r.source,
        JSON.stringify({
          tools: [
            {
              name: 'look:up',
              description: 'Changed local contract',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        }),
      );
      r.send({ jsonrpc: '2.0', method: 'notifications/fixture/change' });
      await vi.waitFor(() =>
        expect(r.messages.some((m) => m.method === 'notifications/tools/list_changed')).toBe(true),
      );
      r.call(6);
      expect((await r.answer(6)).error).toBeDefined();
      expect(r.callLog()).toBe('look:up\n');
      r.list(7);
      expect((await r.answer(7)).error).toBeDefined();
      await expect(
        first.store.decide({
          bindingId: first.snapshot.binding.id,
          expectedRevision: first.snapshot.revision,
          expectedCaptureSha256: first.snapshot.capture!.sha256,
          toolId: a.id,
          expectedContractSha256: a.sha256,
          action: 'approve',
        }),
      ).rejects.toThrow('tool-contract-stale');
      const next = await r.snapshot();
      const b = next.snapshot.capture!.tools[0]!;
      expect(b.sha256).not.toBe(a.sha256);
      await next.store.decide({
        bindingId: next.snapshot.binding.id,
        expectedRevision: next.snapshot.revision,
        expectedCaptureSha256: next.snapshot.capture!.sha256,
        toolId: b.id,
        expectedContractSha256: b.sha256,
        action: 'approve',
      });
      expect(r.callLog()).toBe('look:up\n');
      r.call(8);
      expect((await r.answer(8)).result).toBeDefined();
      expect(r.callLog()).toBe('look:up\nlook:up\n');
      expect(
        r.messages
          .map((m) => JSON.stringify(m))
          .filter((m) => m.includes('Changed local contract')),
      ).toHaveLength(0);
      expect(r.errors()).not.toContain('binding is unavailable');
    },
  );

  it('keeps the session through a cancelled call, a 20-digit argument and a constructor key', async () => {
    const r = start();
    r.list(1);
    await r.answer(1);
    const first = await r.snapshot();
    const tool = first.snapshot.capture!.tools[0]!;
    await first.store.decide({
      bindingId: first.snapshot.binding.id,
      expectedRevision: first.snapshot.revision,
      expectedCaptureSha256: first.snapshot.capture!.sha256,
      toolId: tool.id,
      expectedContractSha256: tool.sha256,
      action: 'approve',
    });
    r.list(2);
    expect((await r.answer(2)).result).toBeDefined();
    r.call(3);
    r.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    r.call(4);
    expect((await r.answer(4)).result).toBeDefined();
    r.send(
      '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"look:up","arguments":{"n":12345678901234567890}}}',
    );
    const inexact = await r.answer(5);
    expect(JSON.stringify(inexact.error)).toContain('cannot be represented exactly');
    r.send(
      '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"look:up","arguments":{"constructor":{"prototype":1},"__proto__":{"x":1}}}}',
    );
    expect((await r.answer(6)).result).toBeDefined();
    r.call(7);
    expect((await r.answer(7)).result).toBeDefined();
    expect(r.callLog()).toBe('look:up\n'.repeat(4));
    const after = await r.snapshot();
    expect(after.snapshot.observation).toBe('complete');
    expect(after.snapshot.capture!.sha256).toBe(first.snapshot.capture!.sha256);
  });
});
