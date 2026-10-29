import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, FileSessionStore } from '@stroq/core';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

const allow = 'version: 1\ndefault: allow\nrules: []\n';
const deny = 'version: 1\ndefault: deny\nrules: []\n';
const inertServer = `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const input=createInterface({input:process.stdin});
input.on('line',line=>{const message=JSON.parse(line);
appendFileSync(process.env.POLICY_FIXTURE_LOG,line+'\\n');
if(message.id===undefined)return;
const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{content:[{type:'text',text:'clock fixture'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});`;

let root: string;
let user: string;
let project: string;
let selected: string;
let server: string;
const running = new Set<ReturnType<typeof start>>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-policy-process-'));
  user = join(root, 'user');
  project = join(root, 'project');
  selected = join(root, 'selected');
  server = join(root, 'server.mjs');
  for (const dir of [user, project, selected, join(user, '.stroq'), join(project, '.stroq')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(server, inertServer);
  writeFileSync(join(user, '.stroq/policy.yaml'), deny);
  writeFileSync(join(project, '.stroq/policy.yaml'), deny);
});
afterEach(async () => {
  await Promise.all([...running].map((proxy) => proxy.stop()));
  running.clear();
  rmSync(root, { recursive: true, force: true });
});

function start(options: { strict?: boolean; custom?: boolean } = {}) {
  const log = join(root, `received-${running.size}.jsonl`);
  const env = {
    ...process.env,
    HOME: user,
    USERPROFILE: user,
    STROQ_HOME: selected,
    POLICY_FIXTURE_LOG: log,
  };
  if (options.custom === false) delete (env as Record<string, string | undefined>)['STROQ_HOME'];
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      'mcp',
      '--server',
      'fixture',
      '--client',
      'fixture',
      '--cwd',
      project,
      '--pass-env',
      'POLICY_FIXTURE_LOG',
      ...(options.strict === true ? ['--strict'] : []),
      '--',
      process.execPath,
      server,
    ],
    { cwd: project, env },
  );
  const messages: Record<string, any>[] = [];
  const waiters = new Map<number, (value: Record<string, any>) => void>();
  let buffered = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    errors += data;
  });
  child.stdout.on('data', (data: string) => {
    buffered += data;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end < 0) break;
      const message = JSON.parse(buffered.slice(0, end)) as Record<string, any>;
      buffered = buffered.slice(end + 1);
      messages.push(message);
      const done = waiters.get(message['id'] as number);
      if (done) {
        waiters.delete(message['id'] as number);
        done(message);
      }
    }
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const proxy = {
    log,
    messages,
    closed,
    errors: () => errors,
    async request(id: number, method: string, params: unknown = {}) {
      const response = new Promise<Record<string, any>>((resolve) => {
        waiters.set(id, resolve);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    call: (id: number, sentinel: string) =>
      proxy.request(id, 'tools/call', { name: 'get_time', arguments: { sentinel } }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      await closed;
      running.delete(proxy);
    },
    received: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
  running.add(proxy);
  return proxy;
}

describe('the production MCP command policy continuity', () => {
  it.each([false, true])(
    'withholds future physical calls and needs a real restart (strict=%s)',
    async (strict) => {
      writeFileSync(join(selected, 'policy.yaml'), allow);
      const sessions = new FileSessionStore(join(selected, 'sessions'));
      const original = await sessions.markSuspect('mcp:fixture', {
        tool: 'fixture',
        at: new Date().toISOString(),
        ruleIds: ['fixture-suspect'],
      });
      const proxy = start({ strict });
      await proxy.request(1, 'initialize');
      expect((await proxy.call(2, 'before')).result.isError).not.toBe(true);
      writeFileSync(
        join(selected, 'policy.yaml'),
        '# equivalent edit\nrules: []\ndefault: allow\nversion: 1\nthreshold: 0.6\n',
      );
      expect((await proxy.call(3, 'equivalent')).result.isError).not.toBe(true);
      writeFileSync(join(selected, 'policy.yaml'), deny);
      const refusal = await proxy.call(4, 'after-change');
      expect(refusal.result.isError).toBe(true);
      expect(JSON.stringify(refusal)).toContain('mcp-policy-changed');
      expect(JSON.stringify(refusal)).not.toContain(selected);
      writeFileSync(join(selected, 'policy.yaml'), allow);
      expect((await proxy.call(5, 'after-revert')).result.isError).toBe(true);
      expect(proxy.received()).toContain('"sentinel":"before"');
      expect(proxy.received()).toContain('"sentinel":"equivalent"');
      expect(proxy.received()).not.toContain('after-change');
      expect(proxy.received()).not.toContain('after-revert');
      expect((await sessions.get('mcp:fixture')).taint).toEqual(original.taint);
      await proxy.stop();
      const restarted = start({ strict });
      await restarted.request(11, 'initialize');
      expect((await restarted.call(12, 'after-restart')).result.isError).not.toBe(true);
      expect(restarted.received()).toContain('after-restart');
      expect((await sessions.get('mcp:fixture')).taint).toEqual(original.taint);
    },
  );

  it('treats a missing default policy and its explicit equivalent as the same policy', async () => {
    rmSync(join(user, '.stroq/policy.yaml'));
    const proxy = start({ custom: false });
    await proxy.request(1, 'initialize');
    expect((await proxy.call(2, 'built-in')).result.isError).not.toBe(true);
    writeFileSync(join(user, '.stroq/policy.yaml'), stringify(DEFAULT_POLICY));
    expect((await proxy.call(3, 'explicit-default')).result.isError).not.toBe(true);
    writeFileSync(join(user, '.stroq/policy.yaml'), 'version: [\n');
    expect(JSON.stringify(await proxy.call(4, 'unreadable'))).toContain('mcp-policy-unavailable');
    expect(proxy.received()).not.toContain('unreadable');
  });

  it('refuses an invalid initial selected policy before starting the server', async () => {
    writeFileSync(join(selected, 'policy.yaml'), 'version: [\nPRIVATE_POLICY_TEXT');
    const proxy = start();
    expect(await proxy.closed).toBe(1);
    expect(proxy.received()).toBe('');
    expect(proxy.errors()).toBe('stroq mcp: selected policy is unavailable; refusing to start\n');
  });

  it('loads a new deny policy after restart instead of reusing the previous engine', async () => {
    writeFileSync(join(selected, 'policy.yaml'), allow);
    const first = start();
    await first.request(1, 'initialize');
    await first.call(2, 'allowed');
    await first.stop();
    writeFileSync(join(selected, 'policy.yaml'), deny);
    const next = start();
    await next.request(3, 'initialize');
    expect((await next.call(4, 'new-deny')).result.isError).toBe(true);
    expect(next.received()).not.toContain('new-deny');
  });
});
