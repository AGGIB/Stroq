import test from 'node:test';
import assert from 'node:assert/strict';
import { pathGuardHarness } from './codex-path-guard-client-harness.mjs';
import * as f from './codex-path-guard-client-fixtures.mjs';
async function setup() {
  const h = pathGuardHarness(true);
  h.render();
  await h.flush();
  return h;
}
async function review(h, preset = 'aws-credentials') {
  await h.output.inspect();
  await h.flush();
  await h.output.prepare(preset);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
}
test('open reads history once; inspection, preview and writes are never automatic', async () => {
  const h = pathGuardHarness();
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.control.open = true;
  h.render();
  await h.flush();
  assert.deepEqual(
    h.calls.map((c) => [c.path, c.body]),
    [['/api/codex-path-guard', undefined]],
  );
  h.unmount();
});
test('manual capture and one selected preset bind preview without transmitting paths', async () => {
  const h = await setup();
  await h.output.inspect();
  await h.flush();
  await h.output.prepare('aws-credentials');
  await h.flush();
  assert.deepEqual(h.calls.at(-1).body, {
    operation: 'guard',
    controlContextId: f.context,
    captureSha256: f.binding().captureSha256,
    presetId: 'aws-credentials',
  });
  assert(h.output.preview);
  assert.equal(h.output.canApply, false);
  assert.doesNotMatch(JSON.stringify(h.calls), /~\//);
  h.unmount();
});
test('apply consumes preview once, requires acknowledgements and confirms exact preset', async () => {
  const h = await setup();
  await review(h);
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 1);
  assert.deepEqual(h.calls.at(-1).body, {
    previewId: f.id(8),
    controlContextId: f.context,
    acknowledgeSharedUserConfig: true,
    acknowledgeRetention: true,
  });
  assert.equal(h.output.receipt.writeConfirmed, true);
  assert.equal(h.output.capture, null);
  assert.equal(h.output.pending.length, 0);
  h.unmount();
});
test('restore requires exact retained record and weakening; superseded cannot restore', async () => {
  const h = await setup();
  h.control.state = f.state([f.record()]);
  await h.output.refresh();
  await h.flush();
  await h.output.prepareRestore(f.record({ ownership: 'superseded', canRestore: false }));
  assert.equal(h.calls.length, 2);
  h.control.preview = f.preview(true);
  h.control.receipt = f.receipt('restore');
  await h.output.prepareRestore(h.output.state.records[0]);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  assert.equal(h.output.canApply, false);
  h.output.acknowledge('weakening', true);
  await h.flush();
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.at(-1).body.acknowledgeWeakening, true);
  assert.equal(h.output.receipt.record.operationStatus, 'restored');
  h.unmount();
});
test('failed apply remains unknown across missing history and only exact recheck clears it', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.fail = false;
  h.control.state = f.state();
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.state = f.state([f.record()]);
  await h.output.refresh();
  await h.flush();
  h.control.receipt = f.receipt('recheck');
  await h.output.recheck(h.output.state.records[0]);
  await h.flush();
  assert.equal(h.output.pending.length, 0);
  assert.deepEqual(h.calls.at(-1).body, {
    controlContextId: f.context,
    recordId: f.id(1),
    recordRevision: '2'.repeat(64),
    operationId: f.id(2),
  });
  h.unmount();
});
test('wrong preset or metadata preview is rejected and arbitrary errors stay private', async () => {
  for (const patch of [
    { presetId: 'npmrc' },
    { binding: { ...f.binding(), targetMetadataSha256: '0'.repeat(64) } },
  ]) {
    const h = await setup();
    h.control.preview = { ...f.preview(), ...patch };
    await review(h);
    assert.equal(h.output.preview, null);
    assert.doesNotMatch(h.output.error ?? '', /PRIVATE/);
    h.unmount();
  }
});
test('foreign receipt never confirms an unknown apply, and absence cannot clear it', async () => {
  const h = await setup();
  await review(h);
  h.control.receipt = { ...f.receipt(), record: { ...f.record(), presetId: 'npmrc' } };
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.receipt, null);
  assert.equal(h.output.pending.length, 1);
  h.unmount();
});
test('closing during apply preserves unknown intent and ignores late receipt', async () => {
  const h = await setup();
  await review(h);
  h.control.hold = true;
  const pending = h.output.apply();
  h.control.open = false;
  h.render();
  await h.flush();
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.receipt, null);
  assert.equal(h.client.codexPathGuardPending(h.platform.requestLocal).size, 1);
  h.unmount();
});
test('preview expiry clears consent and never auto-retries', async () => {
  const h = await setup();
  await review(h);
  const count = h.calls.length;
  await h.advance(120001);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.canApply, false);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('unavailable history prevents preview even with a valid capture', async () => {
  const h = await setup();
  h.control.state = {
    ...f.state(),
    available: false,
    history: 'unavailable',
    error: 'codex-path-guard-store-unavailable',
  };
  await h.output.refresh();
  await h.flush();
  await h.output.inspect();
  await h.flush();
  assert.equal(h.output.canPrepare, false);
  const count = h.calls.length;
  await h.output.prepare('aws-credentials');
  await h.flush();
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('history admission and manual capture share one client operation slot', async () => {
  const h = pathGuardHarness(true);
  h.control.hold = true;
  h.render();
  await h.flush();
  await h.output.inspect();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/codex-path-guard');
  h.release();
  await h.flush();
  assert(h.output.state);
  h.unmount();
});
test('timed-out apply stays unknown and late successful response never repairs it', async () => {
  const h = await setup();
  await review(h);
  h.control.hold = true;
  const pending = h.output.apply();
  await h.advance(60001);
  assert.equal(h.calls.at(-1).signal.aborted, true);
  assert.equal(h.output.pending.length, 1);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.receipt, null);
  assert.equal(h.output.pending.length, 1);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 1);
  h.unmount();
});
test('recheck cannot use a later operation to confirm an earlier unknown', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  h.control.state = f.state([f.record({ operationId: f.id(77) })]);
  await h.output.refresh();
  await h.flush();
  const count = h.calls.length;
  await h.output.recheck(h.output.state.records[0]);
  await h.flush();
  assert.equal(h.calls.length, count);
  assert.equal(h.output.pending.length, 1);
  h.unmount();
});
