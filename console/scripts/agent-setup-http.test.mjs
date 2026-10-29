import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { routeAgentSetup } from './agent-setup-http.mjs';

test('setup routes require exact Origin, JSON, bounded UTF-8 and the explicit apply shape', async () => {
  const origin = 'http://127.0.0.1:47815';
  const calls = [];
  const setup = {
    getState: () => ({ available: true }),
    preview: async (body) => {
      calls.push(body);
      return { status: 200, body };
    },
    apply: async (body) => {
      calls.push(body);
      return { status: 200, body };
    },
  };
  const request = (path, body, headers = {}, method = 'POST') => {
    const req = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
    req.method = method;
    req.headers = { 'content-type': 'application/json', origin, ...headers };
    return routeAgentSetup(req, path, origin, setup);
  };
  assert.equal((await request('/api/agent-setup', '', {}, 'GET')).status, 200);
  assert.equal((await request('/api/agent-setup/apply', '', {}, 'GET')).status, 405);
  assert.equal(
    (await request('/api/agent-setup/apply', '{}', { origin: 'https://elsewhere.example' })).status,
    403,
  );
  assert.equal(
    (await request('/api/agent-setup/apply', '{}', { 'content-type': 'text/plain' })).status,
    415,
  );
  assert.equal(
    (await request('/api/agent-setup/apply', '{}', { 'content-encoding': 'gzip' })).status,
    415,
  );
  assert.equal((await request('/api/agent-setup/apply', 'x'.repeat(4097))).status, 413);
  assert.equal((await request('/api/agent-setup/apply', Buffer.from([0xff]))).status, 400);
  assert.equal(calls.length, 0);
  const input = {
    previewId: '11111111-2222-4333-8444-555555555555',
    confirm: true,
    acknowledgeRetainedCopy: true,
    acknowledgeSharedScope: true,
  };
  assert.equal((await request('/api/agent-setup/apply', JSON.stringify(input))).status, 200);
  assert.deepEqual(calls, [input]);
});
