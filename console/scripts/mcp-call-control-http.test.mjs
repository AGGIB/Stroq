import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { routeMcpCallControls } from './mcp-containment-http.mjs';
import { createMcpCallControlService } from './mcp-tool-contracts.mjs';
import { startServer } from './serve.mjs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
const origin = 'http://127.0.0.1:47815';
function request(path, method = 'POST', body = '{}', headers = {}) {
  const req = new PassThrough();
  req.url = path;
  req.method = method;
  req.headers = { origin, 'content-type': 'application/json', ...headers };
  if (method === 'POST') queueMicrotask(() => req.end(body));
  return req;
}
test('call-control router allows only fixed bodyless GET and four bounded strict JSON actions', async () => {
  const calls = [],
    service = Object.fromEntries(
      ['state', 'inspect', 'preview', 'apply', 'recheck'].map((name) => [
        name,
        async (input) => {
          calls.push({ name, input });
          return { status: 200, body: { ok: true } };
        },
      ]),
    );
  const base = '/api/mcp-call-controls';
  assert.equal(
    (await routeMcpCallControls(request(base, 'GET'), base, origin, service)).status,
    200,
  );
  for (const action of ['inspect', 'preview', 'apply', 'recheck']) {
    const path = base + '/' + action;
    assert.equal(
      (
        await routeMcpCallControls(
          request(path, 'POST', '{"id":"opaque","expectedEventId":null}'),
          path,
          origin,
          service,
        )
      ).status,
      200,
    );
    assert.equal(calls.at(-1).name, action);
  }
  const before = calls.length;
  for (const [path, method, body, headers, status] of [
    [base, 'POST', '{}', {}, 405],
    [base, 'GET', '', { 'content-length': '1' }, 400],
    [base, 'GET', '', { 'transfer-encoding': 'chunked' }, 400],
    [base + '?private=x', 'GET', '', {}, 400],
    [base + '/inspect#x', 'POST', '{}', {}, 400],
    [base + '/inspect', 'GET', '', {}, 405],
    [base + '/inspect', 'POST', '{}', { origin: 'https://foreign.invalid' }, 403],
    [base + '/inspect', 'POST', '{}', { 'content-type': 'text/plain' }, 415],
    [base + '/inspect', 'POST', 'x'.repeat(4097), {}, 413],
    [base + '/inspect', 'POST', '{"id":"a","i\\u0064":"b"}', {}, 400],
    [base + '/inspect', 'POST', '{"nested":{}}', {}, 400],
    [base + '/run', 'POST', '{}', {}, 404],
    [base + '/inspect/extra', 'POST', '{}', {}, 404],
  ]) {
    assert.equal(
      (
        await routeMcpCallControls(
          request(path, method, body, headers),
          path.split(/[?#]/)[0],
          origin,
          service,
        )
      ).status,
      status,
      path,
    );
  }
  assert.equal(calls.length, before);
});
test('missing packaged call-control runtime refuses passive reads and actions finitely', async () => {
  for (const loadEngine of [
    async () => {
      throw new Error('private-path');
    },
    async () => ({}),
  ]) {
    const service = await createMcpCallControlService({ loadEngine });
    for (const method of ['state', 'inspect', 'preview', 'apply', 'recheck']) {
      assert.deepEqual(await service[method]({}), {
        status: 503,
        body: { error: 'mcp-call-control-unavailable' },
      });
    }
    await service.close();
  }
});
test('actual authenticated server wires call-control actions, exact origin, bearer and close lifecycle', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-http-')));
  await mkdir(join(dir, 'out'));
  await mkdir(join(dir, 'home'), { mode: 0o700 });
  await writeFile(join(dir, 'out', 'index.html'), 'fixture');
  let closed = false;
  const calls = [];
  const service = Object.fromEntries(
    ['state', 'inspect', 'preview', 'apply', 'recheck'].map((name) => [
      name,
      async (body) => {
        calls.push(name);
        return { status: 200, body: { action: name, input: body ?? null } };
      },
    ]),
  );
  service.close = async () => {
    closed = true;
  };
  const app = await startServer({
    root: join(dir, 'out'),
    home: join(dir, 'home'),
    userHome: join(dir, 'home'),
    project: dir,
    port: 0,
    mcpCallControls: service,
  });
  t.after(async () => {
    await app.close();
    assert.equal(closed, true);
    await rm(dir, { recursive: true, force: true });
  });
  const read = (path, method = 'GET', body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: app.server.address().port, path, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (v) => chunks.push(v));
          res.on('end', () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const auth = { authorization: `Bearer ${app.token}` },
    headers = { ...auth, origin: app.url.split('/#')[0], 'content-type': 'application/json' },
    base = '/api/mcp-call-controls';
  assert.equal((await read(base)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await read(base, 'GET', undefined, auth)).status, 200);
  assert.equal((await read(base + '/inspect', 'POST', '{}', auth)).status, 403);
  assert.equal(
    (await read(base + '/inspect', 'POST', '{}', { ...headers, origin: 'https://foreign.invalid' }))
      .status,
    403,
  );
  for (const action of ['inspect', 'preview', 'apply', 'recheck'])
    assert.equal((await read(base + '/' + action, 'POST', '{}', headers)).status, 200);
  assert.deepEqual(calls, ['state', 'inspect', 'preview', 'apply', 'recheck']);
});
