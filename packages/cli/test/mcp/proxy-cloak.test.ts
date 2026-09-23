import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FileCloakStore } from '@stroq/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { cloakKey } from '../../src/mcp/cloak-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { cloakDir } from '../../src/paths.js';

/**
 * The cloak through the REAL proxy against the real stub server: the only place the
 * whole loop — result cloaked on the way in, placeholder echoed by a later call,
 * value restored on the way out, and the server's own log proving what it received —
 * is exercised end to end. `proxy.test.ts` covers the uncloaked proxy; everything
 * here is about `--cloak` being on.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
const SECRET = 'demo_secret_value_1234567890abcdef';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-cloak-proxy-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-cloak-proxy-cwd-'));
});

function lineReader(stream: NodeJS.ReadableStream): {
  readonly lines: readonly string[];
  waitFor(count: number): Promise<readonly string[]>;
} {
  const lines: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
    for (const waiter of [...waiters])
      if (lines.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
  });
  return {
    lines,
    async waitFor(count: number): Promise<readonly string[]> {
      if (lines.length < count)
        await new Promise<void>((resolve) => waiters.push({ count, resolve }));
      return lines;
    },
  };
}

function startPump(cloak: boolean, extraEnv: Record<string, string> = {}, failPost = false) {
  const serverLog = join(cwd, 'server-received.log');
  process.env['FAKE_SERVER_LOG'] = serverLog;
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const engine = createEngine();
  if (failPost) vi.spyOn(engine, 'post').mockRejectedValue(new Error('synthetic post failure'));
  const done = runMcpProxy({
    engine,
    sessionId: 'mcp:cloak-test',
    server: 'crm',
    cwd,
    passEnv: ['FAKE_SERVER_LOG', ...Object.keys(extraEnv)],
    command: process.execPath,
    args: [fakeServer],
    stdin,
    stdout,
    stderr,
    cloak,
  });
  return { stdin, out: lineReader(stdout), serverLog, done };
}

const call = (id: number, name: string, args: unknown = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`;

const auditText = (): string => {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

describe('the MCP proxy with --cloak off (the default)', () => {
  it('delivers structured PII to the model untouched', async () => {
    const { stdin, out, done } = startPump(false);
    stdin.write(call(1, 'get_customer'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(out.lines[0]).toContain('peter@bugle.example');
    expect(out.lines[0]).not.toContain('STROQ_EMAIL');
  });
});

describe('the MCP proxy with --cloak on', () => {
  it('judges a restored path before forwarding the call', async () => {
    const store = new FileCloakStore(join(cloakDir(), `${cloakKey('mcp:cloak-test', 'crm')}.json`));
    const entries = await store.assign([{ kind: 'name', value: '.claude/settings.json' }], '');
    const placeholder = entries.get('.claude/settings.json')?.placeholder ?? '';
    expect(placeholder).not.toBe('');

    const { stdin, out, serverLog, done } = startPump(true);
    stdin.write(call(1, 'write_file', { path: placeholder, content: 'disabled' }));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(out.lines[0]).toContain('isError');
    expect(out.lines[0]).toContain('deny-self-tamper');
    expect(existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '').not.toContain('"id":1');
  });

  it('still cloaks a result when the post scan fails', async () => {
    const { stdin, out, done } = startPump(true, {}, true);
    stdin.write(call(1, 'get_customer'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(out.lines[0]).toContain('[STROQ_EMAIL_');
    expect(out.lines[0]).not.toContain('peter@bugle.example');
  });

  it('replaces every detected value in the result and tells the model it did', async () => {
    const { stdin, out, done } = startPump(true);
    stdin.write(call(1, 'get_customer'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    const line = out.lines[0] ?? '';
    expect(line).not.toContain('peter@bugle.example');
    expect(line).not.toContain('4242 4242 4242 4242');
    expect(line).not.toContain('123-45-6789');
    expect(line).toContain('[STROQ_EMAIL_');
    expect(line).toContain('[STROQ_CARD_');
    expect(line).toContain('[STROQ_SSN_');
    expect(line).toContain('Stroq cloak');

    // The structured field is rewritten as well as the text block: a cloak that only
    // handled `content` would leave the whole record in `structuredContent`.
    const parsed = JSON.parse(line) as {
      result: { structuredContent: Record<string, string> };
    };
    expect(parsed.result.structuredContent['email']).toMatch(/^\[STROQ_EMAIL_\d+]$/);

    // The audit names the placeholder and the kind, and never a value.
    const audit = auditText();
    expect(audit).toContain('"direction":"cloak"');
    expect(audit).toContain('[STROQ_EMAIL_1]');
    expect(audit).not.toContain('peter@bugle.example');
    expect(audit).not.toContain('123-45-6789');
  });

  it('restores the placeholder for the server when the model echoes it back', async () => {
    const { stdin, out, serverLog, done } = startPump(true);
    stdin.write(call(1, 'get_customer'));
    await out.waitFor(1);
    const placeholder = /\[STROQ_EMAIL_\d+]/.exec(out.lines[0] ?? '')?.[0] ?? '';
    expect(placeholder).not.toBe('');

    stdin.write(call(2, 'send_message', { channel: 'ops', body: `hello ${placeholder}` }));
    await out.waitFor(2);
    stdin.end();
    expect(await done).toBe(0);

    // The server got the real address; the model never did.
    const received = readFileSync(serverLog, 'utf8');
    expect(received).toContain('peter@bugle.example');
    expect(received).not.toContain(placeholder);
    expect(auditText()).toContain('"direction":"uncloak"');
    // The call is JUDGED on the restored value, but the audit records what the model
    // sent. Judging restored arguments (A-03) must not become a way for the real value
    // to land in audit.jsonl, which the cloak promises never holds one.
    expect(auditText()).not.toContain('peter@bugle.example');
    expect(auditText()).toContain(`hello ${placeholder}`);
  });

  it('forwards a placeholder it cannot resolve as literal text rather than guessing', async () => {
    const { stdin, out, serverLog, done } = startPump(true);
    stdin.write(call(1, 'send_message', { channel: 'ops', body: 'hi [STROQ_EMAIL_99]' }));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(readFileSync(serverLog, 'utf8')).toContain('[STROQ_EMAIL_99]');
  });

  it('never restores a placeholder standing for a known secret, and blocks the call', async () => {
    const envFile = join(cwd, '.env');
    writeFileSync(envFile, `DEMO_API_KEY=${SECRET}\n`);
    // The PATH is what the server is given, never the value: the credential reaches
    // the model's side of the wire only through the server's RESULT, which is the
    // one direction the existing egress guard cannot see.
    const { stdin, out, serverLog, done } = startPump(true, {
      FAKE_SERVER_SECRET_FILE: envFile,
    });

    stdin.write(call(1, 'send_message', { channel: 'ops', body: 'x' }));
    await out.waitFor(1);
    stdin.write(call(2, 'echo_secret'));
    await out.waitFor(2);
    const cloaked = out.lines[1] ?? '';
    expect(cloaked).not.toContain(SECRET);
    const placeholder = /\[STROQ_SECRET_\d+]/.exec(cloaked)?.[0] ?? '';
    expect(placeholder).not.toBe('');

    // Echoing it back does NOT put the credential on the wire.
    stdin.write(call(3, 'send_message', { channel: 'ops', body: `key ${placeholder}` }));
    await out.waitFor(3);
    stdin.end();
    expect(await done).toBe(0);

    const reply = out.lines[2] ?? '';
    expect(reply).toContain('"isError":true');
    expect(reply).toContain('mcp-cloak-secret-restore');
    expect(reply).toContain('DEMO_API_KEY');
    expect(reply).not.toContain(SECRET);

    const received = readFileSync(serverLog, 'utf8');
    expect(received).not.toContain('"id":3');
    expect(received).not.toContain(SECRET);
  });

  it('drops an oversize result rather than delivering it uncloaked', async () => {
    const { stdin, out, serverLog, done } = startPump(true);
    stdin.write(call(1, 'huge', { chars: 9 * 1024 * 1024 }));
    // Nothing comes back for it, so the only way to know it was handled is to send a
    // second call and watch that one answer.
    stdin.write(call(2, 'get_time'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    expect(readFileSync(serverLog, 'utf8')).toContain('"name":"huge"');
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ id: 2 });
    expect(auditText()).toContain('mcp-cloak-unscannable-result');
  }, 30_000);

  it('drops a malformed primitive tools/call result under cloak', async () => {
    const { stdin, out, done } = startPump(true);
    stdin.write(call(1, 'primitive_result'));
    stdin.write(call(2, 'get_time'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ id: 2 });
    expect(auditText()).toContain('mcp-cloak-invalid-result');
  });

  it('forwards a clean result byte for byte, cloak or no cloak', async () => {
    const { stdin, out, done } = startPump(true);
    stdin.write(call(5, 'get_time'));
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);
    expect(out.lines[0]).toBe(
      '{"jsonrpc":"2.0", "id":5, "result":{"content":[{"type":"text","text":"2026-09-07T12:00:00Z"}]}}',
    );
  });
});
