import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { routeCredentialFilters } from './credential-filter-http.mjs';
const origin = 'http://127.0.0.1:47815';
const request = (body, headers = {}) =>
  Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
test('credential routes expose only fixed read/preview/apply methods', async () => {
  const calls = [];
  const service = Object.fromEntries(
    ['state', 'preview', 'apply'].map((name) => [
      name,
      async (input) => {
        calls.push({ name, input });
        return { status: 200, body: { name } };
      },
    ]),
  );
  assert.equal(
    (await routeCredentialFilters({ method: 'GET' }, '/api/credential-filters', origin, service))
      .status,
    200,
  );
  for (const action of ['preview', 'apply'])
    assert.equal(
      (
        await routeCredentialFilters(
          request('{"target":"cursor-project"}'),
          '/api/credential-filters/' + action,
          origin,
          service,
        )
      ).status,
      200,
    );
  assert.deepEqual(calls, [
    { name: 'state', input: undefined },
    { name: 'preview', input: { target: 'cursor-project' } },
    { name: 'apply', input: { target: 'cursor-project' } },
  ]);
  assert.equal(
    (await routeCredentialFilters({ method: 'POST' }, '/api/credential-filters', origin, service))
      .status,
    405,
  );
  assert.equal(
    (await routeCredentialFilters(request('{}'), '/api/credential-filters/run', origin, service))
      .status,
    404,
  );
});
test('credential action routes reject duplicate decoded keys, nesting and numeric values before dispatch', async () => {
  const service = {
    preview: async () => {
      throw new Error('must not dispatch');
    },
  };
  for (const body of [
    '{"target":"cursor-project","target":"claude-user"}',
    '{"target":"cursor-project","t\\u0061rget":"claude-user"}',
    '{"action":{"command":"arbitrary"}}',
    '{"confirm":1}',
    '[]',
  ])
    assert.equal(
      (
        await routeCredentialFilters(
          request(body),
          '/api/credential-filters/preview',
          origin,
          service,
        )
      ).status,
      400,
    );
});
test('credential actions retain same-origin, UTF-8 and 4096-byte request limits', async () => {
  const service = {
    apply: async () => {
      throw new Error('must not dispatch');
    },
  };
  const path = '/api/credential-filters/apply';
  assert.equal(
    (
      await routeCredentialFilters(
        request('{}', { origin: 'https://foreign.invalid' }),
        path,
        origin,
        service,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await routeCredentialFilters(
        request('{}', { 'content-type': 'text/plain' }),
        path,
        origin,
        service,
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await routeCredentialFilters(
        request(JSON.stringify({ previewId: 'x'.repeat(4100) })),
        path,
        origin,
        service,
      )
    ).status,
    413,
  );
});
