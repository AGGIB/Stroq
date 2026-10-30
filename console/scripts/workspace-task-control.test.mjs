import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeDigest } from './runtime-digest.mjs';
import {
  buildWorkspaceFixture,
  workspaceFixture,
  completed,
} from './workspace-review-test-helpers.mjs';

const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));
await build({
  entry: {
    control: join(import.meta.dirname, 'workspace-task-control.ts'),
    taskWorker: join(import.meta.dirname, 'workspace-task-worker.ts'),
  },
  outDir: built.output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const { createWorkspaceTaskControl } = await import(
  pathToFileURL(join(built.output, 'control.mjs')).href
);
const bytes = Buffer.from(
  '{\n// preserve comment\n"version":"2.0.0","tasks":[{"label":"inert","command":"NEVER_RUN_SENTINEL","runOptions":{"runOn":"folderOpen"}},{"label":"inert tree","runOptions":{"runOn":"worktreeCreated"}},{"label":"manual","command":"KEEP"}],\n}\n',
);
async function fixture(t) {
  const cliRoot = join(built.output, `cli-${crypto.randomUUID()}`);
  await mkdir(cliRoot, { mode: 0o700 });
  const paths = {
    cli: join(cliRoot, 'index.js'),
    package: join(built.output, 'fixture-package.json'),
  };
  await writeFile(paths.cli, '/* inert runtime fingerprint fixture; never executed */\n');
  await writeFile(paths.package, '{"version":"0.28.0"}\n');
  const runtime = await runtimeDigest(paths);
  const f = await workspaceFixture(t, built, {
    options: { paths, runtimeDigest: () => runtimeDigest(paths) },
  });
  await mkdir(join(f.project, '.vscode'), { mode: 0o700 });
  const path = join(f.project, '.vscode', 'tasks.json');
  await writeFile(path, bytes, { mode: 0o644 });
  const control = await createWorkspaceTaskControl({ ...f.options, workspaceReview: f.service });
  t.after(() => control.close());
  return { ...f, path, paths, runtime, control };
}
const applyInput = (p) => ({
  previewId: p.id,
  acknowledgeWorkspaceChange: true,
  acknowledgeRecoveryRetention: true,
});
const restoreInput = (p) => ({
  previewId: p.id,
  acknowledgeAutomaticExecution: true,
  acknowledgeRecoveryRetention: true,
});
async function preview(f, run) {
  const source = run.result.capture.sources.find((s) => s.label === '.vscode/tasks.json');
  assert(source);
  return f.control.preview({
    runId: run.id,
    expectedCaptureSha256: run.result.capture.captureSha256,
    sourceId: source.id,
    expectedSourceSha256: source.sha256,
  });
}
test('saved source preview, actual guarded mutation, exact static recheck and restore complete the offline loop', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service);
  const baseline = await f.service.getState();
  const state = await f.control.getState();
  assert.equal(state.body.history, 'missing');
  const p = await preview(f, run);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(await readFile(f.path), bytes);
  assert.deepEqual(p.body.changes, { folderOpen: 1, worktreeCreated: 1 });
  const receipt = await f.control.apply(applyInput(p.body));
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.writeConfirmed, true);
  assert.equal(receipt.body.record.status, 'manual');
  assert.equal(receipt.body.record.verification.status, 'recorded');
  assert.equal(receipt.body.record.verification.sourceMatches, true);
  assert.notEqual(receipt.body.record.verification.runId, run.id);
  assert.deepEqual(
    await readFile(f.path),
    Buffer.from(
      bytes.toString().replace('folderOpen', 'default').replace('worktreeCreated', 'default'),
    ),
  );
  assert.equal((await f.control.apply(applyInput(p.body))).status, 409);
  const disk = await f.control.getState();
  assert.deepEqual(disk.body.records[0], receipt.body.record);
  const restore = await f.control.restorePreview({
    recordId: receipt.body.record.id,
    expectedRevision: receipt.body.record.revision,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  const restored = await f.control.restore(restoreInput(restore.body));
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.record.status, 'restored');
  assert.equal(restored.body.record.verification.sourceMatches, true);
  assert.deepEqual(await readFile(f.path), bytes);
  assert.deepEqual((await f.service.getState()).baseline, baseline.baseline);
  const publicText = JSON.stringify([p.body, receipt.body, disk.body, restored.body]);
  for (const privateValue of [
    f.project,
    f.userHome,
    'NEVER_RUN_SENTINEL',
    'KEEP',
    'preserve comment',
  ])
    assert(!publicText.includes(privateValue));
});
test('stale, wrong source and injected path requests refuse before target or recovery writes', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service);
  const source = run.result.capture.sources.find((s) => s.label === '.vscode/tasks.json');
  const input = {
    runId: run.id,
    expectedCaptureSha256: run.result.capture.captureSha256,
    sourceId: source.id,
    expectedSourceSha256: source.sha256,
  };
  assert.equal((await f.control.preview({ ...input, path: '/arbitrary' })).status, 400);
  assert.equal(
    (await f.control.preview({ ...input, sourceId: 'source-' + 'a'.repeat(64) })).status,
    409,
  );
  await writeFile(f.path, Buffer.from('{}'));
  assert.equal((await f.control.preview(input)).status, 409);
  assert.deepEqual(await readFile(f.path), Buffer.from('{}'));
  assert.equal((await f.control.getState()).body.history, 'missing');
});
test('actual capture unavailability preserves a confirmed file write without fabricated verification', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service);
  await f.control.close();
  const control = await createWorkspaceTaskControl({
    ...f.options,
    workspaceReview: {
      getState: () => f.service.getState(),
      getRun: (id) => f.service.getRun(id),
      check: async () => ({ status: 409, body: { error: 'workspace-review-busy' } }),
    },
  });
  t.after(() => control.close());
  const p = await preview({ ...f, control }, run);
  const receipt = await control.apply(applyInput(p.body));
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.writeConfirmed, true);
  assert.deepEqual(receipt.body.record.verification, {
    status: 'unavailable',
    runId: null,
    error: 'capture-unavailable',
  });
  assert.equal((await control.getState()).body.records[0].verification.status, 'unavailable');
});
test('worker independently refuses runtime drift and a closed service starts no further operations', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service),
    p = await preview(f, run);
  await writeFile(f.paths.cli, '/* changed inert runtime fixture */');
  const apply = await f.control.apply(applyInput(p.body));
  assert.equal(apply.status, 409);
  assert.deepEqual(await readFile(f.path), bytes);
  await f.control.close();
  assert.equal((await preview(f, run)).body.error, 'server-stopped');
});
test('a later verification metadata failure cannot erase an already confirmed task-file publication', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service);
  await f.control.close();
  let locks = 0;
  const control = await createWorkspaceTaskControl({
    ...f.options,
    workspaceReview: f.service,
    withLock: async (binding, action, options) => {
      if (++locks === 2) throw new Error('agent-configuration-busy');
      return f.options.withLock(binding, action, options);
    },
  });
  t.after(() => control.close());
  const p = await preview({ ...f, control }, run),
    receipt = await control.apply(applyInput(p.body));
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.writeConfirmed, true);
  assert.equal(receipt.body.record.status, 'manual');
  assert.equal(receipt.body.record.verification.status, 'unavailable');
  assert.equal(receipt.body.record.canRestore, false);
  assert.equal(receipt.body.record.fileState, 'unverifiable');
  assert.deepEqual(
    await readFile(f.path),
    Buffer.from(
      bytes.toString().replace('folderOpen', 'default').replace('worktreeCreated', 'default'),
    ),
  );
  assert.equal(
    (await control.getState()).body.records[0].verification,
    null,
    'No fictitious durable capture metadata',
  );
});
test('a partial capture with unrelated parse gaps can still bind the fresh supported task source', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.claude'), { mode: 0o700 });
  await writeFile(join(f.project, '.claude', 'settings.json'), '{invalid');
  const run = await completed(f.service);
  assert.equal(run.result.capture.complete, false);
  const p = await preview(f, run);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.binding.captureComplete, false);
  const receipt = await f.control.apply(applyInput(p.body));
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.record.verification.complete, false);
  assert.equal(receipt.body.record.verification.sourceMatches, true);
});
test('closing a live task worker waits for termination before releasing the actual configuration lock', async (t) => {
  const f = await fixture(t),
    run = await completed(f.service);
  await f.control.close();
  const wrapper = join(built.output, `held-worker-${crypto.randomUUID()}.mjs`);
  await writeFile(
    wrapper,
    `import {parentPort,workerData} from 'node:worker_threads';
    import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
    import {runWorkspaceTaskWorker} from ${JSON.stringify(pathToFileURL(join(built.output, 'taskWorker.mjs')).href)};
    const fault=async(stage)=>{if(stage==='after-intent'){await writeFile(join(workerData.options.home,'held-marker'),'held',{mode:0o600});await new Promise(()=>{setInterval(()=>{},1000);});}};
    runWorkspaceTaskWorker(workerData,fault).then(result=>parentPort.postMessage({type:'result',result}),error=>parentPort.postMessage({type:'error',error:error.message}));`,
  );
  const control = await createWorkspaceTaskControl({
    ...f.options,
    workerPath: wrapper,
    workspaceReview: f.service,
  });
  t.after(() => control.close());
  const p = await preview({ ...f, control }, run),
    operation = control.apply(applyInput(p.body));
  let held = false;
  for (let i = 0; i < 100; i++) {
    try {
      held = (await readFile(join(f.home, 'held-marker'), 'utf8')) === 'held';
    } catch {}
    if (held) break;
    await delay(20);
  }
  assert(held, 'real worker must reach the durable intent boundary');
  await assert.rejects(
    f.options.withLock({ home: f.home, version: '0.28.0' }, async () => {}, { timeoutMs: 30 }),
    /^Error: lock timeout:/,
  );
  await control.close();
  assert.notEqual((await operation).status, 200);
  await f.options.withLock({ home: f.home, version: '0.28.0' }, async () => {}, {
    timeoutMs: 3000,
  });
  assert.deepEqual(await readFile(f.path), bytes);
  const recovered = await createWorkspaceTaskControl({ ...f.options, workspaceReview: f.service });
  t.after(() => recovered.close());
  const record = (await recovered.getState()).body.records[0];
  assert.equal(record.status, 'prepared');
  const checked = await recovered.recheck({ recordId: record.id });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.writeConfirmed, false);
  assert.equal(checked.body.record.status, 'unchanged');
});
