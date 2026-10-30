import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rootIdentity } from './agent-setup-files.mjs';
import {
  buildWorkspaceFixture,
  workspaceFixture,
  completed,
  hash,
} from './workspace-review-test-helpers.mjs';
const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));
async function request(f, operation, input = {}) {
  const root = await rootIdentity(f.project);
  return {
    operation,
    input,
    options: {
      project: f.project,
      userHome: f.userHome,
      home: f.home,
      workspaceId: f.workspaceId,
      storeId: hash(`stroq-workspace/1\0${f.project}\0${root.dev}\0${root.ino}`),
      roots: { project: root, user: await rootIdentity(f.userHome) },
      engineVersion: '0.28.0',
      runtimeSha256: 'a'.repeat(64),
      now: new Date().toISOString(),
      deadline: Date.now() + 25000,
      configurationLockHeld: operation === 'review',
    },
  };
}
const underLock = (f, action) =>
  built.lock.withManifestLock({ home: f.home, version: '0.28.0', now: () => new Date() }, action, {
    timeoutMs: 3000,
  });

test('late captured dependency changes produce incomplete evidence with a different exact capture SHA', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export A=1\n');
  await completed(f.service);
  const first = await built.engine.runWorkspaceReviewWorker(await request(f, 'check'));
  const changed = await built.engine.runWorkspaceReviewWorker(await request(f, 'check'), {
    fault: async (stage) => {
      if (stage === 'after-capture') await writeFile(join(f.project, '.envrc'), 'export A=2\n');
    },
  });
  assert.equal(first.capture.complete, true);
  assert.equal(changed.capture.complete, false);
  assert.notEqual(changed.capture.captureSha256, first.capture.captureSha256);
  assert(changed.capture.coverage.gaps.some((g) => g.code === 'source-changed'));
  assert.equal(changed.canReview, false);
});

test('a repository above the workspace or nested in it is a named gap, never a reviewable capture', async (t) => {
  // The workspace's own `.git` (none above) or the one Git would use instead of it.
  for (const [name, own, unread, gap] of [
    ['enclosing', null, (f) => join(f.base, '.git'), { code: 'enclosing-repository', label: null }],
    [
      'nested',
      (f) => join(f.project, '.git'),
      (f) => join(f.project, 'vendor/tool/.git'),
      { code: 'nested-repository', label: 'vendor/tool/.git' },
    ],
  ])
    await t.test(name, async (sub) => {
      const f = await workspaceFixture(sub, built);
      if (own) await mkdir(own(f));
      await mkdir(unread(f), { recursive: true });
      await writeFile(join(unread(f), 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(unread(f), 'config'), '[core]\n\tfsmonitor = never-read-this\n');
      const result = await built.engine.runWorkspaceReviewWorker(await request(f, 'check'));
      assert.equal(built.schema.validateWorkspaceReviewResult(result), true);
      assert.equal(result.capture.complete, false);
      assert.equal(result.canReview, false);
      assert.deepEqual(
        result.capture.coverage.gaps.map((g) => ({ code: g.code, label: g.label })),
        [gap],
      );
      assert.equal(JSON.stringify(result).includes('never-read-this'), false);
    });
});

test('review detects a late source change and leaves baseline absent', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export A=1\n');
  const run = await completed(f.service);
  const req = await request(f, 'review', {
    runId: run.id,
    capture: run.result.capture,
    expectedReviewedRevision: null,
  });
  await assert.rejects(
    underLock(f, () =>
      built.engine.runWorkspaceReviewWorker(req, {
        fault: async (stage) => {
          if (stage === 'after-capture') await writeFile(join(f.project, '.envrc'), 'export A=2\n');
        },
      }),
    ),
    /stale-capture/,
  );
  assert.equal((await f.service.getState()).baseline.status, 'missing');
});

test('baseline CAS refuses a foreign file staged before publish without overwriting or retrying', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export A=1\n');
  const run = await completed(f.service);
  const req = await request(f, 'review', {
    runId: run.id,
    capture: run.result.capture,
    expectedReviewedRevision: null,
  });
  const path = join(f.home, 'console', `workspace-review-baseline-${req.options.storeId}.json`),
    foreign = '{"private":"foreign-baseline"}\n';
  await assert.rejects(
    underLock(f, () =>
      built.engine.runWorkspaceReviewWorker(req, {
        fault: async (stage) => {
          if (stage === 'before-rename') await writeFile(path, foreign, { mode: 0o600 });
        },
      }),
    ),
    /stale-baseline/,
  );
  assert.equal(await readFile(path, 'utf8'), foreign);
  assert.equal((await f.service.getState()).baseline.status, 'invalid');
});

test('post-publish source change returns uncertainty and preserves the written review without rollback', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export A=1\n');
  const run = await completed(f.service);
  const req = await request(f, 'review', {
    runId: run.id,
    capture: run.result.capture,
    expectedReviewedRevision: null,
  });
  await assert.rejects(
    underLock(f, () =>
      built.engine.runWorkspaceReviewWorker(req, {
        fault: async (stage) => {
          if (stage === 'after-rename') await writeFile(join(f.project, '.envrc'), 'export A=2\n');
        },
      }),
    ),
    /write-unconfirmed/,
  );
  const state = await f.service.getState();
  assert.equal(state.baseline.status, 'available');
  assert.equal(state.baseline.capture.captureSha256, run.result.capture.captureSha256);
  const newRun = await completed(f.service);
  assert.equal(newRun.result.comparison.status, 'comparable');
  assert(newRun.result.comparison.sources.some((s) => s.state === 'changed'));
});

test('same baseline expected revision cannot overwrite an already recorded review', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export A=1\n');
  const run = await completed(f.service);
  const req = await request(f, 'review', {
    runId: randomUUID(),
    capture: run.result.capture,
    expectedReviewedRevision: null,
  });
  const receipt = await underLock(f, () => built.engine.runWorkspaceReviewWorker(req));
  assert(built.schema.validateWorkspaceReviewReceipt(receipt));
  await assert.rejects(
    underLock(f, () => built.engine.runWorkspaceReviewWorker(req)),
    /stale-baseline/,
  );
  const names = await readdir(join(f.home, 'console'));
  assert.equal(names.filter((s) => s.startsWith('workspace-review-baseline-')).length, 1);
  assert.equal((await f.service.getState()).baseline.revision, receipt.revision);
});
