import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inventoryMonitorHarness,
  workspace,
  foreignWorkspace,
  runtime,
  revision,
  uuid,
} from './inventory-monitor-client-harness.mjs';

import {
  inventoryMonitorFixtures as fixtures,
  observedState,
  observation,
} from './inventory-monitor-fixtures.mjs';
const harness = () => inventoryMonitorHarness(fixtures);
async function start(h) {
  h.render();
  await h.flush();
}
async function prepare(h, action = 'enable') {
  await h.output.prepare(action);
  await h.flush();
}
async function consent(h) {
  h.output.acknowledge('localChecks', true);
  h.output.acknowledge('userSources', true);
  h.output.acknowledge('retention', true);
  await h.flush();
}

test('opening and refreshing use only GET; off watch never schedules checks', async () => {
  const h = harness();
  await start(h);
  assert.equal(h.output.state?.status, 'disabled');
  await h.advance(600000);
  assert.equal(h.calls.length, 1);
  h.output.refresh();
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.ok(
    h.calls.every((call) => call.path === '/api/inventory-monitor' && call.body === undefined),
  );
  h.unmount();
});
test('explicit preview and all three consents precede one apply; paths and runtime stay server selected', async () => {
  const h = harness();
  await start(h);
  await prepare(h);
  assert.ok(h.output.preview);
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 0);
  h.output.acknowledge('localChecks', true);
  await h.flush();
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 0);
  const id = h.output.preview.id;
  await consent(h);
  await h.output.apply();
  await h.flush();
  const writes = h.calls.filter((call) => call.operation === 'apply');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    previewId: id,
    confirm: true,
    acknowledgeLocalChecks: true,
    acknowledgeUserSources: true,
    acknowledgeRetention: true,
  });
  assert.equal(h.output.needsRecheck, false);
  h.unmount();
});
test('held mutation stays unknown across genuine unmount/remount and ignores late acknowledgement', async () => {
  const h = harness();
  await start(h);
  await prepare(h);
  await consent(h);
  h.control.hold = 'apply';
  const pending = h.output.apply();
  await h.flush();
  const signal = h.calls.at(-1).signal;
  h.remount();
  h.control.hold = '';
  await h.flush();
  assert.equal(signal.aborted, true);
  assert.equal(h.output.needsRecheck, true);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  await prepare(h);
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 1);
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
  h.unmount();
});
test('timeout ends busy; malformed automatic reads never clear uncertain write and never retry apply', async () => {
  const h = harness();
  await start(h);
  await prepare(h);
  await consent(h);
  h.control.hold = 'apply';
  const pending = h.output.apply();
  await h.flush();
  await h.advance(35000);
  assert.equal(h.output.busy, null);
  assert.equal(h.output.needsRecheck, true);
  h.control.hold = '';
  h.control.bad = 'load';
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  assert.ok(h.output.error);
  assert.equal(h.output.error.includes('UNEXPECTED_FIELD'), false);
  h.control.bad = '';
  h.control.state = { ...fixtures.state(), runtimeSha256: 'f'.repeat(64) };
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.state = fixtures.state();
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 1);
  h.unmount();
});
test('synchronous A→B→A context/connection changes reject ignored-abort previews before effects', async () => {
  for (const change of ['workspace', 'context', 'connection']) {
    const h = harness();
    await start(h);
    h.control.hold = 'preview';
    const pending = h.output.prepare('enable');
    await h.flush();
    const oldContext = h.platform.localContext,
      oldRequest = h.platform.requestLocal;
    if (change === 'connection') h.platform.requestLocal = (...args) => oldRequest(...args);
    else
      h.platform.localContext = {
        workspace: { id: change === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    h.platform.localContext = oldContext;
    h.platform.requestLocal = oldRequest;
    h.render(false);
    h.control.hold = '';
    h.release();
    await pending;
    h.render(false);
    assert.equal(h.output.preview, null);
    await h.flush();
    h.unmount();
  }
});
test('retained handlers cannot send after unmount; StrictMode re-entry reads without an action', async () => {
  const h = harness();
  await start(h);
  await prepare(h);
  await consent(h);
  const old = h.output;
  h.unmount();
  const count = h.calls.length;
  await old.apply();
  await old.prepare('pause');
  old.refresh();
  assert.equal(h.calls.length, count);
  h.reenterEffects();
  await h.flush();
  assert.equal(h.calls.length, count + 1);
  assert.equal(h.calls.at(-1).body, undefined);
  assert.equal(h.output.preview, null);
  h.unmount();
});
test('closing preview cancels stale handlers and expiry clears consent', async () => {
  const h = harness();
  await start(h);
  await prepare(h);
  await consent(h);
  const old = h.output;
  old.invalidate();
  await h.flush();
  const count = h.calls.length;
  await old.apply();
  assert.equal(h.calls.length, count);
  assert.equal(h.output.preview, null);
  await prepare(h);
  await consent(h);
  await h.advance(120000);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.ack.localChecks, false);
  assert.equal(h.output.ack.retention, false);
  h.unmount();
});
test('polls state only while enabled and stops after three failed reads', async () => {
  const h = harness();
  h.control.state = {
    ...fixtures.state(),
    status: 'enabled',
    nextCheckAt: '2026-10-24T01:05:00.000Z',
  };
  await start(h);
  await h.advance(10000);
  assert.equal(h.calls.length, 2);
  h.control.bad = 'load';
  await h.advance(60000);
  assert.equal(h.output.pollStopped, true);
  const count = h.calls.length;
  await h.advance(60000);
  assert.equal(h.calls.length, count);
  assert.ok(h.calls.every((call) => call.body === undefined));
  h.unmount();
});
test('disabled selection, lost access and foreign replies cannot provide controls or evidence', async () => {
  const h = harness();
  h.props.enabled = false;
  await start(h);
  assert.equal(h.calls.length, 0);
  h.update({ enabled: true });
  await h.flush();
  assert.ok(h.output.state);
  h.platform.localAccess = false;
  h.render();
  await h.flush();
  assert.equal(h.output.state, null);
  const count = h.calls.length;
  await h.output.prepare('enable');
  h.output.refresh();
  assert.equal(h.calls.length, count);
  h.platform.localAccess = true;
  h.control.state = { ...fixtures.state(), workspaceId: foreignWorkspace };
  h.render();
  await h.flush();
  assert.equal(h.output.state, null);
  assert.ok(h.output.error);
  h.unmount();
});
test('pause still requires an explicit fresh preview but no enable consents', async () => {
  const h = harness();
  h.control.state = {
    ...fixtures.state(),
    status: 'enabled',
    nextCheckAt: '2026-10-24T01:05:00.000Z',
  };
  await start(h);
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 0);
  await prepare(h, 'pause');
  const id = h.output.preview.id;
  h.control.receipt = {
    ...fixtures.receipt({}, Date.parse('2026-10-24T01:00:00.000Z')),
    previewId: id,
    action: 'pause',
    enabled: false,
  };
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 1);
  assert.deepEqual(h.calls.find((call) => call.operation === 'apply').body, {
    previewId: id,
    confirm: true,
    acknowledgeLocalChecks: false,
    acknowledgeUserSources: false,
    acknowledgeRetention: false,
  });
  assert.equal(h.output.needsRecheck, false);
  h.unmount();
});
test('wrong preview receipts cannot clear uncertain completion', async () => {
  for (const mismatch of ['previewId', 'action', 'runtimeSha256', 'workspaceId']) {
    const h = harness();
    await start(h);
    await prepare(h);
    await consent(h);
    const good = {
      ...fixtures.receipt({}, Date.parse('2026-10-24T01:00:00.000Z')),
      previewId: h.output.preview.id,
    };
    h.control.receipt = {
      ...good,
      [mismatch]:
        mismatch === 'previewId'
          ? uuid(999)
          : mismatch === 'action'
            ? 'pause'
            : mismatch === 'workspaceId'
              ? foreignWorkspace
              : 'f'.repeat(64),
    };
    await h.output.apply();
    await h.flush();
    assert.equal(h.output.needsRecheck, true);
    assert.ok(h.output.error);
    assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 1);
    h.unmount();
  }
});
test('a persisted watch can pause without an available runtime or lease while enable remains refused', async () => {
  for (const status of ['needs-review', 'in-use', 'unavailable']) {
    const h = harness();
    h.control.state = {
      ...fixtures.state(),
      status,
      runtimeSha256: null,
      reason: status === 'in-use' ? 'monitor-in-use' : 'runtime-unavailable',
    };
    await start(h);
    await prepare(h, 'enable');
    assert.equal(h.calls.filter((call) => call.operation === 'preview').length, 0);
    await prepare(h, 'pause');
    assert.ok(h.output.preview, `${status} preserves an explicit pause path`);
    assert.equal(h.output.preview.runtimeSha256, runtime);
    assert.deepEqual(h.calls.at(-1).body, { action: 'pause', expectedRevision: revision });
    const id = h.output.preview.id;
    h.control.receipt = {
      ...fixtures.receipt({ previewId: id }, Date.parse('2026-10-24T01:00:00.000Z')),
      action: 'pause',
      enabled: false,
    };
    await h.output.apply();
    await h.flush();
    assert.equal(h.calls.filter((call) => call.operation === 'apply').length, 1);
    assert.equal(h.output.needsRecheck, false);
    h.unmount();
  }
});
test('a missing or unverified watch revision cannot become a pause mutation', async () => {
  const h = harness();
  h.control.state = {
    ...fixtures.state(),
    status: 'unavailable',
    runtimeSha256: null,
    revision: null,
    configuredAt: null,
    reason: 'runtime-unavailable',
  };
  await start(h);
  await prepare(h, 'pause');
  assert.equal(h.output.preview, null);
  assert.equal(h.calls.length, 1);
  h.unmount();
});
test('only a newly accepted check identity requests fresh inventory, even when its semantic capture coalesces', async () => {
  const h = harness();
  h.control.state = observedState();
  await start(h);
  assert.deepEqual(h.captures, [], 'Initial metadata does not duplicate the page inventory read');
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  h.control.state.history.records[0].lastObservedAt = '2026-10-24T01:00:20.000Z';
  await h.advance(10000);
  assert.deepEqual(h.captures, [], 'A clock update alone is not an accepted check');
  h.control.state.latestCheckId = uuid(502);
  await h.advance(10000);
  assert.deepEqual(h.captures, [uuid(502)]);
  assert.equal(h.output.state.latestCaptureId, uuid(500));
  await h.advance(20000);
  assert.deepEqual(h.captures, [uuid(502)]);
  assert(
    h.calls.every((call) => call.path === '/api/inventory-monitor' && call.body === undefined),
  );
  h.unmount();
});
test('source refresh waits for the review or containment to become idle and coalesces intervening checks', async () => {
  const h = harness();
  h.control.state = observedState();
  await start(h);
  h.props.canRefresh = false;
  h.render();
  h.control.state.latestCheckId = uuid(502);
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  h.control.state.latestCheckId = uuid(503);
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  h.props.canRefresh = true;
  h.render();
  await h.flush();
  assert.deepEqual(h.captures, [uuid(503)]);
  await h.advance(10000);
  assert.deepEqual(h.captures, [uuid(503)]);
  h.unmount();
});
test('the first capture after an initially empty saved history requests current evidence once', async () => {
  const h = harness();
  h.control.state = { ...fixtures.state(), status: 'enabled' };
  await start(h);
  h.control.state = observedState();
  await h.advance(10000);
  assert.deepEqual(h.captures, [uuid(501)]);
  h.unmount();
});
test('failed, malformed and foreign monitor reads never trigger fresh inventory or replace valid history', async () => {
  const h = harness();
  h.control.state = observedState();
  await start(h);
  const before = h.output.state;
  h.control.state.latestCheckId = uuid(502);
  h.control.bad = 'load';
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  assert.equal(h.output.state, before);
  assert.equal(h.output.freshness, 'historical');
  h.control.bad = '';
  h.control.state.workspaceId = foreignWorkspace;
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  h.control.state = {
    ...observedState(),
    lastAttempt: {
      status: 'failed',
      startedAt: '2026-10-24T01:00:00.000Z',
      finishedAt: '2026-10-24T01:00:01.000Z',
      checkId: uuid(504),
      captureId: null,
      error: 'inventory-unavailable',
    },
  };
  await h.advance(10000);
  assert.deepEqual(h.captures, []);
  assert.equal(h.output.state.lastAttempt.status, 'failed');
  h.unmount();
});
test('unavailable saved history preserves the last accepted captures only as historical read-only evidence', async () => {
  const h = harness();
  h.control.state = observedState();
  await start(h);
  const before = h.output.state;
  h.control.state = {
    ...fixtures.state(),
    status: 'unavailable',
    reason: 'observation-store-unavailable',
    history: { status: 'unavailable', revision: null, records: [], omitted: 0 },
  };
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.state.history.status, 'unavailable');
  assert.equal(h.output.historyState, before);
  assert.equal(h.output.historyHistorical, true);
  assert.deepEqual(h.captures, []);
  h.unmount();
});
