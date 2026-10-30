import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  lstat,
  realpath,
  rm,
  writeFile,
  readFile,
  readdir,
  chmod,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createWorkspaceReviewService } from './workspace-review-service.mjs';
import {
  buildWorkspaceFixture,
  workspaceFixture,
  completed,
  reviewInput,
  hash,
} from './workspace-review-test-helpers.mjs';

const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));

test('GET and invalid actions do not create local state or execute a workspace check', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-workspace-review-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const service = await createWorkspaceReviewService({ project, userHome, home });
  t.after(() => service.close());
  for (const input of [null, { command: 'injected' }, { path: project }, { base: 'HEAD' }])
    assert.equal((await service.check(input)).status, 400);
  assert.equal((await service.review({})).status, 400);
  assert.equal((await service.cancel({ id: '../private' })).status, 400);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});

test('actual worker: explicit check → exact review → restart → source/semantic delta, without executing commands', async (t) => {
  const f = await workspaceFixture(t, built),
    sentinel = join(f.base, 'never-executed');
  const raw = `# private-command-sentinel\ntouch '${sentinel}'\n`;
  await writeFile(join(f.project, '.envrc'), raw);
  await writeFile(
    join(f.project, 'CLAUDE.md'),
    '# Local instruction\nDo not run external tools.\n',
  );
  let state = await f.service.getState();
  assert(built.schema.validateWorkspaceReviewState(state));
  assert.equal(state.baseline.status, 'missing');
  assert.deepEqual(state.runs, []);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const first = await completed(f.service);
  assert.equal(first.status, 'completed');
  assert.equal(first.result.capture.complete, true);
  assert(first.result.capture.entries.length > 0);
  assert.equal(first.result.canReview, true);
  const exposed = JSON.stringify(first);
  for (const secret of [
    'private-command-sentinel',
    sentinel,
    f.project,
    f.userHome,
    'Do not run external tools',
  ])
    assert(!exposed.includes(secret));
  const consent = { ...reviewInput(first), acknowledgeReviewOnly: false };
  assert.equal((await f.service.review(consent)).status, 400);
  assert.equal((await f.service.getState()).baseline.status, 'missing');
  const reviewed = await f.service.review(reviewInput(first));
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  assert(built.schema.validateWorkspaceReviewReceipt(reviewed.body));
  await f.service.close();
  const restarted = await createWorkspaceReviewService(f.options);
  t.after(() => restarted.close());
  state = await restarted.getState();
  assert.equal(state.baseline.revision, reviewed.body.revision);
  assert.equal(state.runs[0].id, first.id);
  await writeFile(join(f.project, '.envrc'), `# comment-only addition\n${raw}`);
  const comment = await completed(restarted);
  assert.equal(comment.status, 'completed');
  assert.equal(comment.result.comparison.status, 'comparable');
  assert.equal(comment.result.comparison.sources.length, 1);
  assert.equal(comment.result.comparison.entries.added.length, 0);
  assert.equal(comment.result.comparison.entries.removed.length, 0);
  assert.equal((await restarted.getState()).baseline.revision, reviewed.body.revision);
  await restarted.getState();
  assert.equal((await restarted.getState()).baseline.revision, reviewed.body.revision);
  await mkdir(join(f.project, '.vscode'));
  await writeFile(
    join(f.project, '.vscode/tasks.json'),
    JSON.stringify({
      version: '2.0.0',
      tasks: [
        {
          label: 'private-task-label',
          type: 'shell',
          command: 'private-command-arg',
          runOptions: { runOn: 'folderOpen' },
        },
      ],
    }),
  );
  const changed = await completed(restarted);
  assert.equal(changed.status, 'completed');
  assert.equal(changed.result.capture.complete, true);
  assert(changed.result.comparison.entries.added.length > 0);
  assert(!JSON.stringify(changed).includes('private-task-label'));
  assert(!JSON.stringify(changed).includes('private-command-arg'));
  assert.equal((await restarted.review(reviewInput(comment))).body.error, 'stale-capture');
  const last = await restarted.review(reviewInput(changed));
  assert.equal(last.status, 200, JSON.stringify(last));
  assert.equal((await restarted.review(reviewInput(changed))).body.error, 'stale-baseline');
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(f.project, '.envrc'), 'utf8'),
    `# comment-only addition\n${raw}`,
  );
});

test('user home workspace excludes only declared Stroq storage and remains reviewable after retained writes', async (t) => {
  const f = await workspaceFixture(t, built, { homeWorkspace: true });
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const run = await completed(f.service);
  assert.equal(run.status, 'completed');
  assert.equal(run.result.capture.complete, true);
  assert.deepEqual(run.result.capture.coverage.exclusions, ['stroq-state']);
  assert.equal((await f.service.review(reviewInput(run))).status, 200);
  const fresh = await completed(f.service);
  assert.equal(fresh.result.capture.captureSha256, run.result.capture.captureSha256);
  assert.equal(fresh.result.comparison.sources.length, 0);
  assert.equal(fresh.result.comparison.entries.added.length, 0);
});

test('source mode/runtime drift refuses review; optional ordinary edits do not invent capability drift', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n', { mode: 0o600 });
  let run = await completed(f.service);
  await chmod(join(f.project, '.envrc'), 0o644);
  assert.equal((await f.service.review(reviewInput(run))).body.error, 'stale-capture');
  run = await completed(f.service);
  f.setRuntime('b'.repeat(64));
  assert.equal((await f.service.review(reviewInput(run))).body.error, 'stale-capture');
  f.setRuntime('a'.repeat(64));
  run = await completed(f.service);
  await writeFile(join(f.project, 'ordinary.txt'), 'unrelated implementation edit');
  assert.equal((await f.service.review(reviewInput(run))).status, 200);
});

test('invalid UTF8 and outside links produce actionable safe gaps and cannot become a reviewed baseline', async (t) => {
  const f = await workspaceFixture(t, built);
  await mkdir(join(f.project, '.vscode'));
  await writeFile(join(f.project, '.vscode/tasks.json'), Buffer.from([0xff, 0xfe]));
  const run = await completed(f.service);
  assert.equal(run.status, 'completed');
  assert.equal(run.result.capture.complete, false);
  assert.equal(run.result.canReview, false);
  assert(
    run.result.capture.coverage.gaps.some(
      (g) => g.label === '.vscode/tasks.json' && g.labelHidden === false,
    ),
  );
  assert.equal((await f.service.review(reviewInput(run))).body.error, 'incomplete-capture');
  await rm(join(f.project, '.vscode/tasks.json'));
  await writeFile(join(f.base, 'outside.json'), '{}');
  await symlink(join(f.base, 'outside.json'), join(f.project, '.vscode/tasks.json'));
  const linked = await completed(f.service);
  assert.equal(linked.result.capture.complete, false);
  assert(
    linked.result.capture.coverage.gaps.some(
      (g) => g.code === 'outside-root' || g.code === 'not-regular',
    ),
  );
  assert.equal((await f.service.getState()).baseline.status, 'missing');
});

test('malformed baseline and retained history fail closed; GET never silently accepts or overwrites them', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const run = await completed(f.service);
  assert.equal((await f.service.review(reviewInput(run))).status, 200);
  const files = await readdir(join(f.home, 'console')),
    baseline = join(
      f.home,
      'console',
      files.find((s) => s.startsWith('workspace-review-baseline-')),
    );
  const bad = '{"schema":"stroq-workspace-baseline/1","schema":"duplicate-private-sentinel"}\n';
  await writeFile(baseline, bad, { mode: 0o600 });
  const state = await f.service.getState();
  assert.equal(state.baseline.status, 'invalid');
  assert(!JSON.stringify(state).includes('duplicate-private-sentinel'));
  const current = await completed(f.service);
  assert.equal(current.result.canReview, false);
  assert.equal((await f.service.review(reviewInput(current))).body.error, 'incomplete-capture');
  assert.equal(await readFile(baseline, 'utf8'), bad);
  const history = join(
    f.home,
    'console',
    files.find((s) => s.startsWith('workspace-review-') && !s.includes('baseline')),
  );
  await writeFile(history, '{"private":"history-sentinel"}', { mode: 0o600 });
  assert.equal((await f.service.getState()).history.status, 'error');
  assert.equal((await f.service.check({})).body.error, 'history-unavailable');
});

test('secret-bearing .npmrc keeps one revision and semantic entry identity across fresh workers and review', async (t) => {
  const f = await workspaceFixture(t, built);
  await writeFile(
    join(f.project, '.npmrc'),
    'registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=npm_private-fixture-sentinel\n',
  );
  const a = await completed(f.service),
    b = await completed(f.service);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');
  assert.equal(a.result.capture.complete, true);
  assert.equal(a.result.capture.captureSha256, b.result.capture.captureSha256);
  assert.deepEqual(
    a.result.capture.entries.map((r) => [r.id, r.semanticSha256]),
    b.result.capture.entries.map((r) => [r.id, r.semanticSha256]),
  );
  assert.equal((await f.service.review(reviewInput(b))).status, 200);
  assert(!JSON.stringify(b).includes('npm_private-fixture-sentinel'));
});

test('cancel waits for isolated check termination, persists the cancelled attempt, and restart does not rerun it', async (t) => {
  const file = join(built.output, 'cancel-worker.mjs'),
    marker = join(built.output, 'cancel-must-not-write');
  await writeFile(
    file,
    `import {workerData,parentPort} from 'node:worker_threads';import{writeFileSync}from'node:fs';if(workerData.operation==='check')setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'bad'),800);else await import(${JSON.stringify(pathToFileURL(join(built.output, 'worker.mjs')).href)});`,
  );
  const f = await workspaceFixture(t, built, { options: { workerPath: file } }),
    started = await f.service.check({});
  assert.equal(started.status, 202);
  assert.equal((await f.service.check({})).body.error, 'workspace-review-busy');
  const cancelled = await f.service.cancel({ id: started.body.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.error, 'cancelled');
  await setTimeout(900);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  await f.service.close();
  const restored = await createWorkspaceReviewService(f.options);
  t.after(() => restored.close());
  assert.equal((await restored.getState()).runs[0].status, 'cancelled');
});

test('review deadline retains the parent configuration lock through termination and reports uncertainty without retry', async (t) => {
  const file = join(built.output, 'deadline-worker.mjs'),
    marker = join(built.output, 'review-must-not-write');
  await writeFile(
    file,
    `import {workerData} from 'node:worker_threads';import{writeFileSync}from'node:fs';if(workerData.operation==='review')setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'bad'),3000);else await import(${JSON.stringify(pathToFileURL(join(built.output, 'worker.mjs')).href)});`,
  );
  let held = false,
    releasedAt = 0;
  const f = await workspaceFixture(t, built, {
    options: {
      workerPath: file,
      timeoutMs: 1500,
      withLock: async ({ home, version }, action, options) =>
        built.lock.withManifestLock(
          { home, version, now: () => new Date() },
          async () => {
            assert.equal(held, false);
            held = true;
            try {
              return await action();
            } finally {
              held = false;
              releasedAt = Date.now();
            }
          },
          options,
        ),
    },
  });
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const run = await completed(f.service);
  assert.equal(run.status, 'completed');
  const at = Date.now(),
    reply = await f.service.review(reviewInput(run));
  assert.equal(reply.status, 422);
  assert.equal(reply.body.error, 'write-unconfirmed');
  assert.equal(held, false);
  assert(releasedAt >= at + 1000);
  await setTimeout(1700);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.equal((await f.service.getState()).baseline.status, 'missing');
});

for (const variant of ['duplicate', 'escaped-duplicate', 'invalid-utf8']) {
  test(`retained history rejects ${variant} without overwriting or authorizing review`, async (t) => {
    const f = await workspaceFixture(t, built);
    await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
    const run = await completed(f.service);
    const names = await readdir(join(f.home, 'console'));
    const path = join(
      f.home,
      'console',
      names.find((n) => n.startsWith('workspace-review-') && !n.includes('baseline')),
    );
    const raw = await readFile(path),
      text = raw.toString('utf8');
    const unsafe =
      variant === 'invalid-utf8'
        ? Buffer.concat([raw.subarray(0, 1), Buffer.from([0xff]), raw.subarray(1)])
        : Buffer.from(
            text.replace(
              '{',
              variant === 'duplicate'
                ? '{"schema":"private-duplicate-sentinel",'
                : '{"sch\\u0065ma":"private-duplicate-sentinel",',
            ),
          );
    await writeFile(path, unsafe, { mode: 0o600 });
    const state = await f.service.getState();
    assert.equal(state.history.status, 'error');
    assert.equal(state.history.error, 'invalid-history');
    assert(!JSON.stringify(state).includes('private-duplicate-sentinel'));
    assert.equal((await f.service.check({})).body.error, 'history-unavailable');
    assert.equal((await f.service.review(reviewInput(run))).body.error, 'history-unavailable');
    assert.deepEqual(await readFile(path), unsafe);
    const restarted = await createWorkspaceReviewService(f.options);
    t.after(() => restarted.close());
    assert.equal((await restarted.getState()).history.status, 'error');
    assert.deepEqual(await readFile(path), unsafe);
  });
}

test('an older adapter without the strict history parser cannot authorize workspace writes', async (t) => {
  const schema = { ...built.schema };
  delete schema.parseWorkspaceReviewHistoryJson;
  const f = await workspaceFixture(t, built, { options: { loadValidator: async () => schema } });
  assert.equal((await f.service.getState()).engine.available, false);
  assert.equal((await f.service.check({})).body.error, 'runtime-unavailable');
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});

test('terminal report stays running until final history persistence completes, then a new check starts immediately', async (t) => {
  let calls = 0,
    release,
    entered;
  const barrier = new Promise((resolve) => {
      release = resolve;
    }),
    finalWrite = new Promise((resolve) => {
      entered = resolve;
    });
  const f = await workspaceFixture(t, built, {
    options: {
      withLock: ({ home, version }, action, options) =>
        built.lock.withManifestLock(
          { home, version, now: () => new Date() },
          async () => {
            if (++calls === 2) {
              entered();
              await barrier;
            }
            return action();
          },
          options,
        ),
    },
  });
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const first = await f.service.check({});
  assert.equal(first.status, 202);
  await finalWrite;
  let cancellation,
    cancelSettled = false;
  try {
    const state = await f.service.getState();
    assert.equal(state.runs.find((run) => run.id === first.body.id).status, 'running');
    assert.equal((await f.service.check({})).body.error, 'workspace-review-busy');
    cancellation = f.service.cancel({ id: first.body.id }).then((reply) => {
      cancelSettled = true;
      return reply;
    });
    assert.equal(
      (await f.service.getState()).runs.find((run) => run.id === first.body.id).status,
      'running',
    );
    assert.equal(cancelSettled, false);
  } finally {
    release();
  }
  assert.equal((await cancellation).body.status, 'completed');
  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = (await f.service.getState()).runs.find((run) => run.id === first.body.id);
    if (terminal.status !== 'running') break;
    await setTimeout(10);
  }
  assert.equal(terminal.status, 'completed');
  const next = await f.service.check({});
  assert.equal(next.status, 202, JSON.stringify(next));
  assert.notEqual(next.body.id, first.body.id);
});

test('two consoles merge terminal history under the shared lock and refresh each other read-only', async (t) => {
  const f = await workspaceFixture(t, built);
  const second = await createWorkspaceReviewService(f.options);
  t.after(() => second.close());
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const a = await completed(f.service),
    b = await completed(second);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');
  const names = await readdir(join(f.home, 'console'));
  const file = join(
    f.home,
    'console',
    names.find((n) => n.startsWith('workspace-review-') && !n.includes('baseline')),
  );
  const retained = await readFile(file);
  for (const service of [f.service, second]) {
    const state = await service.getState();
    assert.equal(state.history.status, 'ready');
    assert.deepEqual(new Set(state.runs.map((r) => r.id)), new Set([a.id, b.id]));
    assert.ok(state.runs.every((r) => r.status === 'completed'));
  }
  assert.deepEqual(await readFile(file), retained);
});

test('another console never fabricates a failed attempt for a foreign running worker', async (t) => {
  const worker = join(built.output, 'foreign-running-worker.mjs');
  await writeFile(
    worker,
    `import {workerData}from'node:worker_threads';if(workerData.operation==='check')setInterval(()=>{},1000);else await import(${JSON.stringify(pathToFileURL(join(built.output, 'worker.mjs')).href)});`,
  );
  const f = await workspaceFixture(t, built, { options: { workerPath: worker } });
  const started = await f.service.check({});
  assert.equal(started.status, 202);
  const second = await createWorkspaceReviewService(f.options);
  t.after(() => second.close());
  const names = await readdir(join(f.home, 'console'));
  const file = join(
    f.home,
    'console',
    names.find((n) => n.startsWith('workspace-review-') && !n.includes('baseline')),
  );
  const retained = await readFile(file),
    state = await second.getState();
  assert.equal(
    state.runs.some((r) => r.id === started.body.id),
    false,
  );
  assert.deepEqual(await readFile(file), retained);
  const cancelled = await f.service.cancel({ id: started.body.id });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(
    (await second.getState()).runs.find((r) => r.id === started.body.id)?.status,
    'cancelled',
  );
});

test('concurrent consoles preserve both terminal reports when their real workers finish together', async (t) => {
  const worker = join(built.output, 'concurrent-history-worker.mjs'),
    marker = join(built.output, 'concurrent-history-release');
  await writeFile(
    worker,
    `import{workerData}from'node:worker_threads';import{existsSync}from'node:fs';import{setTimeout as sleep}from'node:timers/promises';if(workerData.operation==='check')while(!existsSync(${JSON.stringify(marker)}))await sleep(5);await import(${JSON.stringify(pathToFileURL(join(built.output, 'worker.mjs')).href)});`,
  );
  const f = await workspaceFixture(t, built, { options: { workerPath: worker } });
  const second = await createWorkspaceReviewService(f.options);
  t.after(() => second.close());
  await writeFile(join(f.project, '.envrc'), 'export FIXTURE=1\n');
  const [a, b] = await Promise.all([f.service.check({}), second.check({})]);
  assert.equal(a.status, 202, JSON.stringify(a));
  assert.equal(b.status, 202, JSON.stringify(b));
  await writeFile(marker, 'release', { mode: 0o600 });
  for (let index = 0; index < 200; index++) {
    if (
      f.service.getRun(a.body.id)?.status !== 'running' &&
      second.getRun(b.body.id)?.status !== 'running'
    )
      break;
    await setTimeout(10);
  }
  assert.equal(f.service.getRun(a.body.id)?.status, 'completed');
  assert.equal(second.getRun(b.body.id)?.status, 'completed');
  for (const service of [f.service, second]) {
    const state = await service.getState();
    assert.equal(state.history.status, 'ready');
    assert.deepEqual(new Set(state.runs.map((r) => r.id)), new Set([a.body.id, b.body.id]));
    assert.ok(state.runs.every((r) => r.status === 'completed'));
  }
});
