import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';
import * as manifest from './build-runtime-manifest.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const workspaceId = `workspace-${'a'.repeat(24)}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-bundle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'platform');
  await mkdir(join(target, 'scripts'), { recursive: true });
  await mkdir(join(target, '.local-engine'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  return { root, target };
}
function request(path, body, extra = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.url = path;
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { origin: 'http://127.0.0.1:1234', 'content-type': 'application/json', ...extra };
  return req;
}

test('actual shipped service graph stays within the unchanged 64-script limit', async () => {
  const names = await manifest.runtimeServiceNames(await rootIdentity(scripts));
  assert(names.length <= 64);
  assert(names.includes('workspace-monitor-bridge.mjs'));
  for (const name of ['control', 'http', 'service', 'store', 'lease'])
    assert(!names.includes(`workspace-monitor-${name}.mjs`));
  assert(manifest.ADAPTERS.includes('workspace-monitor-engine.js'));
});

test('the 64-script cap still rejects a graph of 65 fixed scripts', async (t) => {
  const f = await fixture(t),
    directory = join(f.root, 'graph');
  await mkdir(directory);
  for (let index = 0; index < 65; index++) {
    const name = index === 0 ? 'launch.mjs' : index === 1 ? 'serve.mjs' : `service-${index}.mjs`;
    const next = index === 0 ? 'serve.mjs' : `service-${index + 1}.mjs`;
    await writeFile(
      join(directory, name),
      index === 64 ? 'export const value=1;' : `import {value} from './${next}'; export {value};`,
    );
  }
  await assert.rejects(
    manifest.runtimeServiceNames(await rootIdentity(directory)),
    /runtime-file-limit/,
  );
});

test('isolated monitor bundle externalizes only shared runtime modules and loads without source monitor files', async (t) => {
  assert.equal(typeof manifest.workspaceMonitorExternalPlugin, 'function');
  const f = await fixture(t);
  await build({
    entry: { 'workspace-monitor-engine': join(scripts, 'workspace-monitor-engine.ts') },
    outDir: join(f.target, '.local-engine'),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    config: false,
    dts: false,
    silent: true,
    removeNodeProtocol: false,
    esbuildPlugins: [manifest.workspaceMonitorExternalPlugin()],
  });
  const stub = `export const WORKSPACE_ERRORS = new Set(['runtime-unavailable']);
export const closedWorkspaceInput=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const createWorkspaceReviewContext=async()=>{throw Error('must-use-supplied-context')};`;
  await writeFile(join(f.target, 'scripts/workspace-review-context.mjs'), stub);
  await writeFile(
    join(f.target, 'scripts/agent-setup-files.mjs'),
    'export const atomicWrite=()=>{},rootIdentity=()=>{},snapshotFile=()=>{};',
  );
  await writeFile(
    join(f.target, 'scripts/agent-configuration-lock.mjs'),
    'export const withAgentConfigurationLock=(_bound,action)=>action();',
  );
  for (const name of ['runtime-layout.mjs', 'control-http.mjs', 'task-lock-runner.mjs'])
    await copyFile(join(scripts, name), join(f.target, 'scripts', name));
  const bytes = await readFile(join(f.target, '.local-engine/workspace-monitor-engine.js'), 'utf8');
  // Import statements only: a line that starts one, or the `}` that ends a multi-line one. A string in
  // the code that holds the word "from" (a list of words) is not an import.
  const imports = [...bytes.matchAll(/^(?:import\b[^\n]*?|\})\s*from\s*["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
  const shared = [
    'workspace-review-context',
    'agent-setup-files',
    'agent-configuration-lock',
    'runtime-layout',
    'control-http',
    'task-lock-runner',
  ];
  assert.deepEqual(
    [...new Set(imports.filter((name) => !name.startsWith('node:')))].sort(),
    shared.map((name) => `../scripts/${name}.mjs`).sort(),
  );
  assert(!bytes.includes(resolve(scripts, '../..')));
  const engine = await import(
    pathToFileURL(join(f.target, '.local-engine/workspace-monitor-engine.js')).href
  );
  assert.equal(typeof engine.routeWorkspaceMonitor, 'function');
  assert.equal(typeof engine.acquireWorkspaceMonitorLease, 'function');
  assert.equal(typeof engine.createSessionTaintControl, 'function');
  assert.equal(typeof engine.routeSessionTaint, 'function');
  const context = {
    workspaceId,
    options: { home: '/fixture' },
    current: async () => ({ engineVersion: '0.28.0', runtimeSha256: 'a'.repeat(64) }),
  };
  const control = await engine.createWorkspaceMonitorControl({
    context,
    store: { read: async () => null, context: async () => ({}) },
    workspaceReview: {},
  });
  assert.equal((await control.state()).body.status, 'disabled');
  await control.close();
});

test('bridge missing its fixed adapter stays unavailable and refuses malformed requests without dispatch', async (t) => {
  const f = await fixture(t);
  for (const name of ['workspace-monitor-bridge.mjs', 'runtime-layout.mjs', 'control-http.mjs'])
    await copyFile(join(scripts, name), join(f.target, 'scripts', name));
  const bridge = await import(
    pathToFileURL(join(f.target, 'scripts/workspace-monitor-bridge.mjs')).href
  );
  assert.equal(typeof bridge.acquireProtectionCheckLease, 'function');
  await assert.rejects(
    bridge.acquireProtectionCheckLease({ home: '/fixture', storeId: 'a'.repeat(64) }),
    /runtime-unavailable/,
  );
  const control = await bridge.createWorkspaceMonitorControl({ workspaceId });
  await control.start();
  const read = await bridge.routeWorkspaceMonitor(
    request('/api/workspace-monitor'),
    '/api/workspace-monitor',
    'http://127.0.0.1:1234',
    control,
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.status, 'unavailable');
  assert.equal(read.body.reason, 'runtime-unavailable');
  assert.equal(read.body.workspaceId, workspaceId);
  assert.equal(read.body.activeRunId, null);
  const path = '/api/workspace-monitor/preview';
  for (const body of [
    '{"action":"enable","action":"pause"}',
    '{"action":{}}',
    '{"action":"\\ud800"}',
  ])
    assert.equal(
      (
        await bridge.routeWorkspaceMonitor(
          request(path, body),
          path,
          'http://127.0.0.1:1234',
          control,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await bridge.routeWorkspaceMonitor(
        request(path, '{"action":"enable","expectedRevision":null}'),
        path,
        'http://127.0.0.1:1234',
        control,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await bridge.routeWorkspaceMonitor(
        request('/api/workspace-monitor?start=true'),
        '/api/workspace-monitor',
        'http://127.0.0.1:1234',
        control,
      )
    ).status,
    400,
  );
  await control.close();
});

test('an older fixed adapter retains watch reads while the new parent lease stays unavailable', async (t) => {
  const f = await fixture(t);
  for (const name of ['workspace-monitor-bridge.mjs', 'runtime-layout.mjs', 'control-http.mjs'])
    await copyFile(join(scripts, name), join(f.target, 'scripts', name));
  await writeFile(
    join(f.target, '.local-engine/workspace-monitor-engine.js'),
    `
    export const createWorkspaceMonitorControl=async()=>({state:async()=>({status:200,body:{status:'disabled'}})});
    export const routeWorkspaceMonitor=async(_req,_path,_origin,service)=>service.state();
  `,
  );
  const bridge = await import(
    pathToFileURL(join(f.target, 'scripts/workspace-monitor-bridge.mjs')).href
  );
  const control = await bridge.createWorkspaceMonitorControl({ workspaceId });
  assert.equal((await control.state()).body.status, 'disabled');
  await assert.rejects(
    bridge.acquireProtectionCheckLease({ home: '/fixture', storeId: 'a'.repeat(64) }),
    /runtime-unavailable/,
  );
  assert.equal((await control.state()).body.status, 'disabled');
});
