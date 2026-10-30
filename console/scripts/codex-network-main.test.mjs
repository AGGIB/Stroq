import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repo = join(import.meta.dirname, '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-main-')));
after(() => rm(output, { recursive: true, force: true }));
const hash = 'a'.repeat(64),
  context = 'codex-context-' + 'b'.repeat(64);
await writeFile(
  join(output, 'schema.ts'),
  `export * from ${JSON.stringify(join(repo, 'console/lib/codex-network-guard.ts'))};export * from ${JSON.stringify(join(repo, 'console/lib/codex-network-guard-private.ts'))};export * from ${JSON.stringify(join(repo, 'console/lib/codex-network-guard-check-private.ts'))};`,
);
await build({
  entry: {
    'inventory-schema': join(output, 'schema.ts'),
    core: join(repo, 'packages/core/src/util/lock.ts'),
  },
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
await writeFile(join(output, 'runtime-hash'), hash);
await writeFile(
  join(output, 'runtime.mjs'),
  `import{readFile}from'node:fs/promises';export const runtimeDigest=async()=>readFile(${JSON.stringify(join(output, 'runtime-hash'))},'utf8');`,
);
await writeFile(
  join(output, 'layout.mjs'),
  `export const runtimeLayout=()=>({repository:${JSON.stringify(output)},core:${JSON.stringify(join(output, 'core.mjs'))},adapter:n=>${JSON.stringify(output)}+'/'+n.replace(/\\.js$/,'.mjs')});`,
);
let source = await readFile(join(import.meta.dirname, 'inventory.mjs'), 'utf8');
for (const [from, to] of [
  ['./runtime-layout.mjs', join(output, 'layout.mjs')],
  ['./agent-setup-cli.mjs', join(output, 'runtime.mjs')],
  ['./inventory-safe.mjs', join(import.meta.dirname, 'inventory-safe.mjs')],
  ['./mcp-containment-files.mjs', join(import.meta.dirname, 'mcp-containment-files.mjs')],
])
  source = source.replaceAll(`'${from}'`, JSON.stringify(pathToFileURL(to).href));
await writeFile(join(output, 'inventory.mjs'), source);
const { createInventory } = await import(pathToFileURL(join(output, 'inventory.mjs')).href);
async function fixture(t, config = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-bridge-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const workerPath = join(base, 'worker.mjs');
  await writeFile(
    workerPath,
    `import{parentPort,workerData as d}from'node:worker_threads';import{writeFile}from'node:fs/promises';await writeFile(d.project+'/received.json',JSON.stringify(d));const c=${JSON.stringify(config)};parentPort.postMessage(c.error?{error:c.error,private:'SENTINEL'}:c.invalid?{private:'SENTINEL'}:{schema:'stroq-codex-network-guard/1',controlContextId:${JSON.stringify(context)},generatedAt:new Date().toISOString(),available:true,history:'missing',records:[],error:null});`,
  );
  const inventory = createInventory({ project, userHome, workerPath });
  t.after(async () => {
    await inventory.close();
    await rm(base, { recursive: true, force: true });
  });
  return { inventory, project, userHome };
}
test('network bridge uses fixed private operation, startup pins, nested data and runtime', async (t) => {
  const { inventory, project } = await fixture(t);
  assert.equal(typeof inventory.codexNetworkOperation, 'function');
  const response = await inventory.codexNetworkOperation('codex-network-state', {});
  assert.equal(response.status, 200);
  const d = JSON.parse(await readFile(join(project, 'received.json'), 'utf8'));
  assert.deepEqual(d.networkGuardData, {});
  assert.equal(d.codexExpectedRoots.project.path, project);
  assert.equal(d.runtimeSha256, hash);
  assert.equal(await inventory.codexNetworkRuntime(), hash);
  assert.equal((await inventory.codexNetworkOperation('read', {})).status, 400);
});
test('actual finite network errors survive main IPC without private payload', async (t) => {
  const { inventory } = await fixture(t, { error: 'codex-network-superseded' });
  assert.deepEqual(await inventory.codexNetworkOperation('codex-network-state', {}), {
    status: 409,
    body: { error: 'codex-network-superseded' },
  });
});
test('malformed private worker output is unavailable, never exposed', async (t) => {
  const { inventory } = await fixture(t, { invalid: true });
  assert.deepEqual(await inventory.codexNetworkOperation('codex-network-state', {}), {
    status: 503,
    body: { error: 'codex-network-unavailable' },
  });
});
test('stale runtime and changed roots refuse before another worker can run', async (t) => {
  const { inventory } = await fixture(t);
  assert.deepEqual(
    await inventory.codexNetworkOperation(
      'codex-network-state',
      {},
      { expectedRuntime: 'c'.repeat(64) },
    ),
    { status: 409, body: { error: 'codex-network-runtime-changed' } },
  );
});
