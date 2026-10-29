import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-monitor-service-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { service: join(repository, 'console/scripts/inventory-monitor-service.ts') },
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
const { createInventoryMonitorService } = await import(
  pathToFileURL(join(output, 'service.mjs')).href
);
const clone = (value) => structuredClone(value),
  SHA = 'a'.repeat(64),
  workspaceId = 'workspace-' + 'a'.repeat(24);
const flush = async () => {
  for (let index = 0; index < 120; index++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function clock() {
  let now = Date.parse('2026-10-24T12:00:00.000Z'),
    sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++sequence;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    size: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, value]) => value.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
function fixture(t, { enabled, busy = false, leaseBusy = false } = {}) {
  const time = clock(),
    calls = { read: 0, append: 0, update: 0, released: 0, context: 0 };
  const bound = {
      engineVersion: '0.28.0',
      runtimeSha256: SHA,
      sourceProfileSha256: 'c'.repeat(64),
    },
    roots = {
      project: { path: '/fixture/project', ino: 1, dev: 1 },
      user: { path: '/fixture/user', ino: 2, dev: 1 },
    };
  const binding = { home: '/fixture/user/.stroq', roots, workspaceId, storeId: 'b'.repeat(64) };
  const context = {
    ...binding,
    options: { home: binding.home },
    async current() {
      calls.context++;
      return clone(bound);
    },
    async assert(expected) {
      assert.deepEqual(expected, bound);
    },
  };
  let intent =
    enabled === undefined
      ? null
      : {
          revision: SHA,
          record: {
            ...binding,
            ...bound,
            enabled,
            configuredAt: new Date(time.now()).toISOString(),
          },
        };
  let read = async () => ({
    status: busy ? 409 : 200,
    body: busy ? { error: 'inventory-busy' } : snapshot(),
  });
  const captureId = randomUUID(),
    checks = [];
  const store = {
    context: async () => clone(binding),
    readIntent: async () => clone(intent),
    acquireLease: async () =>
      leaseBusy
        ? null
        : {
            assertCurrent: async () => {},
            release: async () => {
              calls.released++;
            },
          },
    async updateIntent(expected, input, options) {
      assert.equal(input.expectedRevision, intent?.revision ?? null);
      await options?.beforeCommit?.();
      calls.update++;
      intent = {
        revision: String(calls.update).repeat(64),
        record: {
          ...binding,
          ...expected,
          enabled: input.enabled,
          configuredAt: input.configuredAt,
        },
      };
      return clone(intent);
    },
    async appendObservation(_snapshot, expected, input) {
      assert.deepEqual(expected, bound);
      assert.equal(input.expectedIntentRevision, intent.revision);
      await input.beforeCommit();
      calls.append++;
      checks.push(input.checkId);
      return {
        record: { id: captureId },
        latestCheckId: input.checkId,
        latestCaptureId: captureId,
      };
    },
  };
  function snapshot() {
    return {
      schema: 'stroq-inventory/1',
      source: 'local',
      generatedAt: new Date(time.now()).toISOString(),
      workspace: { id: workspaceId, label: 'workspace' },
      baseline: { status: 'missing', reviewedAt: null },
      items: [],
      gaps: [],
      limitations: [],
    };
  }
  const service = createInventoryMonitorService({
    context,
    store,
    inventory: {
      read: async () => {
        calls.read++;
        return read();
      },
    },
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    withLock: async (_bound, action) => action(),
  });
  t.after(() => service.close());
  return {
    service,
    store,
    context,
    bound,
    time,
    calls,
    checks,
    snapshot,
    setRead(value) {
      read = value;
    },
    replace(value) {
      intent = value;
    },
    get intent() {
      return clone(intent);
    },
  };
}

test('state and absent intent bootstrap never scan or write', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 3; index++) f.service.getState();
  await f.service.start();
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.update, 0);
  assert.equal(f.time.size(), 0);
  assert.equal(f.service.getState().status, 'disabled');
});
test('saved opt-in runs once and schedules five minutes after capture completion', async (t) => {
  const f = fixture(t, { enabled: true }),
    pending = deferred();
  f.setRead(() => pending.promise);
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.read, 1);
  assert.equal(f.service.getState().lastAttempt.status, 'running');
  await f.time.advance(10000);
  assert.equal(f.calls.read, 1);
  assert.equal(f.time.size(), 0);
  pending.resolve({ status: 200, body: f.snapshot() });
  await flush();
  assert.equal(f.calls.append, 1);
  assert.equal(f.service.getState().nextCheckAt, new Date(f.time.now() + 300000).toISOString());
  await f.time.advance(299999);
  assert.equal(f.calls.read, 1);
  await f.time.advance(1);
  assert.equal(f.calls.read, 2);
});
test('every successful check receives a new check ID even when semantic capture coalesces', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  await f.time.advance(0);
  const first = f.service.getState();
  await f.time.advance(300000);
  const second = f.service.getState();
  assert.equal(f.calls.append, 2);
  assert.notEqual(first.latestCheckId, second.latestCheckId);
  assert.equal(first.latestCaptureId, second.latestCaptureId);
});
test('pause persists disabled intent and drops a late shared capture without cancelling it', async (t) => {
  const f = fixture(t, { enabled: true }),
    pending = deferred();
  f.setRead(() => pending.promise);
  await f.service.start();
  await f.time.advance(0);
  const pausing = f.service.pause({ expectedRevision: f.intent.revision });
  await flush();
  assert.equal(f.intent.record.enabled, false);
  pending.resolve({ status: 200, body: f.snapshot() });
  await pausing;
  assert.equal(f.calls.append, 0);
  assert.equal(f.service.getState().status, 'disabled');
  assert.equal(f.time.size(), 0);
  assert.equal(f.calls.released, 1);
});
test('foreign or invalid inventory cannot become an observation', async (t) => {
  const f = fixture(t, { enabled: true });
  f.setRead(async () => ({
    status: 200,
    body: { ...f.snapshot(), workspace: { id: 'workspace-' + 'b'.repeat(24), label: 'foreign' } },
  }));
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.append, 0);
  assert.equal(f.service.getState().lastAttempt.status, 'failed');
});
test('contention is skipped and another lease prevents scanning', async (t) => {
  const f = fixture(t, { enabled: true, busy: true });
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.service.getState().lastAttempt.status, 'skipped');
  assert.equal(f.calls.append, 0);
  const other = fixture(t, { enabled: true, leaseBusy: true });
  await other.service.start();
  await other.time.advance(0);
  assert.equal(other.calls.read, 0);
  assert.equal(other.service.getState().status, 'in-use');
});
test('changed runtime or externally paused intent cannot append or reschedule', async (t) => {
  const f = fixture(t, { enabled: true });
  await f.service.start();
  f.bound.runtimeSha256 = 'b'.repeat(64);
  await f.time.advance(0);
  assert.equal(f.calls.read, 0);
  assert.equal(f.service.getState().status, 'needs-review');
  const other = fixture(t, { enabled: true }),
    pending = deferred();
  other.setRead(() => pending.promise);
  await other.service.start();
  await other.time.advance(0);
  other.replace({
    ...other.intent,
    revision: 'b'.repeat(64),
    record: { ...other.intent.record, enabled: false },
  });
  pending.resolve({ status: 200, body: other.snapshot() });
  await flush();
  assert.equal(other.calls.append, 0);
  assert.equal(other.time.size(), 0);
});
test('close drains a shared read and prevents a late observation or timer', async (t) => {
  const f = fixture(t, { enabled: true }),
    pending = deferred();
  f.setRead(() => pending.promise);
  await f.service.start();
  await f.time.advance(0);
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);
  pending.resolve({ status: 200, body: f.snapshot() });
  await closing;
  assert.equal(f.calls.append, 0);
  assert.equal(f.time.size(), 0);
  assert.equal(f.service.getState().status, 'stopped');
});
test('pause while lease verification waits prevents a not-yet-started inventory read', async (t) => {
  const f = fixture(t, { enabled: true }),
    gate = deferred();
  f.store.acquireLease = async () => ({
    assertCurrent: () => gate.promise,
    release: async () => {},
  });
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.read, 0);
  const pausing = f.service.pause({ expectedRevision: f.intent.revision });
  await flush();
  gate.resolve();
  await pausing;
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.append, 0);
});
test('runtime drift during a capture cannot append a late historical result', async (t) => {
  const f = fixture(t, { enabled: true }),
    gate = deferred();
  f.setRead(() => gate.promise);
  await f.service.start();
  await f.time.advance(0);
  assert.equal(f.calls.read, 1);
  f.bound.runtimeSha256 = 'b'.repeat(64);
  gate.resolve({ status: 200, body: f.snapshot() });
  await flush();
  assert.equal(f.calls.append, 0);
  assert.equal(f.service.getState().status, 'needs-review');
  assert.equal(f.time.size(), 0);
});
