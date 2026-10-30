import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-http-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { http: join(import.meta.dirname, 'workspace-task-http.ts') },
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
const { routeWorkspaceTasks } = await import(pathToFileURL(join(output, 'http.mjs')).href);
const origin = 'http://127.0.0.1:47815',
  base = '/api/workspace-task-controls';
function request(url, { method = 'POST', body = '{}', headers = {} } = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    url,
    method,
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
}
test('all fixed task routes delegate only their bounded JSON input to the selected operation', async () => {
  const calls = [],
    service = { getState: async () => ({ status: 200, body: { state: true } }) };
  for (const name of ['preview', 'apply', 'restorePreview', 'restore', 'recheck'])
    service[name] = async (value) => {
      calls.push([name, value]);
      return { status: 200, body: {} };
    };
  assert.equal(
    (await routeWorkspaceTasks(request(base, { method: 'GET', body: '' }), base, origin, service))
      .status,
    200,
  );
  for (const [suffix, name] of [
    ['preview', 'preview'],
    ['apply', 'apply'],
    ['restore-preview', 'restorePreview'],
    ['restore', 'restore'],
    ['recheck', 'recheck'],
  ]) {
    assert.equal(
      (
        await routeWorkspaceTasks(
          request(`${base}/${suffix}`, { body: '{"opaque":"value"}' }),
          `${base}/${suffix}`,
          origin,
          service,
        )
      ).status,
      200,
    );
    assert.deepEqual(calls.at(-1), [name, { opaque: 'value' }]);
  }
});
test('queries, wrong methods/origins, duplicate keys and oversized bodies refuse before delegation', async () => {
  let calls = 0;
  const action = async () => {
    calls++;
    return { status: 200, body: {} };
  };
  const service = {
    getState: action,
    preview: action,
    apply: action,
    restorePreview: action,
    restore: action,
    recheck: action,
  };
  const path = `${base}/apply`;
  for (const [req, status] of [
    [request(`${path}?x=1`), 400],
    [request(path, { method: 'GET' }), 405],
    [request(path, { headers: { origin: 'https://foreign.invalid' } }), 403],
    [request(path, { body: '{"previewId":"a","preview\\u0049d":"b"}' }), 400],
    [request(path, { body: ' '.repeat(4097) }), 413],
    [request(path, { headers: { 'content-type': 'text/plain' } }), 415],
  ])
    assert.equal((await routeWorkspaceTasks(req, path, origin, service)).status, status);
  assert.equal(
    (
      await routeWorkspaceTasks(
        request(base, { method: 'GET', headers: { 'content-length': '1' } }),
        base,
        origin,
        service,
      )
    ).status,
    400,
  );
  assert.equal(
    (await routeWorkspaceTasks(request(`${base}/unknown`), `${base}/unknown`, origin, service))
      .status,
    404,
  );
  assert.equal(calls, 0);
});
