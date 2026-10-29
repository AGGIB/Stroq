import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskLockPages } from './task-lock-pages.mjs';
import { tsImport } from 'tsx/esm/api';
const schema = {
  ...(await tsImport('../lib/task-locks.ts', import.meta.url)),
  ...(await tsImport('../lib/task-lock-page.ts', import.meta.url)),
};
const workspaceId = `workspace-${'a'.repeat(24)}`;
const digest = 'b'.repeat(64);
function fixture(extra = {}) {
  let clock = Date.parse('2026-10-24T12:00:00.000Z');
  const calls = [];
  const bound = { runtimeSha256: digest, engineVersion: '0.28.0' };
  let listing = digest;
  const state = {
    schema: 'stroq-task-locks/1',
    workspaceId,
    host: 'claude-code',
    checkedAt: new Date(clock).toISOString(),
    currentPolicySha256: null,
    available: true,
    reason: null,
    coverage: { complete: false, limited: true, unverified: 0, foreign: 64 },
    tasks: [],
    limitations: schema.TASK_LOCK_LIMITATIONS,
  };
  const pages = createTaskLockPages({
    workspaceId,
    schema,
    now: () => clock,
    context: async () => ({ ...bound }),
    assertBound: async () => {},
    worker: async (_operation, input) => {
      calls.push(input);
      return {
        state,
        listing: { sha256: listing, offset: input.offset ?? 64, total: 130, limited: false },
      };
    },
    unavailable: () => {
      throw Error('unexpected-unavailable');
    },
    ...extra,
  });
  return {
    pages,
    calls,
    bound,
    state,
    advance: (ms) => (clock += ms),
    changeListing: () => (listing = 'f'.repeat(64)),
  };
}

test('opaque cursors privately bind the next catalog page and remain reusable until expiry', async (t) => {
  const f = fixture();
  t.after(() => f.pages.close());
  const first = await f.pages.first();
  assert.equal(schema.validateTaskLockPage(first), true);
  assert.deepEqual(f.calls, [{ offset: 0, expectedListingSha256: null }]);
  assert.equal(first.page.index, 1);
  assert.match(first.page.nextCursor, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(first).includes(digest), false);
  for (let i = 0; i < 2; i++) {
    const second = await f.pages.select({ cursor: first.page.nextCursor });
    assert.equal(second.page.index, 2);
    assert.deepEqual(f.calls.at(-1), { offset: 64, expectedListingSha256: digest });
    assert.equal(schema.validateTaskLockPage(second), true);
  }
});

test('expiry, unknown and foreign-instance cursors never become first-page requests', async (t) => {
  const f = fixture(),
    other = fixture();
  t.after(() => {
    f.pages.close();
    other.pages.close();
  });
  const cursor = (await f.pages.first()).page.nextCursor;
  await assert.rejects(other.pages.select({ cursor }), { message: 'task-page-stale' });
  assert.equal(other.calls.length, 0);
  f.advance(300_000);
  await assert.rejects(f.pages.select({ cursor }), { message: 'task-page-expired' });
  assert.equal(f.calls.length, 1);
});

test('catalog and runtime drift refuse an old cursor without returning substituted evidence', async (t) => {
  const f = fixture();
  t.after(() => f.pages.close());
  const cursor = (await f.pages.first()).page.nextCursor;
  f.changeListing();
  await assert.rejects(f.pages.select({ cursor }), { message: 'task-page-stale' });
  f.bound.runtimeSha256 = 'e'.repeat(64);
  const count = f.calls.length;
  await assert.rejects(f.pages.select({ cursor }), { message: 'task-page-stale' });
  assert.equal(f.calls.length, count);
});

test('at most 256 opaque cursors survive; eviction never accepts an old first-page fallback', async (t) => {
  const f = fixture();
  t.after(() => f.pages.close());
  const cursor = (await f.pages.first()).page.nextCursor;
  for (let i = 0; i < 256; i++) await f.pages.first();
  const count = f.calls.length;
  await assert.rejects(f.pages.select({ cursor }), { message: 'task-page-stale' });
  assert.equal(f.calls.length, count);
});

test('browser offsets, native paths, missing hashes and extra fields are refused before worker reads', async (t) => {
  const f = fixture();
  t.after(() => f.pages.close());
  for (const input of [
    {},
    { offset: 64 },
    { cursor: '../private' },
    { cursor: '11111111-1111-4111-8111-111111111111', offset: 64 },
    { id: `task-${digest}` },
    { id: 'private-native-task', expectedPermitSha256: null },
    { id: `task-${digest}`, expectedPermitSha256: null, path: '/private' },
  ])
    await assert.rejects(f.pages.select(input), { message: 'invalid-request' });
  assert.equal(f.calls.length, 0);
});

test('closed worker envelopes, exact offset and hard catalog bounds are verified before publication', async (t) => {
  for (const change of [
    { private: '/private' },
    { listing: { sha256: digest, offset: 1, total: 130, limited: false } },
    { listing: { sha256: digest, offset: 64, total: 130, limited: false } },
    { listing: { sha256: digest, offset: 0, total: 8193, limited: false } },
  ]) {
    let f;
    f = fixture({
      worker: async () => ({
        state: f.state,
        listing: { sha256: digest, offset: 0, total: 130, limited: false },
        ...change,
      }),
    });
    t.after(() => f.pages.close());
    await assert.rejects(f.pages.first(), { message: 'invalid-report' });
  }
});

test('old adapters without the new schema cannot authorize pages, and closed service clears authority', async () => {
  const f = fixture({ schema: { ...schema, validateTaskLockPage: undefined } });
  await assert.rejects(f.pages.first(), { message: 'runtime-unavailable' });
  assert.equal(f.calls.length, 0);
  f.pages.close();
  const g = fixture();
  const cursor = (await g.pages.first()).page.nextCursor;
  g.pages.close();
  await assert.rejects(g.pages.select({ cursor }), { message: 'server-stopped' });
});

test('close during the final context check cannot publish a page or retain a new cursor', async () => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    assertBound: async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = f.pages.first();
  await ready;
  f.pages.close();
  release();
  await assert.rejects(pending, { message: 'server-stopped' });
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.pages.first(), { message: 'server-stopped' });
});
