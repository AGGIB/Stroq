import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repo = join(import.meta.dirname, '../..'),
  output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-main-')));
after(() => rm(output, { recursive: true, force: true }));
const hash = 'a'.repeat(64),
  context = 'codex-context-' + 'b'.repeat(64);
await writeFile(
  join(output, 'schema.ts'),
  `export * from ${JSON.stringify(join(repo, 'console/lib/codex-path-guard.ts'))};export * from ${JSON.stringify(join(repo, 'console/lib/codex-path-guard-private.ts'))};`,
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
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-bridge-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const workerPath = join(base, 'worker.mjs');
  await writeFile(
    workerPath,
    `import{parentPort,workerData as d}from'node:worker_threads';import{writeFile,lstat}from'node:fs/promises';await writeFile(d.project+'/received.json',JSON.stringify(d));const c=${JSON.stringify(config)};if(c.hold){await writeFile(d.project+'/lock-held',String((await lstat(d.userHome+'/.stroq/.codex-skill-controls.apply.lock')).isDirectory()));await new Promise(r=>setTimeout(r,60000));}parentPort.postMessage(c.error?{error:c.error,private:'PRIVATE_SENTINEL'}:c.invalid?{private:'PRIVATE_SENTINEL'}:{schema:'stroq-codex-path-guard/1',controlContextId:${JSON.stringify(context)},generatedAt:new Date().toISOString(),available:true,history:'missing',records:[],error:null});`,
  );
  const inventory = createInventory({
    project,
    userHome,
    workerPath,
    timeoutMs: config.hold ? 30000 : undefined,
  });
  t.after(async () => {
    await inventory.close();
    await rm(base, { recursive: true, force: true });
  });
  return { inventory, base, project, userHome };
}
test('path bridge binds fixed private operation, nested payload, runtime and startup filesystem roots', async (t) => {
  const f = await fixture(t),
    r = await f.inventory.codexPathGuardOperation('codex-path-state', {});
  assert.equal(r.status, 200);
  const d = JSON.parse(await readFile(join(f.project, 'received.json'), 'utf8'));
  assert.deepEqual(d.pathGuardData, {});
  assert.equal(d.operation, 'codex-path-state');
  assert.equal(d.codexExpectedRoots.project.path, f.project);
  assert.equal(d.codexExpectedRoots.user.path, f.userHome);
  assert.equal(d.runtimeSha256, hash);
  assert.equal(await f.inventory.codexPathGuardRuntime(), hash);
  for (const op of ['read', 'codex-network-state', 'codex-path-run', 'codex-path-apply/extra'])
    assert.equal((await f.inventory.codexPathGuardOperation(op, {})).status, 400);
});
test('only finite Path error codes survive IPC and malformed worker output cannot expose private fields', async (t) => {
  const f = await fixture(t, { error: 'codex-path-guard-superseded' });
  assert.deepEqual(await f.inventory.codexPathGuardOperation('codex-path-state', {}), {
    status: 409,
    body: { error: 'codex-path-guard-superseded' },
  });
  const broken = await fixture(t, { invalid: true });
  assert.deepEqual(await broken.inventory.codexPathGuardOperation('codex-path-state', {}), {
    status: 503,
    body: { error: 'codex-path-guard-unavailable' },
  });
});
test('runtime and replaced roots refuse before a worker starts', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.inventory.codexPathGuardOperation(
      'codex-path-state',
      {},
      { expectedRuntime: 'c'.repeat(64) },
    ),
    { status: 409, body: { error: 'codex-path-guard-runtime-changed' } },
  );
  await assert.rejects(lstat(join(f.project, 'received.json')), { code: 'ENOENT' });
  await rename(f.project, join(f.base, 'old-project'));
  await mkdir(f.project);
  assert.deepEqual(await f.inventory.codexPathGuardOperation('codex-path-state', {}), {
    status: 409,
    body: { error: 'codex-path-guard-stale' },
  });
});
test('writer admission shares the Codex lease and close waits for worker termination before releasing it', async (t) => {
  const f = await fixture(t, { hold: true });
  const missing = await f.inventory.codexPathGuardOperation('codex-path-apply', {});
  assert.equal(missing.body.error, 'codex-path-guard-stale');
  const work = f.inventory.codexPathGuardOperation('codex-path-apply', {}, { writer: true });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await lstat(join(f.project, 'lock-held'));
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  assert.equal(await readFile(join(f.project, 'lock-held'), 'utf8'), 'true');
  assert.deepEqual(await f.inventory.codexPathGuardOperation('codex-path-state', {}), {
    status: 409,
    body: { error: 'codex-path-guard-busy' },
  });
  assert.equal(
    (await f.inventory.codexNetworkOperation('codex-network-state', {})).body.error,
    'codex-network-busy',
  );
  await f.inventory.close();
  await work;
  await assert.rejects(lstat(join(f.userHome, '.stroq/.codex-skill-controls.apply.lock')), {
    code: 'ENOENT',
  });
});
