import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * Covers two things together, because they are the same code path: the server-side
 * splitter's `streamOversize: true` correction (Task 2/4's review) forwards an
 * oversize line as a run of segments rather than buffering it whole, and the
 * log-once fix (this review round) must log exactly once for that whole run, not
 * once per streamed segment.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
// Past framing.ts's 8 MiB MAX_LINE_CHARS, so the response line is genuinely oversize.
const CHARS = 10 * 1024 * 1024;

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-mcp-oversize-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-oversize-cwd-'));
});

describe('an oversize server line', () => {
  it('streams through byte-for-byte and logs exactly once, not once per segment', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      out += chunk;
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

    const id = 1;
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'huge', arguments: { chars: CHARS } },
      })}\n`,
    );
    const expectedLine = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'x'.repeat(CHARS) }], isError: false },
    })}\n`;
    await vi.waitFor(() => expect(out.length).toBe(expectedLine.length), { timeout: 20_000 });
    // Byte-for-byte: an oversize line is never parsed, reassembled or reserialised
    // by the proxy, so the reconstructed text matches the original exactly.
    expect(out).toBe(expectedLine);

    stdin.end();
    expect(await done).toBe(0);

    const logged = readFileSync(join(home, 'stroq.log'), 'utf8');
    // One entry for the whole run, however many segments it streamed through as —
    // not one per segment, which for a 10 MiB line arriving in ~64 KiB chunks would
    // be dozens of synchronous appends, each carrying a full stack trace.
    expect(logged.split('server line above').length - 1).toBe(1);
  }, 30_000);
});
