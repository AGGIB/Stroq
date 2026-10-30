import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const scripts = dirname(fileURLToPath(import.meta.url));
const origin = 'http://127.0.0.1:1234';
const workspaceId = `workspace-${'a'.repeat(24)}`;
function request(url, body, extra = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.url = url;
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { origin, 'content-type': 'application/json', ...extra };
  return req;
}
test('missing fixed task adapter provides closed unavailable state and no mutation dispatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stroq-task-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const name of ['workspace-monitor-bridge.mjs', 'runtime-layout.mjs', 'control-http.mjs'])
    await copyFile(join(scripts, name), join(root, 'scripts', name));
  const bridge = await import(
    pathToFileURL(join(root, 'scripts/workspace-monitor-bridge.mjs')).href
  );
  assert.equal(typeof bridge.createWorkspaceTaskControl, 'function');
  assert.equal(typeof bridge.routeWorkspaceTasks, 'function');
  const service = await bridge.createWorkspaceTaskControl({ workspaceId });
  const base = '/api/workspace-task-controls';
  const route = (req, path = base) => bridge.routeWorkspaceTasks(req, path, origin, service);
  const state = await route(request(base));
  assert.equal(state.status, 200);
  assert.deepEqual(
    Object.keys(state.body).sort(),
    ['schema', 'workspaceId', 'generatedAt', 'available', 'history', 'error', 'records'].sort(),
  );
  assert.equal(state.body.available, false);
  assert.equal(state.body.error, 'runtime-unavailable');
  assert.equal(state.body.history, 'unavailable');
  assert.deepEqual(state.body.records, []);
  for (const suffix of ['preview', 'apply', 'restore-preview', 'restore', 'recheck']) {
    const path = `${base}/${suffix}`;
    for (const body of [
      '{"recordId":"a","recordId":"b"}',
      '{"recordId":{}}',
      '{"recordId":"\\ud800"}',
    ])
      assert.equal((await route(request(path, body), path)).status, 400);
    assert.equal((await route(request(path, '{}'), path)).status, 503);
    assert.equal(
      (await route(request(path, '{}', { origin: 'http://foreign.invalid' }), path)).status,
      403,
    );
    assert.equal((await route(request(path), path)).status, 405);
  }
  assert.equal((await route(request(base + '?path=private'))).status, 400);
  assert.equal((await route(request(base, '{}'))).status, 405);
  assert.equal((await route(request(base, undefined, { 'content-length': '1' }))).status, 400);
  assert.equal((await route(request(base + '/run'), base + '/run')).status, 404);
  await service.close();
  assert.equal((await service.state()).body.error, 'server-stopped');
});

test('an available task router error is not retried through the unavailable request parser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stroq-task-bridge-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.local-engine'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  for (const name of ['workspace-monitor-bridge.mjs', 'runtime-layout.mjs', 'control-http.mjs'])
    await copyFile(join(scripts, name), join(root, 'scripts', name));
  await writeFile(
    join(root, '.local-engine/workspace-monitor-engine.js'),
    `
    export const createWorkspaceMonitorControl=()=>({});
    export const routeWorkspaceMonitor=()=>({});
    export const routeWorkspaceTasks=async()=>{throw Error('fixture-router-failed')};
  `,
  );
  const bridge = await import(
    pathToFileURL(join(root, 'scripts/workspace-monitor-bridge.mjs')).href
  );
  await assert.rejects(
    bridge.routeWorkspaceTasks(
      request('/api/workspace-task-controls/apply', '{}'),
      '/api/workspace-task-controls/apply',
      origin,
      {},
    ),
    /fixture-router-failed/,
  );
});
