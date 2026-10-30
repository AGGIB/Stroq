import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { routeMcpContainment } from './mcp-containment-http.mjs';
const origin = 'http://127.0.0.1:12345';
function request(body, headers = {}, method = 'POST') {
  const req = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  req.method = method;
  req.headers = { origin, 'content-type': 'application/json', ...headers };
  return req;
}
test('MCP routes reject duplicate decoded keys and nested private input before service calls', async () => {
  let calls = 0;
  const service = {
    preview: async () => {
      calls++;
      return { status: 200, body: {} };
    },
  };
  for (const raw of [
    '{"action":"remove-registration","action":"restore-registration"}',
    '{"action":"remove-registration","\\u0061ction":"restore-registration"}',
    '{"env":{"TOKEN":"private"}}',
    '{"id":["item-x"]}',
    Buffer.from([0xff]),
  ]) {
    const result = await routeMcpContainment(
      request(raw),
      '/api/mcp-containment/preview',
      origin,
      service,
    );
    assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
});
test('MCP actions require exact Origin, bounded UTF8 JSON and POST', async () => {
  let calls = 0;
  const service = {
    apply: async () => {
      calls++;
      return { status: 200, body: {} };
    },
  };
  for (const [headers, body, method, status] of [
    [{ origin: 'https://foreign.invalid' }, '{}', 'POST', 403],
    [{ origin: undefined }, '{}', 'POST', 403],
    [{ 'content-type': 'text/plain' }, '{}', 'POST', 415],
    [{ 'content-encoding': 'gzip' }, '{}', 'POST', 415],
    [{}, 'x'.repeat(4097), 'POST', 413],
    [{}, '{}', 'GET', 405],
  ])
    assert.equal(
      (
        await routeMcpContainment(
          request(body, headers, method),
          '/api/mcp-containment/apply',
          origin,
          service,
        )
      ).status,
      status,
    );
  assert.equal(calls, 0);
});
test('MCP reads and explicit actions dispatch exactly once without inventing mutations', async () => {
  const seen = [];
  const service = Object.fromEntries(
    ['state', 'preview', 'apply'].map((name) => [
      name,
      async (input) => {
        seen.push({ name, input });
        return { status: 200, body: { name } };
      },
    ]),
  );
  assert.equal(
    (await routeMcpContainment(request('', {}, 'GET'), '/api/mcp-containment', origin, service))
      .status,
    200,
  );
  const raw =
    '{"previewId":"11111111-1111-4111-8111-111111111111","confirm":true,"acknowledgeSessionLimits":true,"acknowledgePrivateRetention":true}';
  assert.equal(
    (await routeMcpContainment(request(raw), '/api/mcp-containment/apply', origin, service)).status,
    200,
  );
  assert.deepEqual(seen, [
    { name: 'state', input: undefined },
    { name: 'apply', input: JSON.parse(raw) },
  ]);
  assert.equal(
    (await routeMcpContainment(request('{}'), '/api/mcp-containment/unknown', origin, service))
      .status,
    404,
  );
});
