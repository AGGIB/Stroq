import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, lstat } from 'node:fs/promises';
import { buildWorkspaceFixture, workspaceFixture } from './workspace-review-test-helpers.mjs';
import { createWorkspaceMonitorControl } from './workspace-monitor-control.mjs';
import { createWorkspaceReviewContext } from './workspace-review-context.mjs';
const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));
async function fixture(t) {
  const f = await workspaceFixture(t, built);
  const control = await createWorkspaceMonitorControl({ ...f.options, workspaceReview: f.service });
  t.after(() => control.close());
  await control.start();
  return { ...f, control };
}
const confirm = (p) => ({
  previewId: p.id,
  confirm: true,
  acknowledgeLocalChecks: p.action === 'enable',
  acknowledgeRetention: p.action === 'enable',
});
test('opening state and previews never create an opt-in or a check', async (t) => {
  const f = await fixture(t);
  const s = await f.control.state();
  assert.equal(s.status, 200);
  assert.equal(s.body.status, 'disabled');
  assert.equal((await f.service.getState()).runs.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const p = await f.control.preview({ action: 'enable', expectedRevision: null });
  assert.equal(p.status, 200);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  assert.equal((await f.service.getState()).runs.length, 0);
});
test('enable requires both acknowledgements and exact one-use preview', async (t) => {
  const f = await fixture(t);
  const p = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  assert.equal((await f.control.apply({ ...confirm(p), acknowledgeRetention: false })).status, 400);
  assert.equal((await f.control.state()).body.status, 'disabled');
  const reply = await f.control.apply(confirm(p));
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(reply.body.previewId, p.id);
  assert.equal(reply.body.enabled, true);
  assert.equal((await f.control.apply(confirm(p))).status, 409);
  const state = (await f.control.state()).body;
  assert.equal(state.status, 'enabled');
  assert.notEqual(state.revision, null);
  const pause = (await f.control.preview({ action: 'pause', expectedRevision: state.revision }))
    .body;
  const paused = await f.control.apply(confirm(pause));
  assert.equal(paused.status, 200, JSON.stringify(paused));
  assert.equal(paused.body.enabled, false);
  f.setRuntime(null);
  const unavailable = (await f.control.state()).body;
  assert.equal(unavailable.status, 'disabled');
  assert.equal(unavailable.runtimeSha256, null);
});
test('runtime changes after preview cannot acquire consent for another runtime', async (t) => {
  const f = await fixture(t);
  const p = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  f.setRuntime('b'.repeat(64));
  const reply = await f.control.apply(confirm(p));
  assert.equal(reply.status, 409, JSON.stringify(reply));
  assert.equal((await f.control.state()).body.status, 'disabled');
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
test('stale revisions and arbitrary controls are rejected before mutation', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.control.preview({ action: 'enable', expectedRevision: 'a'.repeat(64) })).status,
    409,
  );
  for (const input of [
    { action: 'enable' },
    { action: 'enable', expectedRevision: null, intervalMs: 1 },
    { action: 'enable', expectedRevision: null, project: '/tmp' },
  ])
    assert.equal((await f.control.preview(input)).status, 400);
});
test('expired preview cannot apply and GET verifies current runtime', async (t) => {
  const f = await workspaceFixture(t, built);
  let now = Date.now();
  const control = await createWorkspaceMonitorControl({
    ...f.options,
    workspaceReview: f.service,
    now: () => now,
  });
  t.after(() => control.close());
  await control.start();
  const p = (await control.preview({ action: 'enable', expectedRevision: null })).body;
  now += 120001;
  assert.equal((await control.apply(confirm(p))).status, 409);
  f.setRuntime('b'.repeat(64));
  assert.equal((await control.state()).body.runtimeSha256, 'b'.repeat(64));
});
test('a clock tick cannot extend either public or private preview expiry', async (t) => {
  for (const action of ['enable', 'pause']) {
    const revision = 'c'.repeat(64),
      bound = { engineVersion: '0.28.0', runtimeSha256: 'a'.repeat(64) };
    let now = Date.parse('2026-10-24T12:00:00.000Z'),
      mutations = 0;
    const control = await createWorkspaceMonitorControl({
      context: {
        workspaceId: `workspace-${'d'.repeat(24)}`,
        current: async () => bound,
      },
      store: { read: async () => ({ revision, record: bound }) },
      scheduler: {
        [action]: async () => {
          mutations++;
          return { status: 200, body: { revision } };
        },
        close: async () => {},
      },
      now: () => now++,
    });
    t.after(() => control.close());
    const reply = await control.preview({ action, expectedRevision: revision });
    assert.equal(reply.status, 200);
    const plan = reply.body;
    assert.equal(built.schema.validateWorkspaceMonitorPreview(plan), true, JSON.stringify(plan));
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 120000);
    now = Date.parse(plan.expiresAt);
    const expired = await control.apply(confirm(plan));
    assert.equal(expired.status, 409, JSON.stringify(expired));
    assert.equal(expired.body.error, 'monitor-preview-expired');
    assert.equal(mutations, 0);
  }
});
test('consent that expires while verifying runtime cannot write an intent', async (t) => {
  const f = await workspaceFixture(t, built);
  let now = Date.now(),
    armed = false;
  const control = await createWorkspaceMonitorControl({
    ...f.options,
    workspaceReview: f.service,
    now: () => now,
    runtimeDigest: async () => {
      if (armed) {
        armed = false;
        now += 120001;
      }
      return 'a'.repeat(64);
    },
  });
  t.after(() => control.close());
  await control.start();
  const p = (await control.preview({ action: 'enable', expectedRevision: null })).body;
  armed = true;
  const reply = await control.apply(confirm(p));
  assert.equal(reply.status, 409, JSON.stringify(reply));
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
test('unavailable root identity leaves other console functionality available without creating storage', async (t) => {
  const f = await workspaceFixture(t, built),
    context = await createWorkspaceReviewContext(f.options);
  context.roots = null;
  context.current = async () => {
    throw Error('context-unavailable');
  };
  const control = await createWorkspaceMonitorControl({
    ...f.options,
    context,
    workspaceReview: f.service,
  });
  t.after(() => control.close());
  await control.start();
  const state = await control.state();
  assert.equal(state.body.status, 'unavailable');
  assert.equal(state.body.runtimeSha256, null);
  assert.equal(state.body.reason, 'context-unavailable');
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
test('an intent change during a state read cannot reconcile an uncertain write', async (t) => {
  const f = await workspaceFixture(t, built);
  let changed = false,
    armed = false;
  const context = await createWorkspaceReviewContext({
    ...f.options,
    runtimeDigest: async () => {
      if (armed) changed = true;
      return 'a'.repeat(64);
    },
  });
  const store = {
    read: async () =>
      changed
        ? {
            revision: 'b'.repeat(64),
            record: { configuredAt: new Date().toISOString(), enabled: false },
          }
        : null,
    context: async () => ({
      home: f.home,
      roots: context.roots,
      workspaceId: context.workspaceId,
      storeId: context.storeId,
    }),
  };
  const control = await createWorkspaceMonitorControl({
    ...f.options,
    context,
    store,
    workspaceReview: f.service,
  });
  t.after(() => control.close());
  await control.start();
  armed = true;
  const state = (await control.state()).body;
  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'monitor-store-stale');
  assert.equal(state.runtimeSha256, null);
});
