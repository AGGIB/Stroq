import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DEFAULT_POLICY, FileSecretIndex, FileSessionStore, PolicySchema } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineAt } from '../../src/engine-factory.js';
import { PendingTable } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';

const roots: string[] = [];
const initialCwd = process.cwd();
afterEach(() => {
  process.chdir(initialCwd);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(server = 'github') {
  const root = mkdtempSync(join(tmpdir(), 'stroq-mcp-forward-'));
  roots.push(root);
  const project = join(root, 'project'),
    user = join(root, 'user'),
    home = join(root, 'state');
  mkdirSync(project);
  mkdirSync(user);
  const engine = createEngineAt({
    home,
    userHome: user,
    projectRoot: project,
    env: {},
    policy: PolicySchema.parse({
      ...DEFAULT_POLICY,
      version: 2,
      mcpGovernance: { allowed: [{ channel: 'mcp-proxy', name: 'github' }] },
    }),
  });
  const serverLines: string[] = [],
    clientLines: string[] = [];
  const record = (lines: string[]) =>
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
  const pending = new PendingTable();
  const pre = vi.spyOn(engine, 'pre');
  const pump = createPump({
    ctx: { engine, sessionId: 'fixture', server, cwd: project },
    pending,
    clientIn: new PassThrough(),
    serverIn: record(serverLines),
    serverOut: new PassThrough(),
    clientOut: record(clientLines),
    home,
  });
  const send = async (args: Record<string, unknown> = { query: 'fixture' }, tool = 'get_issue') => {
    const text = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: tool,
        arguments: args,
        mcpIdentity: { kind: 'server', channel: 'mcp-proxy', name: 'github' },
      },
    });
    await pump.onClientLine({ text, eol: '\n', oversize: false });
    return text;
  };
  return { home, user, project, pre, send, serverLines, clientLines, pending };
}

describe('real MCP pump forwarding boundary', () => {
  it('forwards a listed connection once, keeping its original wire bytes', async () => {
    const f = fixture();
    const text = await f.send({}, 'mcp__unlisted__get_issue');
    expect(f.serverLines).toEqual([`${text}\n`]);
    expect(f.clientLines).toEqual([]);
    expect(f.pre).toHaveBeenCalledOnce();
    expect(f.pre.mock.calls[0]![0].mcpIdentity).toEqual({
      kind: 'server',
      channel: 'mcp-proxy',
      name: 'github',
    });
    expect(f.pending.take(1)).toBeDefined();
  });

  it.each(['unlisted', 'git hub', ''])(
    'withholds connection %j despite its forged wire witness',
    async (server) => {
      const f = fixture(server);
      await f.send();
      expect(f.serverLines).toEqual([]);
      expect(f.pending.take(1)).toBeUndefined();
      expect(f.clientLines).toHaveLength(1);
      expect(JSON.parse(f.clientLines[0]!)).toMatchObject({ id: 1, result: { isError: true } });
      expect((await f.pre.mock.results[0]!.value).decision.ruleId).toBe(
        server === '' ? 'mcp-governance-identity-unknown' : 'mcp-governance-unlisted',
      );
    },
  );

  it('keeps known-secret refusal after the exact server passes governance', async () => {
    const f = fixture();
    const secret = `fixture_mcp_canary_${'x'.repeat(32)}`;
    process.chdir(f.project);
    await new FileSecretIndex(join(f.home, 'secrets.json'), f.user, {}).addCanary(
      secret,
      'fixture',
    );
    await f.send({ body: secret });
    expect(f.serverLines).toEqual([]);
    expect(f.pending.take(1)).toBeUndefined();
    expect((await f.pre.mock.results[0]!.value).decision.ruleId).toBe('deny-secret-egress');
    expect(f.clientLines.join('')).not.toContain(secret);
  });

  it('keeps the suspect-session side-effect question after governance', async () => {
    const f = fixture();
    await new FileSessionStore(join(f.home, 'sessions')).markSuspect('fixture', {
      tool: 'Read',
      ruleIds: ['fixture'],
      at: new Date(0).toISOString(),
    });
    await f.send({ body: 'fixture' }, 'post_message');
    expect(f.serverLines).toEqual([]);
    expect(f.pending.take(1)).toBeUndefined();
    expect((await f.pre.mock.results[0]!.value).decision.ruleId).toBe(
      'ask-mcp-side-effect-when-tainted',
    );
  });
});
