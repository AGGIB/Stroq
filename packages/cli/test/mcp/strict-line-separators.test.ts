import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingTable, type SplitLine } from '../../src/mcp/framing.js';
import { createPump } from '../../src/mcp/proxy-pump.js';
import { escapeLineSeparators } from '../../src/mcp/strict-line.js';
import { StrictLedger } from '../../src/mcp/strict-ledger.js';
import { handlerRig, track } from './strict-handler-rig.js';

/**
 * Three characters end a line for a reader that is not strict about it: U+2028 and U+2029
 * (the Unicode line and paragraph separators, which JSON allows raw inside a string and
 * `JSON.stringify` writes raw) and U+0085 (NEL). A client that splits the stream into
 * messages on any of them would cut a strict-mode message in two at a character the
 * server chose. Strict mode writes them as the escapes ` `, ` ` and `\u0085`,
 * which a JSON parser reads back as the same character, in every line it writes.
 */

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const ALL = `a${LS}b${PS}c${NEL}d`;
const RAW = new RegExp(`[${LS}${PS}${NEL}]`);

describe('escapeLineSeparators', () => {
  it('writes each of the three as a JSON escape, and nothing else changes', () => {
    expect(escapeLineSeparators(JSON.stringify({ t: ALL }))).toBe(
      '{"t":"a\\u2028b\\u2029c\\u0085d"}',
    );
    const plain = JSON.stringify({ t: 'plain \n text', n: 1, u: 'é–ü' });
    expect(escapeLineSeparators(plain)).toBe(plain);
  });

  it('is read back by a JSON parser as the same text', () => {
    const value = { t: ALL, k: { [ALL]: [ALL] } };
    expect(JSON.parse(escapeLineSeparators(JSON.stringify(value)))).toEqual(value);
  });
});

describe('a message the strict handler delivers', () => {
  it('has none of the three raw in its line, and the text still reads back whole', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: ALL }], structuredContent: { [ALL]: ALL } },
      }),
    );
    expect(rig.lines).toHaveLength(1);
    const line = rig.lines[0] as string;
    expect(RAW.test(line)).toBe(false);
    expect(line).toContain('\\u2028');
    expect(line).toContain('\\u2029');
    expect(line).toContain('\\u0085');
    const parsed = JSON.parse(line) as { result: { content: { text: string }[] } };
    expect(parsed.result.content[0]?.text).toBe(ALL);
  });
});

/** A pump with recorders for what it writes to each side, in strict mode or not. */
function pumpOf(strict: boolean) {
  const serverWrites: string[] = [];
  const clientWrites: string[] = [];
  const recorder = (into: string[]): Writable =>
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        into.push(chunk.toString());
        done();
      },
    });
  const engine = {
    pre: async () => ({
      decision: { effect: 'deny', ruleId: 'test-deny', reason: 'no' },
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
  } as unknown as StroqEngine;
  const pump = createPump({
    ctx: { engine, sessionId: 'mcp:ls', server: 'srv', cwd: tmpdir() },
    pending: new PendingTable(),
    clientIn: new PassThrough(),
    serverIn: recorder(serverWrites),
    serverOut: new PassThrough(),
    clientOut: recorder(clientWrites),
    strict: strict
      ? {
          ledger: new StrictLedger(),
          maxWithheld: 1,
          scan: () => 'ok',
          terminate: () => undefined,
          note: () => undefined,
        }
      : null,
  });
  const line = (text: string): SplitLine => ({ text, eol: '\n', oversize: false });
  return {
    serverWrites,
    clientWrites,
    client: (text: string) => pump.onClientLine(line(text)),
    server: (text: string) => pump.onServerLine(line(text)),
  };
}

let home = '';
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env['STROQ_HOME'];
  home = mkdtempSync(join(tmpdir(), 'stroq-ls-'));
  process.env['STROQ_HOME'] = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('the lines Stroq builds under --strict', () => {
  it('escape them in the refusal written to the server, whose id the server chose', async () => {
    const p = pumpOf(true);
    await p.server(
      JSON.stringify({ jsonrpc: '2.0', id: ALL, method: 'sampling/createMessage', params: {} }),
    );
    expect(p.serverWrites).toHaveLength(1);
    expect(RAW.test(p.serverWrites[0] as string)).toBe(false);
    expect((JSON.parse(p.serverWrites[0] as string) as { id: unknown }).id).toBe(ALL);
  });

  it('escape them in the answer to a request the client sent after the server was ended', async () => {
    const p = pumpOf(true);
    await p.server(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'roots/list' }));
    await p.server(JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'roots/list' }));
    await p.client(JSON.stringify({ jsonrpc: '2.0', id: ALL, method: 'tools/list' }));
    const answer = p.clientWrites.find((text) => text.includes('ended this server')) as string;
    expect(RAW.test(answer)).toBe(false);
    expect((JSON.parse(answer) as { id: unknown }).id).toBe(ALL);
  });

  it('escape them in the denial of a call, the other answer the client is given', async () => {
    const p = pumpOf(true);
    await p.client(
      JSON.stringify({
        jsonrpc: '2.0',
        id: ALL,
        method: 'tools/call',
        params: { name: 'any', arguments: {} },
      }),
    );
    expect(p.clientWrites).toHaveLength(1);
    expect(RAW.test(p.clientWrites[0] as string)).toBe(false);
    expect((JSON.parse(p.clientWrites[0] as string) as { id: unknown }).id).toBe(ALL);
  });
});

describe('the lines the default proxy builds', () => {
  it('are written exactly as before: the characters stay raw', async () => {
    const p = pumpOf(false);
    await p.client(
      JSON.stringify({
        jsonrpc: '2.0',
        id: ALL,
        method: 'tools/call',
        params: { name: 'any', arguments: {} },
      }),
    );
    expect(p.clientWrites).toHaveLength(1);
    expect(RAW.test(p.clientWrites[0] as string)).toBe(true);
  });
});
