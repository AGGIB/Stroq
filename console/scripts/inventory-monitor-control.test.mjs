import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-monitor-control-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    control: join(repository, 'console/scripts/inventory-monitor-control.ts'),
    schema: join(repository, 'console/lib/inventory-monitor.ts'),
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
const { createInventoryMonitorControl } = await import(
  pathToFileURL(join(output, 'control.mjs')).href
);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const clone = (value) => structuredClone(value),
  SHA = 'a'.repeat(64),
  workspaceId = 'workspace-' + 'a'.repeat(24);
const confirm = (preview) => ({
  previewId: preview.id,
  confirm: true,
  acknowledgeLocalChecks: preview.action === 'enable',
  acknowledgeUserSources: preview.action === 'enable',
  acknowledgeRetention: preview.action === 'enable',
});
async function fixture(t) {
  let now = Date.parse('2026-10-24T12:00:00.000Z'),
    intent = null,
    unavailable = false,
    gate = async () => {};
  const calls = { enable: 0, pause: 0, scans: 0 },
    bound = { engineVersion: '0.28.0', runtimeSha256: SHA };
  const environment = {};
  const context = {
    workspaceId,
    options: { home: '/fixture/user/.stroq' },
    roots: { project: { path: '/fixture/project' }, user: { path: '/fixture/user' } },
    current: async () => clone(bound),
  };
  const history = {
    status: 'missing',
    revision: null,
    records: [],
    omitted: 0,
    latestCheckId: null,
    latestCaptureId: null,
  };
  const state = {
    schema: 'stroq-inventory-monitor/1',
    workspaceId,
    status: 'disabled',
    reason: null,
    revision: null,
    configuredAt: null,
    runtimeSha256: null,
    intervalMs: 300000,
    nextCheckAt: null,
    lastAttempt: null,
    latestCheckId: null,
    latestCaptureId: null,
  };
  const store = {
    readIntent: async () => clone(intent),
    readObservations: async () =>
      unavailable ? { ...history, status: 'unavailable' } : clone(history),
  };
  const change = async (enabled, input) => {
    await gate();
    await input.beforeCommit();
    if (input.expectedRevision !== (intent?.revision ?? null))
      return { status: 409, body: { error: 'monitor-store-stale' } };
    calls[enabled ? 'enable' : 'pause']++;
    intent = {
      revision: (enabled ? '1' : '2').repeat(64),
      record: {
        ...intent?.record,
        ...bound,
        ...input.expectedBound,
        enabled,
        configuredAt: new Date(now).toISOString(),
      },
    };
    Object.assign(state, {
      status: enabled ? 'enabled' : 'disabled',
      runtimeSha256: bound.runtimeSha256,
      revision: intent.revision,
      configuredAt: intent.record.configuredAt,
    });
    return { status: 200, body: clone(state) };
  };
  const scheduler = {
    getState: () => clone(state),
    enable: (input) => change(true, input),
    pause: (input) => change(false, input),
    start: async () => clone(state),
    close: async () => {},
  };
  const control = await createInventoryMonitorControl({
    context,
    store,
    scheduler,
    inventory: {
      read: async () => {
        calls.scans++;
        throw Error('must-not-scan');
      },
    },
    now: () => now,
    mcpEnvironment: environment,
  });
  t.after(() => control.close());
  return {
    control,
    bound,
    environment,
    history,
    calls,
    advance(ms) {
      now += ms;
    },
    unavailable(value) {
      unavailable = value;
    },
    gate(value) {
      gate = value;
    },
  };
}
test('GET and preview only read local metadata and cannot create an opt-in or capture', async (t) => {
  const f = await fixture(t),
    state = await f.control.state();
  assert.equal(state.status, 200);
  assert(schema.validateInventoryMonitorState(state.body));
  assert.equal((await f.control.preview({ action: 'enable', expectedRevision: null })).status, 200);
  assert.equal(f.calls.enable, 0);
  assert.equal(f.calls.scans, 0);
});
test('all three enable acknowledgements precede consuming the exact one-use preview', async (t) => {
  const f = await fixture(t),
    preview = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  assert(schema.validateInventoryMonitorPreview(preview));
  for (const key of ['acknowledgeLocalChecks', 'acknowledgeUserSources', 'acknowledgeRetention'])
    assert.equal((await f.control.apply({ ...confirm(preview), [key]: false })).status, 400);
  const applied = await f.control.apply(confirm(preview));
  assert.equal(applied.status, 200);
  assert(schema.validateInventoryMonitorReceipt(applied.body));
  assert.equal(f.calls.enable, 1);
  assert.equal((await f.control.apply(confirm(preview))).status, 409);
});
test('a preview expiring while waiting cannot enable or be retried', async (t) => {
  const f = await fixture(t),
    preview = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  f.gate(async () => {
    f.advance(120001);
  });
  assert.equal((await f.control.apply(confirm(preview))).status, 409);
  assert.equal(f.calls.enable, 0);
  assert.equal((await f.control.apply(confirm(preview))).status, 409);
});
test('runtime or expected revision drift cannot redirect consent', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control.preview({ action: 'enable', expectedRevision: SHA })).status, 409);
  const preview = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  f.bound.runtimeSha256 = 'b'.repeat(64);
  assert.equal((await f.control.apply(confirm(preview))).status, 409);
  assert.equal(f.calls.enable, 0);
  assert.equal(
    (await f.control.preview({ action: 'enable', expectedRevision: null, path: '/foreign' }))
      .status,
    400,
  );
});
test('pause survives unavailable history and requires fixed false enable acknowledgements', async (t) => {
  const f = await fixture(t),
    enabled = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  await f.control.apply(confirm(enabled));
  f.unavailable(true);
  const state = (await f.control.state()).body;
  const preview = await f.control.preview({ action: 'pause', expectedRevision: state.revision });
  assert.equal(preview.status, 200);
  assert.equal(
    (await f.control.apply({ ...confirm(preview.body), acknowledgeUserSources: true })).status,
    400,
  );
  assert.equal((await f.control.apply(confirm(preview.body))).status, 200);
  assert.equal(f.calls.pause, 1);
  assert.equal(f.calls.scans, 0);
});

test('MCP source-selection profile drift invalidates consent without changing public runtime SHA', async (t) => {
  const f = await fixture(t),
    preview = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  f.environment.XDG_CONFIG_HOME = '/fixture/user/alternate';
  assert.equal((await f.control.apply(confirm(preview))).status, 409);
  assert.equal(f.bound.runtimeSha256, SHA);
  assert.equal(f.calls.enable, 0);
});

test('bounded public history trims oldest versions with explicit omissions and preserves pause authority', async (t) => {
  const f = await fixture(t),
    preview = (await f.control.preview({ action: 'enable', expectedRevision: null })).body;
  await f.control.apply(confirm(preview));
  const segment = 'release guide reference section details notes version overview'.padEnd(63, 'x');
  const rows = Array.from({ length: 64 }, (_, index) => ({
    kind: 'changed',
    artifact: {
      id: 'item-' + index.toString(16).padStart(24, '0'),
      name: 'Release guide '.repeat(16).slice(0, 200),
      kind: 'skill',
      agent: 'claude-code',
      scope: 'project',
      skillSource: 'claude-skills',
      location: { label: Array(8).fill(segment).join('/'), redacted: false },
    },
    beforeSha256: SHA,
    afterSha256: 'b'.repeat(64),
  }));
  const records = Array.from({ length: 16 }, () => ({
    id: randomUUID(),
    firstObservedAt: '2026-10-24T12:00:00.000Z',
    lastObservedAt: '2026-10-24T12:00:00.000Z',
    runtimeSha256: SHA,
    observationSha256: 'c'.repeat(64),
    itemCount: 64,
    complete: true,
    gaps: 0,
    changes: { status: 'comparable', fromId: randomUUID(), total: 64, rows, omitted: 0 },
  }));
  assert(records.every(schema.validateInventoryObservationRecord));
  Object.assign(f.history, {
    status: 'ready',
    revision: 'b'.repeat(64),
    records,
    omitted: 0,
    latestCaptureId: records[0].id,
    latestCheckId: randomUUID(),
  });
  assert(Buffer.byteLength(JSON.stringify(f.history)) > 1024 * 1024);
  const state = (await f.control.state()).body;
  assert(schema.validateInventoryMonitorState(state));
  assert(Buffer.byteLength(JSON.stringify(state)) <= 1024 * 1024);
  assert.equal(state.history.status, 'ready');
  assert(state.history.records.length < 16);
  assert.equal(state.history.omitted, 16 - state.history.records.length);
  assert.equal(f.history.records.length, 16);
  assert.equal(state.revision, '1'.repeat(64));
  const pause = await f.control.preview({ action: 'pause', expectedRevision: state.revision });
  assert.equal(pause.status, 200);
  assert.equal((await f.control.apply(confirm(pause.body))).status, 200);
});
