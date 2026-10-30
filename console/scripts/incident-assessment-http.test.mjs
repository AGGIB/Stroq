import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
const output = await mkdtemp(join(tmpdir(), 'stroq-assessment-http-'));
test.after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { http: join(import.meta.dirname, 'incident-assessment-http.ts') },
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
const { routeIncidentAssessments } = await import(pathToFileURL(join(output, 'http.mjs')).href);
const base = '/api/incident-assessments',
  origin = 'http://127.0.0.1:1234';
function request(url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(req, {
    url,
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
  return req;
}
test('fixed assessment routes enforce strict scalar JSON, Origin, methods, limits and no URL authority', async () => {
  const calls = [],
    service = Object.fromEntries(
      ['getState', 'preview', 'apply', 'recheck'].map((method) => [
        method,
        async (input) => {
          calls.push({ method, input });
          return { status: 200, body: { method } };
        },
      ]),
    );
  const route = (req, path = base) => routeIncidentAssessments(req, path, origin, service);
  assert.equal((await route(request(base))).status, 200);
  assert.equal((await route(request(base, '{}'))).status, 405);
  assert.equal((await route(request(base + '?id=secret'))).status, 400);
  assert.equal((await route(request(base, undefined, { 'content-length': '1' }))).status, 400);
  for (const method of ['preview', 'apply', 'recheck']) {
    const path = base + '/' + method;
    assert.equal((await route(request(path), path)).status, 405);
    assert.equal(
      (await route(request(path, '{}', { origin: 'http://foreign.invalid' }), path)).status,
      403,
    );
    for (const text of ['{"id":"a","\\u0069d":"b"}', '{"id":"\\ud800"}', '{"__proto__":{}}'])
      assert.equal((await route(request(path, text), path)).status, 400);
    assert.equal((await route(request(path, 'x'.repeat(4097)), path)).status, 413);
    assert.equal((await route(request(path, '{}'), path)).status, 200);
  }
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getState', 'preview', 'apply', 'recheck'],
  );
  assert.equal((await route(request(base + '/all', '{}'), base + '/all')).status, 404);
});
test('a missing fixed adapter exposes typed unavailable history and no source fallback writer', async () => {
  const source = await readFile(join(import.meta.dirname, 'incidents-worker.mjs'), 'utf8');
  await writeFile(
    join(output, 'bridge.mjs'),
    source
      .replaceAll(
        "'./runtime-layout.mjs'",
        JSON.stringify(pathToFileURL(join(output, 'runtime-layout.mjs')).href),
      )
      .replaceAll(
        "'./control-http.mjs'",
        JSON.stringify(pathToFileURL(join(import.meta.dirname, 'control-http.mjs')).href),
      )
      .replaceAll(
        "'./workspace-monitor-bridge.mjs'",
        JSON.stringify(
          pathToFileURL(join(import.meta.dirname, 'workspace-monitor-bridge.mjs')).href,
        ),
      ),
  );
  await writeFile(
    join(output, 'runtime-layout.mjs'),
    `export const runtimeLayout=()=>({adapter:()=>${JSON.stringify(join(output, 'MISSING.js'))}});`,
  );
  const bridge = await import(pathToFileURL(join(output, 'bridge.mjs')).href);
  assert.equal(typeof bridge.createIncidentAssessmentService, 'function');
  const service = await bridge.createIncidentAssessmentService({
    home: join(output, 'never-created'),
  });
  const state = await service.getState();
  assert.equal(state.status, 200);
  assert.equal(state.body.history, 'unavailable');
  assert.equal(state.body.error, 'runtime-unavailable');
  assert.deepEqual(state.body.records, []);
  assert.equal((await service.apply({ previewId: 'a' })).status, 503);
  await service.close();
  assert.equal((await service.getState()).body.error, 'server-stopped');
});

test('the bridge never retries an annotation after an adapter throws following dispatch', async () => {
  const source = await readFile(join(import.meta.dirname, 'incidents-worker.mjs'), 'utf8');
  const adapter = join(output, 'present-engine.mjs'),
    layout = join(output, 'runtime-layout-present.mjs');
  await writeFile(
    adapter,
    `
    export const createIncidentAssessmentService = async () => ({});
    export async function routeIncidentAssessments(req, path, origin, service) {
      await service.apply({ previewId: 'already-dispatched' });
      throw Error('adapter-post-dispatch-fault');
    }
  `,
  );
  await writeFile(
    layout,
    `export const runtimeLayout=()=>({adapter:()=>${JSON.stringify(adapter)}});`,
  );
  await writeFile(
    join(output, 'bridge-present.mjs'),
    source
      .replaceAll("'./runtime-layout.mjs'", JSON.stringify(pathToFileURL(layout).href))
      .replaceAll(
        "'./control-http.mjs'",
        JSON.stringify(pathToFileURL(join(import.meta.dirname, 'control-http.mjs')).href),
      )
      .replaceAll(
        "'./workspace-monitor-bridge.mjs'",
        JSON.stringify(
          pathToFileURL(join(import.meta.dirname, 'workspace-monitor-bridge.mjs')).href,
        ),
      ),
  );
  const bridge = await import(pathToFileURL(join(output, 'bridge-present.mjs')).href);
  let dispatched = 0;
  const service = {
    apply: async () => {
      dispatched++;
      return { status: 200, body: {} };
    },
  };
  const path = base + '/apply';
  await assert.rejects(
    bridge.routeIncidentAssessments(request(path, '{}'), path, origin, service),
    /adapter-post-dispatch-fault/,
  );
  assert.equal(dispatched, 1);
});
