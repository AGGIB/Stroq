import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AuditLog, DEFAULT_POLICY, StroqEngine, loadBundledRules } from '@stroq/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * A focused, in-process counterpart to `proxy.e2e.test.ts`: `runMcpProxy` is called
 * directly against `PassThrough` streams rather than through a `stroq mcp` subprocess,
 * so these tests can assert on scenarios `proxy.e2e.test.ts` never sends. The server
 * side is still the real `fake-server.mjs` child, spawned exactly as the proxy spawns
 * any other MCP server, so "never forwarded" is proven the same way the e2e test
 * proves it: by reading what the server actually received.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-mcp-proxy-unit-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-proxy-unit-cwd-'));
});

/** Collects complete stdout lines and lets a test await the Nth one. */
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

/** A fresh proxy wired to the real fake server, with its received-lines log wired too. */
function startPump(extraEnv: Record<string, string> = {}): {
  readonly stdin: PassThrough;
  readonly out: ReturnType<typeof lineReader>;
  readonly serverLog: string;
  readonly done: Promise<number>;
} {
  const serverLog = join(cwd, 'server-received.log');
  process.env['FAKE_SERVER_LOG'] = serverLog;
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const done = runMcpProxy({
    engine: createEngine(),
    sessionId: 'mcp:test',
    server: 'demo',
    cwd,
    command: process.execPath,
    args: [fakeServer],
    stdin,
    stdout,
    stderr,
  });
  return { stdin, out: lineReader(stdout), serverLog, done };
}

// The audit file is created lazily on the first entry; a run with no denies at all
// never writes it, which is itself the "nothing was audited" evidence some tests need.
const auditText = (): string => {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

describe('a client tools/call whose id classifyMessage cannot address', () => {
  it('is dropped and audited under its own rule rather than forwarded, and never stalls the queue', async () => {
    const { stdin, out, serverLog, done } = startPump();

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await out.waitFor(1);

    // `1e400` parses to `Infinity`: `asJsonRpcId` rejects a non-finite number, so
    // `classifyMessage` reports this as a NOTIFICATION even though its method is
    // `tools/call` — written by hand rather than through `JSON.stringify` (which
    // would collapse `Infinity` to `null` on the wire) so the exact overflow case
    // named in the ticket is what actually crosses the pipe.
    const malformed =
      '{"jsonrpc":"2.0","id":1e400,"method":"tools/call","params":{"name":"send_message","arguments":{"body":"x"}}}';
    stdin.write(`${malformed}\n`);

    // A second, addressable call right behind it: its reply arriving proves the
    // malformed line was fully handled (audit write included, since both run on the
    // same ordered queue) without stalling anything queued after it.
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_time', arguments: {} } })}\n`,
    );
    await out.waitFor(2);

    stdin.end();
    expect(await done).toBe(0);

    // Exactly two replies ever arrived: the malformed line produced neither a reply
    // nor a forward — it is simply gone.
    expect(out.lines).toHaveLength(2);
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ id: 1 });
    expect(JSON.parse(out.lines[1] ?? '')).toMatchObject({ id: 2 });

    // The server received the two addressable calls and nothing else.
    const received = readFileSync(serverLog, 'utf8');
    expect(received).toContain('"method":"initialize"');
    expect(received).toContain('"name":"get_time"');
    expect(received).not.toContain('send_message');
    expect(received).not.toContain('1e400');

    // Audited under its OWN rule id — not judge.ts's MCP_MALFORMED_CALL, whose
    // reason names a missing tool NAME, which is false here (the name was fine; the
    // id was not) — so `stroq log`/`why` can still explain why the server never saw
    // it, with a reason that actually matches what went wrong.
    const audited = auditText();
    expect(audited).toContain('mcp-proxy-unaddressable-call');
    expect(audited).not.toContain('mcp-proxy-malformed-call');
    expect(audited).toContain('an id classifyMessage could not address');
  }, 15_000);
});

describe('a non-JSON client line', () => {
  it('is forwarded unchanged, without stalling the queue behind it', async () => {
    const { stdin, out, serverLog, done } = startPump();
    const junk = 'not json at all {{{';
    stdin.write(`${junk}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    expect(out.lines).toHaveLength(1);
    const received = readFileSync(serverLog, 'utf8');
    expect(received.split('\n')[0]).toBe(junk);
  }, 15_000);
});

describe('notifications/cancelled', () => {
  it('drops the pending id so its eventual response is forwarded unscanned, with no post audit entry', async () => {
    const { stdin, out, done } = startPump();

    // tools/list is remembered as pending (a scanned method) the moment it is
    // forwarded; the cancellation removes that tracking before any response
    // arrives, even though the request itself was already sent and the server will
    // still answer it.
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`,
    );
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    // The response still reaches the client — cancellation is a best-effort hint,
    // not a retroactive un-send — but with no `post` audit entry, because
    // `pending.take(1)` found nothing to scan against.
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ id: 1 });
    expect(auditText()).not.toContain('"phase":"post"');
  }, 15_000);
});

describe('an engine that cannot answer', () => {
  /** Mirrors judge-decisions.test.ts's brokenEngine(): a session store that always rejects. */
  const brokenEngine = (): StroqEngine =>
    new StroqEngine({
      rules: loadBundledRules(),
      policy: DEFAULT_POLICY,
      sessions: {
        get: () => Promise.reject(new Error('session store is unavailable')),
        markSuspect: () => Promise.reject(new Error('session store is unavailable')),
        clear: () => Promise.resolve(),
      },
      audit: new AuditLog(join(home, 'audit.jsonl')),
    });

  it('answers fail-closed and audits the failure when engine.pre throws while judging a tools/call', async () => {
    const serverLog = join(cwd, 'server-received.log');
    process.env['FAKE_SERVER_LOG'] = serverLog;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = lineReader(stdout);
    const done = runMcpProxy({
      engine: brokenEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      command: process.execPath,
      args: [fakeServer],
      stdin,
      stdout,
      stderr,
    });

    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: {} } })}\n`,
    );
    await out.waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    const reply = JSON.parse(out.lines[0] ?? '') as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain(
      'Stroq internal error (fail-closed): session store is unavailable',
    );

    const audited = auditText();
    expect(audited).toContain('mcp-proxy-internal-error');
    expect(audited).toContain('Stroq internal error (fail-closed): session store is unavailable');
  }, 15_000);
});

describe('a server command that cannot be spawned at all', () => {
  it('exits 1 with a message on stderr, well under the shutdown grace period', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrText = '';
    stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });
    stderr.setEncoding('utf8');

    const start = Date.now();
    const code = await runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      command: join(cwd, 'stroq-does-not-exist-binary'),
      args: [],
      stdin,
      stdout,
      stderr,
    });
    const elapsed = Date.now() - start;

    expect(code).toBe(1);
    expect(stderrText).toContain('stroq mcp: cannot start the MCP server');
    expect(elapsed).toBeLessThan(2000);
  }, 15_000);
});
