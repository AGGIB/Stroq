import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceMonitorService } from './workspace-monitor-service.mjs';

const ID = '0d42b29f-5182-4a2b-a730-2159145ace08';
const SHA = 'a'.repeat(64);
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function flush() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
function clock() {
  let now = Date.parse('2026-10-24T12:00:00.000Z'),
    sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    size: () => timers.size,
    async advance(delay) {
      const target = now + delay;
      for (;;) {
        const next = [...timers]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
function fixture(t, extra = {}) {
  const time = clock(),
    calls = { read: 0, update: 0, check: 0, getState: 0, cancel: [] };
  const roots = {
    project: { path: '/fixture/project', dev: 1, ino: 2, uid: 1, mode: 448 },
    user: { path: '/fixture/user', dev: 1, ino: 3, uid: 1, mode: 448 },
  };
  const bound = { engineVersion: '0.28.0', runtimeSha256: SHA };
  const context = {
    roots,
    workspaceId: 'workspace-' + 'a'.repeat(24),
    storeId: 'b'.repeat(64),
    options: { home: '/fixture/user/.stroq' },
    current: async () => clone(bound),
    assert: async (expected) => {
      if (JSON.stringify(expected) !== JSON.stringify(bound)) throw new Error('stale-capture');
    },
  };
  const stored = {
    schema: 'stroq-workspace-monitor-intent/1',
    workspaceId: context.workspaceId,
    storeId: context.storeId,
    home: context.options.home,
    roots: clone(roots),
    ...bound,
    configuredAt: new Date(time.now()).toISOString(),
    enabled: true,
  };
  let snapshot =
    extra.enabled === undefined
      ? null
      : { record: { ...stored, enabled: extra.enabled }, revision: SHA };
  const store = {
    async acquireLease() {
      return { assertCurrent: async () => {}, release: async () => {} };
    },
    async read() {
      calls.read++;
      return clone(snapshot);
    },
    async context() {
      return {
        home: context.options.home,
        roots: clone(roots),
        storeId: context.storeId,
        workspaceId: context.workspaceId,
      };
    },
    async update(expected, input, options) {
      calls.update++;
      if (input.expectedRevision !== (snapshot?.revision ?? null))
        throw new Error('monitor-store-stale');
      await options?.beforeCommit?.();
      snapshot = {
        record: {
          ...stored,
          ...expected,
          enabled: input.enabled,
          configuredAt: input.configuredAt,
        },
        revision: String(calls.update).repeat(64),
      };
      return clone(snapshot);
    },
  };
  const jobs = new Map();
  const review = {
    async checkForMonitor(expected, beforeStart) {
      await context.assert(expected);
      await beforeStart();
      return review.check({});
    },
    async check(input) {
      assert.deepEqual(input, {});
      calls.check++;
      if (extra.busy) return { status: 409, body: { error: 'workspace-review-busy' } };
      const run = { id: ID, status: 'running', startedAt: new Date(time.now()).toISOString() };
      jobs.set(ID, run);
      return { status: 202, body: clone(run) };
    },
    getRun(id) {
      return clone(jobs.get(id) ?? null);
    },
    async getState() {
      calls.getState++;
      return { runs: [...jobs.values()].map(clone) };
    },
    async cancel({ id }) {
      calls.cancel.push(id);
      const run = jobs.get(id);
      if (run?.status === 'running')
        jobs.set(id, {
          ...run,
          status: 'cancelled',
          finishedAt: new Date(time.now()).toISOString(),
          error: 'cancelled',
        });
      return { status: 200, body: clone(jobs.get(id)) };
    },
  };
  const service = createWorkspaceMonitorService({
    context,
    store,
    workspaceReview: review,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    withLock: async (_bound, action) => action(),
  });
  t.after(() => service.close());
  return {
    service,
    store,
    review,
    context,
    bound,
    roots,
    calls,
    time,
    get snapshot() {
      return clone(snapshot);
    },
    replace(value) {
      snapshot = value;
    },
    complete(status = 'completed') {
      jobs.set(ID, {
        ...jobs.get(ID),
        status,
        finishedAt: new Date(time.now()).toISOString(),
        ...(status === 'failed' ? { error: 'deadline-exceeded' } : {}),
      });
    },
  };
}

test('monitor GET is in-memory and an absent intent stays quiet after explicit bootstrap', async (t) => {
  const f = fixture(t);
  assert.equal(f.service.getState().status, 'disabled');
  for (let i = 0; i < 5; i++) f.service.getState();
  assert.equal(f.calls.read, 0);
  await f.service.start();
  assert.equal(f.calls.read, 1);
  assert.equal(f.time.size(), 0);
  assert.equal(f.calls.check, 0);
  assert.equal(f.calls.update, 0);
  assert.equal(f.service.getState().nextCheckAt, null);
});

test('exact enabled resume schedules one check and waits five minutes after its completion', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  assert.equal(f.service.getState().status, 'enabled');
  await f.time.advance(0);
  assert.equal(f.calls.check, 1);
  assert.equal(f.service.getState().activeRunId, ID);
  await f.time.advance(1000);
  assert.equal(f.calls.check, 1);
  f.complete();
  await f.time.advance(1000);
  assert.equal(f.service.getState().lastAttempt.status, 'completed');
  assert.equal(f.service.getState().lastAttempt.runId, ID);
  assert.equal(f.service.getState().activeRunId, null);
  assert.equal(f.service.getState().nextCheckAt, new Date(f.time.now() + 300000).toISOString());
  await f.time.advance(299999);
  assert.equal(f.calls.check, 1);
  await f.time.advance(1);
  assert.equal(f.calls.check, 2);
  assert.equal(f.calls.getState, 0);
  assert.equal(f.calls.update, 0);
});

test('manual check contention is skipped without borrowing its evidence or cancelling it', async (t) => {
  const f = fixture(t, { enabled: true, busy: true });
  await f.service.start();
  await f.time.advance(0);
  const state = f.service.getState();
  assert.equal(state.lastAttempt.status, 'skipped');
  assert.equal(state.lastAttempt.runId, null);
  assert.equal(state.lastAttempt.error, 'workspace-review-busy');
  assert.equal(state.activeRunId, null);
  assert.equal(state.nextCheckAt, new Date(f.time.now() + 300000).toISOString());
  await f.service.pause({ expectedRevision: SHA });
  assert.deepEqual(f.calls.cancel, []);
});

test('changed runtime, root identity or canonical storage refuses automatic resume', async (t) => {
  for (const change of [
    (record) => {
      record.runtimeSha256 = 'c'.repeat(64);
    },
    (record) => {
      record.roots.project.ino++;
    },
    (record) => {
      record.roots.user.ino++;
    },
    (record) => {
      record.home += '-other';
    },
  ]) {
    const f = fixture(t, { enabled: true }),
      snapshot = f.snapshot;
    change(snapshot.record);
    f.replace(snapshot);
    await f.service.start();
    assert.equal(f.service.getState().status, 'needs-review');
    assert.equal(f.calls.check, 0);
    assert.equal(f.time.size(), 0);
    assert.equal(f.calls.update, 0);
  }
});

test('enable persists once, scheduled checks preserve the exact configuration revision', async (t) => {
  const f = fixture(t);
  await f.service.start();
  const reply = await f.service.enable({ expectedRevision: null });
  assert.equal(reply.status, 200);
  const revision = f.snapshot.revision;
  assert.equal(f.service.getState().revision, revision);
  await f.time.advance(0);
  f.complete('failed');
  await f.time.advance(1000);
  assert.equal(f.service.getState().lastAttempt.error, 'deadline-exceeded');
  assert.equal(f.snapshot.revision, revision);
  assert.equal(f.calls.update, 1);
});

test('pause commits disabled before cancelling only the owned check and awaits terminal state', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  await f.time.advance(0);
  const original = f.review.cancel;
  f.review.cancel = async (input) => {
    assert.equal(f.snapshot.record.enabled, false);
    return original(input);
  };
  const reply = await f.service.pause({ expectedRevision: SHA });
  assert.equal(reply.status, 200);
  assert.equal(f.service.getState().status, 'disabled');
  assert.equal(f.service.getState().activeRunId, null);
  assert.equal(f.service.getState().lastAttempt.status, 'cancelled');
  assert.deepEqual(f.calls.cancel, [ID]);
  await f.time.advance(600000);
  assert.equal(f.calls.check, 1);
});

test('pause during check acceptance still cancels that owned run and never schedules again', async (t) => {
  const f = fixture(t, { enabled: true }),
    accepted = deferred(),
    original = f.review.check;
  f.review.check = async (input) => {
    const reply = await original(input);
    await accepted.promise;
    return reply;
  };
  await f.service.start();
  await f.time.advance(0);
  const paused = f.service.pause({ expectedRevision: SHA });
  await flush();
  assert.equal(f.snapshot.record.enabled, false);
  accepted.resolve();
  await paused;
  assert.equal(f.service.getState().status, 'disabled');
  assert.deepEqual(f.calls.cancel, [ID]);
  await f.time.advance(600000);
  assert.equal(f.calls.check, 1);
});

test('external intent replacement or runtime drift stops future checks without writes', async (t) => {
  for (const change of [
    (f) => {
      const next = f.snapshot;
      next.revision = 'c'.repeat(64);
      f.replace(next);
    },
    (f) => {
      f.bound.runtimeSha256 = 'c'.repeat(64);
    },
  ]) {
    const f = fixture(t, { enabled: true });
    await f.service.start();
    change(f);
    await f.time.advance(0);
    assert.equal(f.service.getState().status, 'needs-review');
    assert.equal(f.calls.check, 0);
    assert.equal(f.calls.update, 0);
  }
});

test('close invalidates asynchronous bootstrap and cannot leave a future timer', async (t) => {
  const f = fixture(t, { enabled: true }),
    read = deferred(),
    original = f.store.read;
  f.store.read = async () => {
    await read.promise;
    return original();
  };
  const starting = f.service.start(),
    closing = f.service.close();
  read.resolve();
  await Promise.all([starting, closing]);
  assert.equal(f.service.getState().status, 'stopped');
  assert.equal(f.calls.check, 0);
  assert.equal(f.time.size(), 0);
  assert.equal((await f.service.enable({ expectedRevision: SHA })).body.error, 'server-stopped');
});

test('close rejects a pending enable at its final commit guard and leaves no active worker', async (t) => {
  const f = fixture(t),
    commit = deferred(),
    original = f.store.update;
  f.store.update = async (...args) => {
    await commit.promise;
    return original(...args);
  };
  await f.service.start();
  const enabling = f.service.enable({ expectedRevision: null });
  await flush();
  const closing = f.service.close();
  commit.resolve();
  assert.equal((await enabling).body.error, 'server-stopped');
  await closing;
  assert.equal(f.snapshot, null);
  assert.equal(f.calls.check, 0);
  assert.equal(f.time.size(), 0);
});

test('failed pause leaves the enabled monitor and its own run intact', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  await f.time.advance(0);
  assert.equal(
    (await f.service.pause({ expectedRevision: 'c'.repeat(64) })).body.error,
    'monitor-store-stale',
  );
  assert.equal(f.service.getState().status, 'enabled');
  assert.equal(f.service.getState().activeRunId, ID);
  assert.deepEqual(f.calls.cancel, []);
});

test('invalid arguments are refused without reading or changing protected intent', async (t) => {
  const f = fixture(t);
  for (const input of [
    null,
    {},
    { expectedRevision: 'bad' },
    { expectedRevision: null, command: 'bad' },
  ]) {
    assert.equal((await f.service.enable(input)).status, 400);
    assert.equal((await f.service.pause(input)).status, 400);
  }
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.update, 0);
});

test('a non-terminating owned check is bounded and cancelled before scheduling another check', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  await f.time.advance(35000);
  assert.deepEqual(f.calls.cancel, [ID]);
  assert.equal(f.calls.check, 1);
  assert.equal(f.service.getState().activeRunId, null);
  assert.equal(f.service.getState().nextCheckAt, new Date(f.time.now() + 300000).toISOString());
});

test('malformed or missing owned-run observation stops scheduling and never adopts other evidence', async (t) => {
  for (const run of [
    null,
    { id: ID, status: 'unexpected' },
    { id: 'different', status: 'completed' },
  ]) {
    const f = fixture(t, { enabled: true });
    f.review.getRun = () => run;
    await f.service.start();
    await f.time.advance(0);
    assert.equal(f.service.getState().status, 'unavailable');
    assert.equal(f.service.getState().lastAttempt.error, 'invalid-report');
    assert.equal(f.service.getState().nextCheckAt, null);
    assert.deepEqual(f.calls.cancel, [ID]);
  }
});

test('read failures remain explicit unavailable state with no automatic repair or check', async (t) => {
  const f = fixture(t, { enabled: true });
  f.store.read = async () => {
    throw new Error('monitor-store-invalid');
  };
  await f.service.start();
  assert.equal(f.service.getState().status, 'unavailable');
  assert.equal(f.calls.check, 0);
  assert.equal(f.calls.update, 0);
  assert.equal(f.time.size(), 0);
});

test('pause can persist disabled intent even when its prior runtime is no longer available', async (t) => {
  const f = fixture(t, { enabled: true });
  f.context.current = async () => {
    throw new Error('runtime-unavailable');
  };
  await f.service.start();
  assert.equal(f.service.getState().status, 'needs-review');
  assert.equal((await f.service.pause({ expectedRevision: SHA })).status, 200);
  assert.equal(f.snapshot.record.enabled, false);
  assert.equal(f.service.getState().status, 'disabled');
});

test('a second console cannot start another monitor while the workspace lease is held', async (t) => {
  const f = fixture(t, { enabled: true });
  f.store.acquireLease = async () => null;
  await f.service.start();
  assert.equal(f.service.getState().status, 'in-use');
  assert.equal(f.service.getState().reason, 'monitor-in-use');
  assert.equal(f.calls.check, 0);
  assert.equal(f.time.size(), 0);
  await f.time.advance(600000);
  assert.equal(f.calls.check, 0);
});

test('runtime changes between scheduled verification and admission cannot launch the new runtime', async (t) => {
  const f = fixture(t, { enabled: true }),
    original = f.review.checkForMonitor;
  f.review.checkForMonitor = async (...args) => {
    f.bound.runtimeSha256 = 'c'.repeat(64);
    return original(...args);
  };
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.check, 0);
  assert.equal(f.service.getState().status, 'needs-review');
  assert.equal(f.service.getState().reason, 'stale-capture');
  assert.equal(f.service.getState().nextCheckAt, null);
});

test('a refused native admission stops immediately rather than silently retrying the same stale authority', async (t) => {
  for (const error of ['stale-capture', 'runtime-unavailable', 'history-unavailable']) {
    const f = fixture(t, { enabled: true });
    f.review.checkForMonitor = async () => ({ status: 503, body: { error } });
    await f.service.start();
    await f.time.advance(0);
    assert.equal(
      f.service.getState().status,
      error === 'history-unavailable' ? 'unavailable' : 'needs-review',
    );
    assert.equal(f.service.getState().reason, error);
    assert.equal(f.service.getState().lastAttempt.error, error);
    assert.equal(f.service.getState().nextCheckAt, null);
  }
});

test('a completed attempt reporting stale authority stops observation immediately', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  await f.time.advance(0);
  const original = f.review.getRun;
  f.review.getRun = (id) => ({
    ...original(id),
    status: 'failed',
    error: 'stale-capture',
    finishedAt: new Date(f.time.now()).toISOString(),
  });
  await f.time.advance(1000);
  assert.equal(f.service.getState().status, 'needs-review');
  assert.equal(f.service.getState().reason, 'stale-capture');
  assert.equal(f.service.getState().nextCheckAt, null);
});

test('lease acquisition failure after confirmed intent is uncertainty with an explicit stopped observation state', async (t) => {
  const f = fixture(t);
  f.store.acquireLease = async () => {
    throw new Error('monitor-store-unavailable');
  };
  await f.service.start();
  const reply = await f.service.enable({ expectedRevision: null });
  assert.equal(reply.body.error, 'monitor-store-write-unconfirmed');
  assert.equal(f.snapshot.record.enabled, true);
  assert.equal(f.service.getState().status, 'unavailable');
  assert.equal(f.service.getState().reason, 'monitor-store-unavailable');
  assert.equal(f.time.size(), 0);
});

test('an owned run remains running in the projection until failed-observation cancellation settles', async (t) => {
  const f = fixture(t, { enabled: true }),
    cancelled = deferred(),
    original = f.review.cancel;
  f.review.getRun = () => null;
  f.review.cancel = async (input) => {
    await cancelled.promise;
    return original(input);
  };
  await f.service.start();
  await f.time.advance(0);
  try {
    assert.equal(f.service.getState().activeRunId, ID);
    assert.equal(f.service.getState().lastAttempt.status, 'running');
  } finally {
    cancelled.resolve();
  }
  await flush();
  assert.equal(f.service.getState().activeRunId, null);
  assert.equal(f.service.getState().lastAttempt.status, 'failed');
});

test('lost lease ownership refuses the next admission and schedules no takeover', async (t) => {
  const f = fixture(t, { enabled: true });
  f.store.acquireLease = async () => ({
    async assertCurrent() {
      throw new Error('monitor-store-unavailable');
    },
    async release() {},
  });
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.check, 0);
  assert.equal(f.service.getState().status, 'unavailable');
  assert.equal(f.service.getState().reason, 'monitor-store-unavailable');
  assert.equal(f.time.size(), 0);
});

test('an enable preview cannot switch to a different runtime before or during commit', async (t) => {
  for (const duringCommit of [false, true]) {
    const f = fixture(t),
      expectedBound = clone(f.bound),
      original = f.store.update;
    if (duringCommit)
      f.store.update = async (...args) => {
        f.bound.runtimeSha256 = 'c'.repeat(64);
        return original(...args);
      };
    else f.bound.runtimeSha256 = 'c'.repeat(64);
    await f.service.start();
    const reply = await f.service.enable({ expectedRevision: null, expectedBound });
    assert.equal(reply.body.error, 'stale-capture');
    assert.equal(f.snapshot, null);
    assert.equal(f.calls.check, 0);
    assert.equal(f.time.size(), 0);
  }
});

test('enable and pause recheck a private preview guard before update and immediately before publication', async (t) => {
  for (const action of ['enable', 'pause'])
    for (const deniedCall of [1, 2]) {
      const f = fixture(t, { enabled: false });
      let calls = 0;
      const reply = await f.service[action]({
        expectedRevision: SHA,
        beforeCommit: () => {
          if (++calls === deniedCall) throw new Error('monitor-preview-expired');
        },
      });
      assert.equal(reply.status, 409);
      assert.equal(reply.body.error, 'monitor-preview-expired');
      assert.equal(f.snapshot.revision, SHA);
      assert.equal(f.calls.check, 0);
      assert.equal(f.time.size(), 0);
    }
});

test('actual monitor admission rejects another runtime before history and runs its final guard under lock', async (t) => {
  const { buildWorkspaceFixture, workspaceFixture } =
    await import('./workspace-review-test-helpers.mjs');
  const { rm, lstat } = await import('node:fs/promises');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const built = await buildWorkspaceFixture();
  t.after(() => rm(built.output, { recursive: true, force: true }));
  let locked = false;
  const f = await workspaceFixture(t, built, {
    options: {
      withLock: async (_binding, action) => {
        assert.equal(locked, false);
        locked = true;
        try {
          return await action();
        } finally {
          locked = false;
        }
      },
      workerPath: '/fixture/monitor-admission-must-never-launch.mjs',
    },
  });
  const stale = await f.service.checkForMonitor(
    { engineVersion: '0.28.0', runtimeSha256: 'c'.repeat(64) },
    () => assert.fail('stale runtime guard must not be reached'),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale-capture');
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  let guarded = 0;
  const started = await f.service.checkForMonitor(
    { engineVersion: '0.28.0', runtimeSha256: SHA },
    async () => {
      assert.equal(locked, true);
      guarded++;
      throw new Error('stale-capture');
    },
  );
  assert.equal(started.status, 202);
  let terminal;
  for (let count = 0; count < 100; count++) {
    terminal = f.service.getRun(started.body.id);
    if (terminal.status !== 'running') break;
    await sleep(10);
  }
  assert.equal(guarded, 1);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error, 'stale-capture');
  assert.equal(locked, false);
});

test('actual static worker and protected intent: enable, capture changes, preserve review baseline, pause', async (t) => {
  const { buildWorkspaceFixture, workspaceFixture } =
    await import('./workspace-review-test-helpers.mjs');
  const { createWorkspaceReviewContext } = await import('./workspace-review-context.mjs');
  const { createWorkspaceMonitorStore } = await import('./workspace-monitor-store.mjs');
  const { writeFile, lstat, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const built = await buildWorkspaceFixture(),
    time = clock();
  t.after(() => rm(built.output, { recursive: true, force: true }));
  const f = await workspaceFixture(t, built, { options: { now: time.now } });
  const context = await createWorkspaceReviewContext(f.options);
  const store = createWorkspaceMonitorStore({
    home: f.home,
    roots: context.roots,
    workspaceId: context.workspaceId,
    storeId: context.storeId,
  });
  const sentinel = join(f.base, 'never-started');
  await writeFile(join(f.project, '.envrc'), `touch '${sentinel}'\n`);
  const monitor = createWorkspaceMonitorService({
    context,
    store,
    workspaceReview: f.service,
    withLock: f.options.withLock,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  t.after(() => monitor.close());
  assert.equal(f.service.getRun(ID), null);
  await monitor.start();
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const configured = await monitor.enable({ expectedRevision: null });
  assert.equal(configured.status, 200, JSON.stringify(configured));
  const enabled = await store.read();
  await time.advance(0);
  let run;
  for (let count = 0; count < 200; count++) {
    const id = monitor.getState().activeRunId;
    run = id ? f.service.getRun(id) : null;
    if (run && run.status !== 'running') break;
    await sleep(20);
  }
  assert.equal(run?.status, 'completed');
  const exposed = f.service.getRun(run.id);
  exposed.status = 'failed';
  assert.equal(f.service.getRun(run.id).status, 'completed');
  assert(run.result.capture.entries.some((entry) => entry.kind === 'envrc'));
  assert.equal(run.result.baseline.status, 'missing');
  await time.advance(1000);
  assert.equal(monitor.getState().lastAttempt.status, 'completed');
  assert.equal(monitor.getState().lastAttempt.runId, run.id);
  assert.equal((await store.read()).revision, enabled.revision);
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  assert.equal((await monitor.pause({ expectedRevision: enabled.revision })).status, 200);
  assert.equal((await store.read()).record.enabled, false);
  assert.equal(f.service.getRun(run.id).status, 'completed');
  assert.equal((await f.service.getState()).baseline.status, 'missing');
});
