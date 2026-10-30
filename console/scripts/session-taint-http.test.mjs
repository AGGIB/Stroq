import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
const output = await mkdtemp(join(tmpdir(), 'stroq-taint-http-build-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { http: join(import.meta.dirname, 'session-taint-http.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const { routeSessionTaint } = await import(pathToFileURL(join(output, 'http.mjs')).href);
const base = '/api/session-taint',
  origin = 'http://127.0.0.1:1234';
function request(url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.url = url;
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { origin, 'content-type': 'application/json', ...headers };
  return req;
}
test('fixed routes enforce methods, exact Origin, bounded strict JSON and reject selectors in URLs', async () => {
  const calls = [];
  const service = Object.fromEntries(
    ['getState', 'inspect', 'preview', 'clear', 'recheck'].map((method) => [
      method,
      async (input) => {
        calls.push({ method, input });
        return { status: 200, body: { method } };
      },
    ]),
  );
  const route = (req, path = base) => routeSessionTaint(req, path, origin, service);
  assert.equal((await route(request(base))).status, 200);
  assert.equal((await route(request(base, '{}'))).status, 405);
  assert.equal((await route(request(base + '?session=private'))).status, 400);
  assert.equal((await route(request(base, undefined, { 'content-length': '1' }))).status, 400);
  for (const method of ['inspect', 'preview', 'clear', 'recheck']) {
    const path = base + '/' + method;
    assert.equal((await route(request(path), path)).status, 405);
    assert.equal(
      (await route(request(path, '{}', { origin: 'http://foreign.invalid' }), path)).status,
      403,
    );
    for (const malformed of ['{"id":1,"id":2}', '{"__proto__":{}}', '{"id":"\\ud800"}'])
      assert.equal((await route(request(path, malformed), path)).status, 400);
    assert.equal((await route(request(path, 'x'.repeat(4097)), path)).status, 413);
    assert.equal((await route(request(path, '{}'), path)).status, 200);
  }
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getState', 'inspect', 'preview', 'clear', 'recheck'],
  );
  assert.equal((await route(request(base + '/all', '{}'), base + '/all')).status, 404);
});
