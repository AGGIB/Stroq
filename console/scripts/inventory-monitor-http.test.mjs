import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-monitor-http-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { http: join(repository, 'console/scripts/inventory-monitor-http.ts') },
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
const { routeInventoryMonitor } = await import(pathToFileURL(join(output, 'http.mjs')).href);
const origin = 'http://127.0.0.1:47815';
function request(url, { method = 'POST', body = '{}', headers = {} } = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  Object.assign(stream, {
    url,
    method,
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
  return stream;
}
test('fixed state and action routes delegate without selecting paths from input', async () => {
  const calls = [],
    service = {
      state: async () => ({ status: 200, body: { state: true } }),
      preview: async (value) => {
        calls.push(value);
        return { status: 200, body: {} };
      },
      apply: async (value) => {
        calls.push(value);
        return { status: 200, body: {} };
      },
    };
  assert.equal(
    (
      await routeInventoryMonitor(
        request('/api/inventory-monitor', { method: 'GET', body: '' }),
        '/api/inventory-monitor',
        origin,
        service,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await routeInventoryMonitor(
        request('/api/inventory-monitor/preview', {
          body: '{"action":"enable","expectedRevision":null}',
        }),
        '/api/inventory-monitor/preview',
        origin,
        service,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [{ action: 'enable', expectedRevision: null }]);
});
test('query, method, origins, body bounds and duplicate decoded keys refuse before delegation', async () => {
  let calls = 0;
  const service = {
    state: async () => {
      calls++;
    },
    preview: async () => {
      calls++;
    },
    apply: async () => {
      calls++;
    },
  };
  for (const [url, path, options, status] of [
    ['/api/inventory-monitor?enable=true', '/api/inventory-monitor', { method: 'GET' }, 400],
    [
      '/api/inventory-monitor',
      '/api/inventory-monitor',
      { method: 'GET', headers: { 'content-length': '2' } },
      400,
    ],
    ['/api/inventory-monitor/preview', '/api/inventory-monitor/preview', { method: 'GET' }, 405],
    [
      '/api/inventory-monitor/apply',
      '/api/inventory-monitor/apply',
      { headers: { origin: 'https://foreign.invalid' } },
      403,
    ],
    [
      '/api/inventory-monitor/apply',
      '/api/inventory-monitor/apply',
      { body: '{"confirm":true,"\\u0063onfirm":false}' },
      400,
    ],
    [
      '/api/inventory-monitor/preview',
      '/api/inventory-monitor/preview',
      { body: 'x'.repeat(4097) },
      413,
    ],
    ['/api/inventory-monitor/other', '/api/inventory-monitor/other', {}, 404],
  ])
    assert.equal(
      (await routeInventoryMonitor(request(url, options), path, origin, service)).status,
      status,
    );
  assert.equal(calls, 0);
});
