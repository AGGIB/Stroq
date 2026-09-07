import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING,
  PendingTable,
  SCANNED_METHODS,
  asJsonRpcId,
  classifyMessage,
  createLineSplitter,
  hasProtocolMeta,
  isScannedMethod,
  jsonrpcOf,
  paramsOf,
  parseLine,
} from '../../src/mcp/framing.js';

const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text);

describe('the line splitter, which must never lose or invent a byte', () => {
  it('reassembles a message split across chunks', () => {
    // stdio framing is one message per line, but a pipe delivers whatever it likes:
    // a 200-byte JSON-RPC message routinely arrives as three chunks.
    const split = createLineSplitter();
    expect(split.push('{"jsonrpc"')).toEqual([]);
    expect(split.push(':"2.0","id"')).toEqual([]);
    expect(texts(split.push(':1}\n'))).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it('emits several lines from one chunk, in order', () => {
    const split = createLineSplitter();
    expect(texts(split.push('a\nb\nc'))).toEqual(['a', 'b']);
    expect(texts(split.flush())).toEqual(['c']);
  });

  it('keeps a carriage return and a blank line, because forwarding is byte-exact', () => {
    // A CRLF client leaves the `\r` inside the line text; re-adding only the `\n`
    // preserves it. A blank line between two messages is forwarded as a blank line.
    const split = createLineSplitter();
    expect(texts(split.push('{"a":1}\r\n\n{"b":2}\n'))).toEqual(['{"a":1}\r', '', '{"b":2}']);
  });

  it('marks a terminated line and an unterminated remainder differently', () => {
    // The remainder has no terminator of its own, so forwarding must not add one.
    const split = createLineSplitter();
    expect(split.push('one\ntwo')).toEqual([{ text: 'one', eol: '\n', oversize: false }]);
    expect(split.flush()).toEqual([{ text: 'two', eol: '', oversize: false }]);
    expect(split.flush()).toEqual([]);
  });

  it('flags a line past the parse bound and leaves its neighbours alone', () => {
    // The flag is a property of the line's OWN length: a small line that happens to
    // share a chunk with a huge one must not inherit the flag.
    const split = createLineSplitter();
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
    const lines = split.push(`small\n${huge}\ntail\n`);
    expect(lines.map((l) => l.oversize)).toEqual([false, true, false]);
  });
});

describe('parseLine', () => {
  it('reports a line that is not JSON rather than throwing', () => {
    expect(parseLine('not json {{{')).toBeUndefined();
    expect(parseLine('')).toBeUndefined();
    expect(parseLine('{"a":1}')).toEqual({ a: 1 });
    // A `\r` left by a CRLF client is whitespace to JSON.parse.
    expect(parseLine('{"a":1}\r')).toEqual({ a: 1 });
  });
});

describe('classifyMessage', () => {
  it('tells a request from a notification by its id', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toMatchObject({
      kind: 'request',
      id: 1,
      method: 'tools/call',
    });
    expect(classifyMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({
      kind: 'notification',
      method: 'notifications/initialized',
    });
  });

  it('treats an unusable id as no id at all', () => {
    // JSON-RPC forbids a null id, and an empty string cannot address a response.
    expect(classifyMessage({ id: null, method: 'ping' }).kind).toBe('notification');
    expect(classifyMessage({ id: '', method: 'ping' }).kind).toBe('notification');
    expect(classifyMessage({ id: {}, method: 'ping' }).kind).toBe('notification');
  });

  it('recognises both response shapes and nothing else', () => {
    expect(classifyMessage({ id: 'a', result: {} })).toMatchObject({ kind: 'response', id: 'a' });
    expect(classifyMessage({ id: 2, error: { code: -1 } })).toMatchObject({
      kind: 'response',
      id: 2,
    });
    // A null result is still a result: `hasOwn`, not truthiness.
    expect(classifyMessage({ id: 3, result: null }).kind).toBe('response');
    expect(classifyMessage({ id: 4 }).kind).toBe('other');
    expect(classifyMessage('a string').kind).toBe('other');
    expect(classifyMessage(null).kind).toBe('other');
  });

  it('reports a batch array with its items', () => {
    const message = classifyMessage([{ id: 1, method: 'tools/call' }, 7]);
    expect(message.kind).toBe('batch');
    expect(message.kind === 'batch' ? message.items : []).toHaveLength(2);
  });
});

describe('the small readers every direction shares', () => {
  it('reads a usable id and rejects the rest', () => {
    expect(asJsonRpcId('abc')).toBe('abc');
    expect(asJsonRpcId(0)).toBe(0);
    expect(asJsonRpcId('')).toBeNull();
    expect(asJsonRpcId(null)).toBeNull();
    expect(asJsonRpcId(Number.NaN)).toBeNull();
  });

  it('reads params as a record whatever arrived', () => {
    expect(paramsOf({ params: { name: 'x' } })).toEqual({ name: 'x' });
    expect(paramsOf({ params: 'nope' })).toEqual({});
    expect(paramsOf({})).toEqual({});
  });

  it('echoes the sender jsonrpc version, defaulting to 2.0', () => {
    expect(jsonrpcOf({ jsonrpc: '2.0' })).toBe('2.0');
    expect(jsonrpcOf({ jsonrpc: 7 })).toBe('2.0');
    expect(jsonrpcOf({})).toBe('2.0');
  });

  it('sees the 2026-07-28 protocol version in either place it can ride', () => {
    // Modern requests carry it in `params._meta`; some drafts put `_meta` at the top
    // level. `resultType` is written on a reply only when the request declared one.
    const key = 'io.modelcontextprotocol/protocolVersion';
    expect(hasProtocolMeta({ params: { _meta: { [key]: '2026-07-28' } } })).toBe(true);
    expect(hasProtocolMeta({ _meta: { [key]: '2026-07-28' } })).toBe(true);
    expect(hasProtocolMeta({ params: { _meta: { other: 1 } } })).toBe(false);
    expect(hasProtocolMeta({ params: { name: 'x' } })).toBe(false);
    expect(hasProtocolMeta({})).toBe(false);
  });

  it('knows exactly which four methods produce a result worth scanning', () => {
    expect([...SCANNED_METHODS]).toEqual([
      'tools/call',
      'tools/list',
      'resources/read',
      'prompts/get',
    ]);
    expect(isScannedMethod('resources/read')).toBe(true);
    expect(isScannedMethod('resources/list')).toBe(false);
  });
});

describe('the pending table', () => {
  it('remembers a request and forgets it once its response arrives', () => {
    const table = new PendingTable();
    table.set(1, { method: 'tools/call', toolName: 'mcp__github__send' });
    expect(table.size).toBe(1);
    expect(table.take(1)).toEqual({ method: 'tools/call', toolName: 'mcp__github__send' });
    // Taken once: a second response to the same id is a stranger and is forwarded.
    expect(table.take(1)).toBeUndefined();
    expect(table.size).toBe(0);
  });

  it('keeps string and number ids in separate namespaces', () => {
    // JSON-RPC allows both; a server answering `"1"` must not consume the entry for `1`.
    const table = new PendingTable();
    table.set(1, { method: 'tools/list', toolName: 'mcp__a__tools_list' });
    expect(table.take('1')).toBeUndefined();
    expect(table.take(1)?.method).toBe('tools/list');
  });

  it('drops an entry a cancellation names', () => {
    const table = new PendingTable();
    table.set('c1', { method: 'tools/call', toolName: 'mcp__a__b' });
    table.cancel('c1');
    expect(table.take('c1')).toBeUndefined();
    // Cancelling an id that was never pending is a no-op, not a throw.
    expect(() => table.cancel('never')).not.toThrow();
  });

  it('evicts the oldest entry rather than growing without a bound', () => {
    // A server that never answers would otherwise let a client grow this table
    // forever; the bound is what makes the proxy safe to leave running for days.
    const table = new PendingTable();
    for (let i = 0; i < MAX_PENDING + 2; i += 1)
      table.set(i, { method: 'tools/call', toolName: `mcp__a__t${i}` });
    expect(table.size).toBe(MAX_PENDING);
    expect(table.take(0)).toBeUndefined();
    expect(table.take(1)).toBeUndefined();
    expect(table.take(2)?.toolName).toBe('mcp__a__t2');
  });
});
