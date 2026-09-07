import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * `handleClientLine`'s robustness fixes: a leading byte-order mark no longer defeats
 * parsing (Jackson/.NET servers are documented to strip it, and some clients forward
 * it as-is), a `tools/call` request survives a differently-cased method name, and a
 * client line that NAMES tools/call but still cannot be parsed is denied fail-closed
 * rather than forwarded blind — the one case where "the client is trusted on
 * framing" is not enough, since a JSON quirk this proxy cannot even identify is
 * exactly how a secret-bearing call could dodge every other check.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
const SECRET = 'stroq_test_mcp_bom_secret_0123456789';
const BOM = '﻿';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-mcp-parsing-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-parsing-cwd-'));
});

function startPump(): {
  readonly stdin: PassThrough;
  readonly lines: readonly string[];
  readonly serverLog: string;
  waitFor(count: number): Promise<readonly string[]>;
  readonly done: Promise<number>;
} {
  const serverLog = join(cwd, 'server-received.log');
  process.env['FAKE_SERVER_LOG'] = serverLog;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines: string[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
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
  return {
    stdin,
    lines,
    serverLog,
    async waitFor(count: number): Promise<readonly string[]> {
      if (lines.length < count)
        await new Promise<void>((resolve) => waiters.push({ count, resolve }));
      return lines;
    },
    done,
  };
}

const auditText = (): string => {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

/** The text of a result's first content item. */
function firstText(line: string): string {
  const parsed = JSON.parse(line) as { result?: { content?: { text?: unknown }[] } };
  const text = parsed.result?.content?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

describe('a leading byte-order mark on a client line', () => {
  it('is stripped for parsing and the ORIGINAL bytes, BOM included, are what a forward sends', async () => {
    const { stdin, serverLog, done } = startPump();
    const bomLine = `${BOM}${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_time', arguments: {} },
    })}`;
    stdin.write(`${bomLine}\n`);
    // No reply is awaited here: the fake server's OWN `JSON.parse` is not
    // BOM-tolerant (unlike the proxy, after this fix), so it never answers a
    // BOM-prefixed line — but `FAKE_SERVER_LOG` is appended before that parse is
    // even attempted, so the received-bytes proof does not depend on a reply.
    // `stdin.end()` only lets the server's own stdin see EOF once this line has
    // already been forwarded (same `toServer` queue, strict order), and `done`
    // only resolves once the server has fully exited, by which point its
    // synchronous `appendFileSync` of this line has necessarily already run.
    stdin.end();
    expect(await done).toBe(0);

    const received = readFileSync(serverLog, 'utf8');
    expect(received.split('\n')[0]).toBe(bomLine);
  }, 15_000);

  it('is judged for a real policy reason rather than merely dropped as unreadable', async () => {
    writeFileSync(join(cwd, '.env'), `MCP_BOM_TOKEN=${SECRET}\n`);
    const { stdin, waitFor, done } = startPump();
    const bomLine = `${BOM}${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { body: `token=${SECRET}` } },
    })}`;
    stdin.write(`${bomLine}\n`);
    const lines = await waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    // A deny for the REAL secret-egress reason — not `mcp-proxy-unparseable-call` —
    // proves the BOM was stripped and the line was actually handed to the engine.
    expect(firstText(lines[0] ?? '')).toContain('Stroq blocked this action (deny-secret-egress)');
    expect(firstText(lines[0] ?? '')).not.toContain(SECRET);
  }, 15_000);
});

describe('a request method cased differently from tools/call', () => {
  it('is still judged as a tools/call rather than forwarded as an ordinary request', async () => {
    writeFileSync(join(cwd, '.env'), `MCP_CASE_TOKEN=${SECRET}\n`);
    const { stdin, waitFor, serverLog, done } = startPump();
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'Tools/Call',
        params: { name: 'send_message', arguments: { body: `token=${SECRET}` } },
      })}\n`,
    );
    const lines = await waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    expect(firstText(lines[0] ?? '')).toContain('Stroq blocked this action (deny-secret-egress)');
    // Denied, so it never reached the server at all.
    expect(existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '').toBe('');
  }, 15_000);
});

describe('a notification method cased differently from notifications/cancelled', () => {
  it('still drops the pending id, exactly as the canonical casing does', async () => {
    const { stdin, waitFor, done } = startPump();

    // `tools/list` is remembered as pending the moment it is forwarded, and the
    // fake server's listing carries a poisoned tool description — so a response
    // still being tracked when it arrives IS scanned and DOES leave a `post` audit
    // entry. That entry's absence is what proves the oddly-cased cancellation was
    // honoured rather than passed through as an ordinary notification.
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'Notifications/Cancelled',
        params: { requestId: 1 },
      })}\n`,
    );
    const lines = await waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    // Cancellation is a best-effort hint, not a retroactive un-send: the response
    // still reaches the client, just untracked and therefore unscanned.
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ id: 1 });
    expect(auditText()).not.toContain('"phase":"post"');
  }, 15_000);
});

describe('a client line naming tools/call that still cannot be parsed', () => {
  it('is denied fail-closed and dropped rather than forwarded blind, without stalling the queue', async () => {
    const { stdin, waitFor, serverLog, done } = startPump();
    const junk = 'this names tools/call but is not valid JSON {{{';
    stdin.write(`${junk}\n`);
    // A real request right behind it proves the queue was not stalled.
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const lines = await waitFor(1);
    stdin.end();
    expect(await done).toBe(0);

    // Only the initialize reply ever arrived — nothing at all for the junk line.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ id: 1 });
    expect(existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '').not.toContain(
      'tools/call',
    );

    const audited = auditText();
    expect(audited).toContain('mcp-proxy-unparseable-call');
    // The reason names no content from the line itself, which may carry a secret.
    expect(audited).not.toContain(junk);
  }, 15_000);
});
