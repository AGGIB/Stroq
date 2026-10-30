import { describe, expect, it } from 'vitest';
import { call, list, result, rig, type ApprovalRig } from './tool-approval-rig.js';

/**
 * What ends a connection's approved tool contract, and what does not. Ordinary protocol events
 * (a cancelled call, a log line from the server) and ordinary JSON (big numbers, keys named after the
 * object model, deep or large arguments) are handled for the one message they arrive in. Only a
 * changed contract, evidence of tampering, or a server state the proxy cannot follow ends the
 * session's authority, and each of those is named in the last table here.
 */

const answer = (id: number, text = 'ok', extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  result: { content: [{ type: 'text', text }], ...extra },
});
const sent = (r: ApprovalRig, id: unknown): boolean =>
  r.server.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message['id'] === id && message['method'] === 'tools/call';
  });
const replyTo = (r: ApprovalRig, id: unknown): Record<string, unknown> | undefined =>
  r
    .parsed()
    .flatMap((message) => (Array.isArray(message) ? message : [message]))
    .find((message) => message['id'] === id);
const errorText = (r: ApprovalRig, id: unknown): string =>
  String((replyTo(r, id)?.['error'] as Record<string, unknown> | undefined)?.['message']);
const invalidations = (r: ApprovalRig): number => r.store.invalidate.mock.calls.length;
const settled = () => new Promise<void>((done) => setImmediate(done));
const rawCall = (id: number, argument: string) =>
  `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"lookup","arguments":{"v":${argument}}}}`;

/** A connection whose complete listing is approved and whose first call went through. */
async function approved(): Promise<ApprovalRig> {
  const r = rig();
  r.approve();
  await r.clientLine(list(1));
  await r.serverLine(result(1));
  await r.clientLine(call(2));
  expect(sent(r, 2)).toBe(true);
  await r.serverLine(answer(2));
  await settled();
  return r;
}

/** The next call still goes out, and nothing was invalidated on the way. */
async function stillApproved(r: ApprovalRig, before: number, id: number): Promise<void> {
  await r.clientLine(call(id));
  expect(sent(r, id)).toBe(true);
  await settled();
  expect(invalidations(r)).toBe(before);
}

describe('ordinary client events change nothing but the message they arrive in', () => {
  it('a cancelled call is bookkeeping for its id, and its late answer is dropped quietly', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    expect(sent(r, 3)).toBe(true);
    await r.clientLine({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 3, reason: 'user stopped it' },
    });
    expect(r.server.at(-1)).toContain('notifications/cancelled');
    await stillApproved(r, before, 4);
    await r.serverLine(answer(3, 'late'));
    await r.serverLine(answer(4, 'four'));
    expect(r.client.join('')).not.toContain('late');
    expect(replyTo(r, 3)).toBeUndefined();
    expect(replyTo(r, 4)?.['result']).toBeDefined();
    await stillApproved(r, before, 5);
  });

  it('a request that reuses a waiting or cancelled id is refused alone', async () => {
    const r = await approved();
    const before = invalidations(r);
    const calls3 = () => r.server.filter((raw) => sent({ ...r, server: [raw] }, 3));
    await r.clientLine(call(3));
    await r.clientLine(call(3));
    expect(calls3()).toHaveLength(1);
    expect(errorText(r, 3)).toContain('cannot be paired with exactly one answer');
    await r.clientLine({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 3 },
    });
    await r.clientLine(call(3));
    expect(calls3()).toHaveLength(1);
    expect(r.parsed().filter((message) => message['id'] === 3)).toHaveLength(2);
    await stillApproved(r, before, 4);
  });

  it.each([
    ['an integer beyond 2^53', '12345678901234567890'],
    ['a fraction with more digits than a double holds', '0.10000000000000000000001'],
    ['a number past the range of a double', '1e400'],
    ['a negative zero', '-0'],
  ])('%s in an argument refuses that call alone, with the reason', async (_, number) => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(rawCall(3, number));
    expect(sent(r, 3)).toBe(false);
    expect(errorText(r, 3)).toContain('cannot be represented exactly');
    expect(errorText(r, 3)).not.toContain('not approved');
    await stillApproved(r, before, 4);
  });

  it('keys named after the object model are data and go through byte for byte', async () => {
    const r = await approved();
    const before = invalidations(r);
    const raw =
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup","arguments":' +
      '{"constructor":{"prototype":{"x":1}},"__proto__":{"polluted":true},"toString":"t",' +
      '"hasOwnProperty":1,"valueOf":null}}}';
    await r.clientLine(raw);
    expect(r.server).toContain(`${raw}\n`);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    await stillApproved(r, before, 4);
  });

  it.each([
    ['a replacement character', '"\uFFFD"'],
    ['a lone surrogate escape', '"\\ud800"'],
    ['number-like keys out of numeric order', '{"b":1,"10":2,"2":3}'],
    ['a key with a control character', '{"a\\u0001b":1}'],
    ['nesting deeper than a tool contract may be', `${'{"a":'.repeat(40)}1${'}'.repeat(40)}`],
    ['more values than a tool contract may hold', `[${'0,'.repeat(25_000)}0]`],
    ['an argument over one megabyte', JSON.stringify('x'.repeat(1_200_000))],
  ])('%s in an argument is forwarded byte for byte', async (_, value) => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(rawCall(3, value));
    expect(r.server).toContain(`${rawCall(3, value)}\n`);
    await stillApproved(r, before, 4);
  });

  it.each([
    [
      'a key repeated in one object',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup","name":"lookup","arguments":{}}}',
      'repeats a key',
    ],
    [
      'a batch',
      '[{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup","arguments":{}}}]',
      'single JSON-RPC 2.0',
    ],
    [
      'a member JSON-RPC does not define',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lookup","arguments":{}},"x":1}',
      'single JSON-RPC 2.0',
    ],
    ['a line that is not JSON', '{"jsonrpc":"2.0","id":3,"method":"tools/call"', null],
  ])('%s refuses that message alone', async (_, raw, reason) => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(raw);
    expect(sent(r, 3)).toBe(false);
    if (reason === null) expect(replyTo(r, 3)).toBeUndefined();
    else expect(errorText(r, 3)).toContain(reason);
    await stillApproved(r, before, 4);
  });

  it('a tool named after the object model is a name like any other', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: ['constructor', 'toString', '__proto__'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
        })),
      },
    });
    for (const [id, name] of [
      [2, 'constructor'],
      [3, '__proto__'],
    ] as const) {
      await r.clientLine(call(id, name));
      expect(sent(r, id)).toBe(true);
    }
    await r.clientLine(call(4, 'hasOwnProperty'));
    expect(sent(r, 4)).toBe(false);
  });
});

describe('ordinary server events change nothing but the message they arrive in', () => {
  it('a log line, a worded progress note or a sampling request leaves waiting calls and approval alone', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'hello' },
    });
    await r.serverLine({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 1, progress: 1, message: 'half way' },
    });
    await r.serverLine({ jsonrpc: '2.0', id: 's1', method: 'sampling/createMessage', params: {} });
    await r.serverLine(answer(3, 'three'));
    expect(replyTo(r, 3)?.['result']).toBeDefined();
    expect(r.client.join('')).not.toContain('hello');
    await stillApproved(r, before, 4);
  });

  it('a result with a number that cannot be represented exactly is withheld for that call, never rounded', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine(
      '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}],' +
        '"structuredContent":{"n":12345678901234567890}}}',
    );
    expect(replyTo(r, 3)?.['error']).toBeDefined();
    expect(r.client.join('')).not.toContain('1234567890123456');
    await stillApproved(r, before, 4);
  });

  it('a progress note with a number that cannot be represented exactly is withheld, never rounded', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine(
      '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t",' +
        '"progress":12345678901234567890,"total":0.1234567890123456789}}',
    );
    expect(r.client.join('')).not.toContain('notifications/progress');
    await r.serverLine(answer(3, 'three'));
    expect(replyTo(r, 3)?.['result']).toBeDefined();
    await stillApproved(r, before, 4);
  });

  it('a server request with a number that cannot be represented exactly is refused to the server alone', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine(
      '{"jsonrpc":"2.0","id":"s9","method":"sampling/createMessage","params":{"n":12345678901234567890}}',
    );
    expect(r.client.join('')).not.toContain('sampling/createMessage');
    expect(r.server.join('')).toContain('"s9"');
    await r.serverLine(answer(3, 'three'));
    expect(replyTo(r, 3)?.['result']).toBeDefined();
    await stillApproved(r, before, 4);
  });

  it('a result with keys named after the object model is delivered as data', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine(
      '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}],' +
        '"structuredContent":{"constructor":"c","__proto__":{"p":1},"toString":"t"}}}',
    );
    const delivered = replyTo(r, 3)?.['result'] as Record<string, unknown> | undefined;
    expect(Object.keys(delivered?.['structuredContent'] as object)).toEqual([
      'constructor',
      '__proto__',
      'toString',
    ]);
    await stillApproved(r, before, 4);
  });

  it('a result strict mode cannot read is withheld for that call alone', async () => {
    const r = await approved();
    const before = invalidations(r);
    await r.clientLine(call(3));
    await r.serverLine(answer(3, 'ok', { somethingNew: true }));
    expect(replyTo(r, 3)?.['error']).toBeDefined();
    await stillApproved(r, before, 4);
  });
});

/**
 * Every case that still ends the session's authority: the contract changed, the proxy can no longer
 * tell what the server said (a line it cannot read could be a hidden `list_changed`), or one side
 * forged or replayed what the other is owed. A new complete listing is the only way back.
 */
const REVOKES: readonly (readonly [string, (r: ApprovalRig) => Promise<void>])[] = [
  [
    'the server says its tools changed',
    (r) => r.serverLine({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
  ],
  ['a server line that is not JSON', (r) => r.serverLine('not json')],
  [
    'a server line larger than the proxy reads',
    (r) => r.serverSplit({ text: '{"jsonrpc":"2.0"', eol: '\n', oversize: true }),
  ],
  [
    'a server line that repeats a key',
    (r) =>
      r.serverLine('{"jsonrpc":"2.0","method":"notifications/message","params":{},"params":{}}'),
  ],
  ['a server batch', (r) => r.serverLine([{ jsonrpc: '2.0', method: 'ping' }])],
  ['an answer to a request nobody sent', (r) => r.serverLine(answer(99))],
  [
    'a second answer to one request',
    async (r) => {
      await r.clientLine(call(3));
      await r.serverLine(answer(3));
      await r.serverLine(answer(3));
    },
  ],
  [
    'an answer whose error is not an error object',
    async (r) => {
      await r.clientLine(call(3));
      await r.serverLine({ jsonrpc: '2.0', id: 3, error: 'not an error object' });
    },
  ],
  [
    'an answer with a member JSON-RPC does not define',
    async (r) => {
      await r.clientLine(call(3));
      await r.serverLine({ ...answer(3), extra: 1 });
    },
  ],
  [
    "a client request under the proxy's private id prefix",
    (r) => r.clientLine({ jsonrpc: '2.0', id: 'stroq-tools:forged', method: 'ping' }),
  ],
  [
    "a server request under the proxy's private id prefix",
    (r) => r.serverLine({ jsonrpc: '2.0', id: 'stroq-tools:forged', method: 'ping' }),
  ],
];

describe('what still revokes the session', () => {
  it.each(REVOKES)('%s', async (_, event) => {
    const r = await approved();
    const before = invalidations(r);
    await event(r);
    await r.clientLine(call(10));
    expect(sent(r, 10)).toBe(false);
    await settled();
    expect(invalidations(r)).toBeGreaterThan(before);
  });
});
