import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingTable } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';

/**
 * The pump's last line of defence: an exception that escapes every handler inside
 * it. A `tools/call` whose engine throws is already answered with a fail-closed
 * deny, but that answer is written after an audit append — and when the audit log
 * cannot be written either, the exception used to reach the outer catch, which only
 * logged it. The call was neither forwarded nor answered, and the client waited for
 * a reply that never came.
 */

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['STROQ_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'stroq-pump-errors-'));
  // A directory where the audit log should be: every append to it fails.
  mkdirSync(join(home, 'audit.jsonl'));
  process.env['STROQ_HOME'] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = savedHome;
});

function pumpWithBrokenEngine(): {
  readonly onClientLine: (text: string) => Promise<void>;
  readonly toClient: () => string;
  readonly toServer: () => string;
} {
  const streams = {
    clientIn: new PassThrough(),
    serverIn: new PassThrough(),
    serverOut: new PassThrough(),
    clientOut: new PassThrough(),
  };
  let toClient = '';
  let toServer = '';
  streams.clientOut.on('data', (d: Buffer) => (toClient += d.toString()));
  streams.serverIn.on('data', (d: Buffer) => (toServer += d.toString()));
  const engine = {
    pre: () => Promise.reject(new Error('engine unavailable')),
  } as unknown as StroqEngine;
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:test', server: 'srv', cwd: tmpdir() },
    pending: new PendingTable(),
    ...streams,
  });
  return {
    onClientLine: (text) => pump.onClientLine({ text, eol: '\n', oversize: false }),
    toClient: () => toClient,
    toServer: () => toServer,
  };
}

describe('an exception that escapes the pump', () => {
  it('still answers the tools/call it was handling, and forwards nothing', async () => {
    const pump = pumpWithBrokenEngine();
    await pump.onClientLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read', arguments: {} },
      }),
    );
    const reply = JSON.parse(pump.toClient()) as { id: unknown; result?: { isError?: boolean } };
    expect(reply.id).toBe(7);
    expect(reply.result?.isError).toBe(true);
    expect(JSON.stringify(reply)).toMatch(/internal error/i);
    expect(pump.toServer()).toBe('');
  });
});
