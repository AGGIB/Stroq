import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * A focused, in-process counterpart to `proxy.e2e.test.ts`: `runMcpProxy` is called
 * directly against `PassThrough` streams rather than through a `stroq mcp` subprocess,
 * so this test can assert on the ONE scenario `proxy.e2e.test.ts` never sends — a
 * `tools/call` whose id is too broken for `classifyMessage` to address at all. The
 * server side is still the real `fake-server.mjs` child, spawned exactly as the proxy
 * spawns any other MCP server, so "never forwarded" is proven the same way the e2e
 * test proves it: by reading what the server actually received.
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

describe('a client tools/call whose id classifyMessage cannot address', () => {
  it('is dropped and audited rather than forwarded as a notification, and never stalls the queue', async () => {
    const serverLog = join(cwd, 'server-received.log');
    process.env['FAKE_SERVER_LOG'] = serverLog;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = lineReader(stdout);

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

    // Audited, so `stroq log`/`why` can still explain why the server never saw it.
    const audited = readFileSync(join(home, 'audit.jsonl'), 'utf8');
    expect(audited).toContain('mcp-proxy-malformed-call');
    expect(audited).toContain('an id classifyMessage could not address');
  }, 15_000);
});
