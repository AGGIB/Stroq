import test from 'node:test';
import assert from 'node:assert/strict';
import { signalHarness, workspace } from './inventory-signal-client-harness.mjs';
async function start(h) {
  h.render();
  await h.flush();
}
async function plan(h, decision = 'accepted-risk', reason = 'required-use') {
  await h.output.prepare(decision, reason);
  await h.flush();
}
async function ack(h) {
  h.output.acknowledge(true);
  await h.flush();
}

test('the actual provider allowlist rejects unsupported signal routes before the emulated HTTP boundary', async () => {
  const h = signalHarness();
  for (const path of [
    '/api/inventory/signals/state/extra',
    '/api/inventory/signals/state?token=private',
    'https://foreign.invalid/api/inventory/signals/state',
  ])
    await assert.rejects(h.platform.requestLocal(path, {}), /Unsupported local operation/);
  assert.deepEqual(h.calls, []);
  await start(h);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/inventory/signals/state');
  assert.equal(h.output.state.standing, 'unresolved');
  h.unmount();
});

test('a deferred comparison selection sends no signal read until the dialog admits its exact artifact', async () => {
  const h = signalHarness(),
    selected = h.props.item;
  h.props.item = null;
  await start(h);
  assert.deepEqual(h.calls, []);
  assert.equal(h.output.state, null);
  h.props.item = selected;
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].operation, 'load');
  assert.equal(h.output.state.artifact.id, selected.id);
  h.unmount();
});

test('opening only reads exact signal state; explicit matching preview and acknowledgement precede one apply', async () => {
  const h = signalHarness();
  await start(h);
  assert.equal(h.output.state.standing, 'unresolved');
  assert.deepEqual(
    h.calls.map((c) => c.operation),
    ['load'],
  );
  assert.deepEqual(h.calls[0].body, { id: h.props.item.id, expectedSha256: h.props.item.sha256 });
  await plan(h);
  assert.ok(h.output.preview);
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 0);
  await ack(h);
  const retained = h.output.apply;
  await retained();
  await retained();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 1);
  assert.deepEqual(Object.keys(h.calls.find((c) => c.operation === 'apply').body).sort(), [
    'acknowledgeSignalOnly',
    'previewId',
  ]);
  assert.equal(h.output.state.standing, 'applies');
  assert.equal(h.output.state.decision.decision, 'accepted-risk');
  assert.equal(h.changed.length, 1);
  h.unmount();
});
test('false positive and reopen are explicit decisions with fixed matching reasons', async () => {
  const h = signalHarness();
  await start(h);
  await plan(h, 'false-positive', 'required-use');
  assert.equal(h.output.preview, null);
  await plan(h, 'false-positive', 'test-or-example');
  await ack(h);
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.state.decision.decision, 'false-positive');
  await plan(h, 'reopened', 'reconsidered');
  await ack(h);
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.state.standing, 'reopened');
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 2);
  h.unmount();
});
test('incomplete state cannot prepare a dismissal and foreign or malformed reads never become authoritative', async () => {
  const h = signalHarness();
  Object.assign(h.control.state, { binding: null, eligible: false, reason: 'incomplete' });
  await start(h);
  assert.equal(h.output.state.reason, 'incomplete');
  await plan(h);
  assert.equal(h.calls.length, 1);
  h.control.bad = 'load';
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.state, null);
  assert.ok(h.output.error);
  h.control.bad = '';
  h.control.state = h.stateFor();
  h.control.state.workspaceId = `workspace-${'0'.repeat(24)}`;
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.state, null);
  h.unmount();
});
test('analysis/source drift in a separately valid preview is refused and no consent survives', async () => {
  for (const field of ['analysisSha256', 'sourceSha256']) {
    const h = signalHarness();
    await start(h);
    h.control.state.binding[field] = '1'.repeat(64);
    await plan(h);
    assert.equal(h.output.preview, null);
    assert.ok(h.output.error);
    assert.equal(h.output.acknowledged, false);
    h.unmount();
  }
});
test('unknown apply survives genuine remount and late receipt; only an explicit verified state read clears it', async () => {
  const h = signalHarness();
  await start(h);
  await plan(h);
  await ack(h);
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
  await plan(h);
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 1);
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
  assert.equal(h.output.state.standing, 'applies');
  h.unmount();
});
test('timeout ends busy without retrying a consumed nonce, and invalid rechecks cannot clear uncertainty', async () => {
  const h = signalHarness();
  await start(h);
  await plan(h);
  await ack(h);
  h.control.hold = 'apply';
  const pending = h.output.apply();
  await h.flush();
  await h.advance(35000);
  assert.equal(h.output.busy, null);
  assert.equal(h.output.needsRecheck, true);
  assert.equal(h.output.preview, null);
  h.control.hold = '';
  h.control.bad = 'load';
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, true);
  h.control.bad = '';
  h.output.refresh();
  await h.flush();
  assert.equal(h.output.needsRecheck, false);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 1);
  h.unmount();
});
test('A→B→A source, context and transport changes reject late previews before effects', async () => {
  for (const change of ['source', 'context', 'transport']) {
    const h = signalHarness();
    await start(h);
    h.control.hold = 'preview';
    const pending = h.output.prepare('accepted-risk', 'required-use');
    await h.flush();
    const old = {
      item: h.props.item,
      context: h.platform.localContext,
      transport: h.platform.requestLocal,
    };
    if (change === 'source')
      h.props.item = { ...old.item, agent: 'codex', skillSource: 'codex-skills' };
    if (change === 'context') h.platform.localContext = { workspace: { id: workspace } };
    if (change === 'transport') h.platform.requestLocal = (...args) => old.transport(...args);
    h.render(false);
    h.props.item = old.item;
    h.platform.localContext = old.context;
    h.platform.requestLocal = old.transport;
    h.render(false);
    h.release();
    await pending;
    h.render(false);
    assert.equal(h.output.preview, null);
    await h.flush();
    h.unmount();
  }
});
test('preview expiry, cancel and unmounted callbacks cannot apply retained consent', async () => {
  const h = signalHarness();
  await start(h);
  await plan(h);
  await ack(h);
  const old = h.output;
  old.invalidate();
  await h.flush();
  await old.apply();
  assert.equal(h.calls.filter((c) => c.operation === 'apply').length, 0);
  await plan(h);
  await ack(h);
  await h.advance(120000);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.acknowledged, false);
  const last = h.output,
    count = h.calls.length;
  h.unmount();
  await last.prepare('accepted-risk', 'required-use');
  last.refresh();
  await last.apply();
  assert.equal(h.calls.length, count);
  h.reenterEffects();
  await h.flush();
  assert.equal(h.calls.at(-1).operation, 'load');
  assert.equal(h.output.preview, null);
  h.unmount();
});
