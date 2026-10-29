import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { runtimeDigest } from './runtime-digest.mjs';
import { createWorkspaceReviewContext } from './workspace-review-context.mjs';
import {
  buildWorkspaceFixture,
  completed,
  workspaceFixture,
} from './workspace-review-test-helpers.mjs';

const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));
await build({
  entry: { control: join(import.meta.dirname, 'workspace-task-control.ts') },
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
  '{"version":"2.0.0","tasks":[{"label":"inert","command":"DO_NOT_RUN","runOptions":{"runOn":"folderOpen"}}]}\n',
);
const manual = Buffer.from(bytes.toString().replace('"folderOpen"', '"default"'));
async function fixture(t) {
  const runtimeRoot = join(built.output, 'inert-runtime-' + randomUUID());
  await mkdir(runtimeRoot, { mode: 0o700 });
  const paths = { cli: join(runtimeRoot, 'index.js'), package: join(runtimeRoot, 'package.json') };
  await writeFile(paths.cli, '/* static digest fixture, never executed */\n');
  await writeFile(paths.package, '{"version":"0.28.0"}\n');
  const f = await workspaceFixture(t, built, {
    options: { paths, runtimeDigest: () => runtimeDigest(paths) },
  });
  await mkdir(join(f.project, '.vscode'), { mode: 0o700 });
  const path = join(f.project, '.vscode/tasks.json');
  await writeFile(path, bytes, { mode: 0o644 });
  const original = await completed(f.service);
  return { ...f, path, original };
}
async function previewAndApply(f, control) {
  const source = f.original.result.capture.sources.find((s) => s.label === '.vscode/tasks.json');
  assert(source);
  const preview = await control.preview({
    runId: f.original.id,
    expectedCaptureSha256: f.original.result.capture.captureSha256,
    sourceId: source.id,
    expectedSourceSha256: source.sha256,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return control.apply({
    previewId: preview.body.id,
    acknowledgeWorkspaceChange: true,
    acknowledgeRecoveryRetention: true,
  });
}

for (const contradiction of ['source-kind', 'source-role', 'engine-version', 'runtime-sha']) {
  test(`post-write verification cannot claim a matching source with ${contradiction} contradiction`, async (t) => {
    const f = await fixture(t),
      owned = new Set();
    let injected = false;
    const review = {
      getState: () => f.service.getState(),
      check: async (input) => {
        const accepted = await f.service.check(input);
        if (accepted.status === 202) owned.add(accepted.body.id);
        return accepted;
      },
      cancel: (input) => f.service.cancel(input),
      getRun: (id) => {
        const run = f.service.getRun(id);
        if (!owned.has(id) || run?.status !== 'completed') return run;
        assert.notEqual(id, f.original.id, 'Use the actual newly accepted capture ID');
        const changed = structuredClone(run),
          capture = changed.result.capture;
        const source = capture.sources.find((s) => s.label === '.vscode/tasks.json');
        assert(source);
        if (contradiction === 'source-kind') source.kind = 'directory';
        if (contradiction === 'source-role') source.role = 'git-metadata';
        if (contradiction === 'engine-version') capture.profile.engineVersion = '0.0.1';
        if (contradiction === 'runtime-sha') capture.profile.runtimeSha256 = 'f'.repeat(64);
        assert(
          built.schema.validateWorkspaceReviewRun(changed),
          'The injected contradiction must pass the ordinary capture schema',
        );
        injected = true;
        return changed;
      },
    };
    const control = await createWorkspaceTaskControl({ ...f.options, workspaceReview: review });
    t.after(() => control.close());
    const result = await previewAndApply(f, control);
    assert(injected, 'The completed capture contradiction was actually consumed');
    assert.deepEqual(
      await readFile(f.path),
      manual,
      'The guarded source write remains separately confirmed',
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.writeConfirmed, true);
    const evidence = result.body.record.verification;
    assert(
      evidence?.status === 'unavailable' ||
        (evidence?.status === 'recorded' && evidence.sourceMatches === false),
      'Wrong source kind/role or analysis profile is not matching task-file evidence',
    );
  });
}

test('a confirmed source publication survives failure to persist its later verification metadata', async (t) => {
  const f = await fixture(t),
    originalContext = await createWorkspaceReviewContext(f.options);
  let failed = false;
  const context = {
    ...originalContext,
    run: (operation, ...args) => {
      if (operation === 'task-verification') {
        failed = true;
        throw new Error('task-store-unavailable');
      }
      return originalContext.run(operation, ...args);
    },
  };
  const control = await createWorkspaceTaskControl({
    ...f.options,
    context,
    workspaceReview: f.service,
  });
  t.after(() => control.close());
  const result = await previewAndApply(f, control);
  assert(failed, 'The post-publication verification storage failure was reached');
  assert.deepEqual(await readFile(f.path), manual);
  assert.equal(
    result.status,
    200,
    'A later metadata failure cannot erase known file-publication confirmation',
  );
  assert.equal(result.body.writeConfirmed, true);
  assert.equal(result.body.record.status, 'manual');
});

test('a confirmed source publication survives contention on the separate verification lock', async (t) => {
  const f = await fixture(t);
  let locks = 0;
  const withLock = (...args) => {
    if (++locks === 2) throw new Error('agent-configuration-busy');
    return f.options.withLock(...args);
  };
  const control = await createWorkspaceTaskControl({
    ...f.options,
    withLock,
    workspaceReview: f.service,
  });
  t.after(() => control.close());
  const result = await previewAndApply(f, control);
  assert.equal(locks, 2, 'The distinct post-publication verification lock was actually refused');
  assert.deepEqual(await readFile(f.path), manual);
  assert.equal(
    result.status,
    200,
    'Verification contention cannot turn a known source write into unknown completion',
  );
  assert.equal(result.body.writeConfirmed, true);
  assert.equal(result.body.record.status, 'manual');
});
