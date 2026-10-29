import test from 'node:test';
import assert from 'node:assert/strict';
import { networkHarness } from './codex-network-client-harness.mjs';
import * as f from './codex-network-client-fixtures.mjs';
async function setup() {
  const h = networkHarness(true);
  h.render();
  await h.flush();
  return h;
}
async function inspect(h) {
  await h.output.guard.inspect();
  await h.flush();
}
async function review(h) {
  await inspect(h);
  await h.output.guard.prepare();
  await h.flush();
  h.output.guard.acknowledge('shared', true);
  h.output.guard.acknowledge('retention', true);
  await h.flush();
}
test('opening serially reads two histories, never captures config or starts Codex', async () => {
  const h = networkHarness();
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.control.open = true;
  h.render();
  await h.flush();
  assert.deepEqual(
    h.calls.map((c) => c.path),
    ['/api/codex-network-guard', '/api/codex-network-checks'],
  );
  assert(h.calls.every((c) => c.body === undefined));
  h.unmount();
});
test('manual inspection is separate and guard preview binds the exact capture', async () => {
  const h = await setup();
  await inspect(h);
  assert.equal(h.output.guard.capture.baseline.network, 'on');
  assert.deepEqual(h.calls.at(-1).body, {});
  await h.output.guard.prepare();
  await h.flush();
  assert.equal(h.output.guard.preview.id, f.id(2));
  assert.deepEqual(h.calls.at(-1).body, {
    operation: 'guard',
    controlContextId: f.context,
    captureSha256: f.binding().captureSha256,
  });
  assert.equal(h.output.guard.canApply, false);
  h.unmount();
});
test('guard apply requires contextual acknowledgements and never fabricates native proof', async () => {
  const h = await setup();
  await review(h);
  assert.equal(h.output.guard.canApply, true);
  await h.output.guard.apply();
  await h.flush();
  assert.equal(h.output.guard.receipt.writeConfirmed, true);
  assert.equal(h.output.guard.receipt.record.hostEnforcement, false);
  assert.equal(h.output.guard.capture, null);
  assert.equal(h.output.checks.preview, null);
  assert.deepEqual(h.calls.at(-1).body, {
    previewId: f.id(2),
    controlContextId: f.context,
    acknowledgeSharedUserConfig: true,
    acknowledgeRetention: true,
  });
  h.unmount();
});
test('restore requires weakening and superseded records have no restore authority', async () => {
  const h = await setup();
  await h.output.guard.prepareRestore(f.record({ ownership: 'superseded', canRestore: false }));
  assert.equal(h.calls.length, 2);
  h.control.preview = f.preview(true);
  h.control.receipt = f.receipt('restore');
  await h.output.guard.prepareRestore(f.record());
  await h.flush();
  h.output.guard.acknowledge('shared', true);
  h.output.guard.acknowledge('retention', true);
  await h.flush();
  assert.equal(h.output.guard.canApply, false);
  h.output.guard.acknowledge('weakening', true);
  await h.flush();
  await h.output.guard.apply();
  await h.flush();
  assert.equal(h.calls.at(-1).body.acknowledgeWeakening, true);
  h.unmount();
});
test('unknown config apply survives missing GET and clears only exact explicit recheck', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.guard.apply();
  await h.flush();
  assert.equal(h.output.guard.pending.length, 1);
  h.control.fail = false;
  await h.output.guard.refresh();
  await h.flush();
  assert.equal(h.output.guard.pending.length, 1);
  h.control.state = f.state([f.record()]);
  await h.output.guard.refresh();
  await h.flush();
  h.control.receipt = f.receipt('recheck');
  await h.output.guard.recheck(h.output.guard.state.records[0]);
  await h.flush();
  assert.equal(h.output.guard.pending.length, 0);
  h.unmount();
});
test('already-off default can check without a Guard record; preview never starts a job', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  assert.equal(h.output.guard.capture.canGuard, false);
  await h.output.checks.prepare();
  await h.flush();
  assert.equal(h.output.checks.preview.jobId, f.id(4));
  assert.equal(h.calls.filter((c) => c.path.endsWith('/start')).length, 0);
  assert.deepEqual(h.calls.at(-1).body, {
    controlContextId: f.context,
    captureSha256: f.binding().captureSha256,
  });
  h.unmount();
});
test('explicit Run starts fixed check without fake acknowledgements and polls genuine progress', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  await h.output.checks.start();
  await h.flush();
  assert.deepEqual(h.calls.at(-1).body, { previewId: f.id(3), controlContextId: f.context });
  assert.equal(h.output.checks.job.status, 'running');
  h.control.checks = f.checkState([f.job('completed')]);
  await h.advance(1500);
  assert.equal(h.output.checks.job.result.outcome, 'passed');
  assert.equal(h.output.checks.job.result.scope, 'isolated-permission-copy');
  h.unmount();
});
test('lost start response remains exact unknown through empty history and no auto retry', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  h.control.failPath = '/api/codex-network-checks/start';
  await h.output.checks.start();
  await h.flush();
  assert.equal(h.output.checks.pending.length, 1);
  h.control.failPath = null;
  await h.output.checks.refresh(true);
  await h.flush();
  assert.equal(h.output.checks.pending.length, 1);
  await h.output.checks.start();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/start')).length, 1);
  h.control.checks = f.checkState([f.job('completed')]);
  await h.output.checks.refresh(true);
  await h.flush();
  assert.equal(h.output.checks.pending.length, 0);
  h.unmount();
});
test('wrong capture or native binary preview cannot become actionable', async () => {
  for (const kind of ['guard', 'check']) {
    const h = await setup();
    h.control.capture = f.capture(kind === 'check');
    await inspect(h);
    if (kind === 'guard') h.control.preview.binding.captureSha256 = '9'.repeat(64);
    else h.control.checkPreview.binding.nativeBinarySha256 = '9'.repeat(64);
    await h.output[kind === 'guard' ? 'guard' : 'checks'].prepare();
    await h.flush();
    assert.equal(h.output[kind === 'guard' ? 'guard' : 'checks'].preview, null);
    assert.ok(h.output.error);
    assert.doesNotMatch(h.output.error, /PRIVATE/);
    h.unmount();
  }
});
test('failed history refresh invalidates current config standing instead of retaining a fresh claim', async () => {
  const h = await setup();
  h.control.failPath = '/api/codex-network-guard';
  await h.output.guard.refresh();
  await h.flush();
  assert.equal(h.output.guard.state, null);
  assert.ok(h.output.error);
  h.unmount();
});
test('shared request slot prevents native preview racing manual configuration inspection', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  h.control.hold = true;
  const pending = h.output.guard.inspect();
  await h.flush();
  await h.output.checks.prepare();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/capture')).length, 2);
  assert.equal(h.calls.filter((c) => c.path === '/api/codex-network-checks/preview').length, 0);
  h.release();
  await pending;
  await h.flush();
  h.unmount();
});
test('both previews expire without replaying writes or starting a native process', async () => {
  for (const type of ['guard', 'checks']) {
    const h = await setup();
    if (type === 'guard') await review(h);
    else {
      h.control.capture = f.capture(true);
      await inspect(h);
      await h.output.checks.prepare();
      await h.flush();
    }
    await h.advance(120010);
    assert.equal(h.output[type].preview, null);
    const count = h.calls.length;
    await (type === 'guard' ? h.output.guard.apply() : h.output.checks.start());
    assert.equal(h.calls.length, count);
    h.unmount();
  }
});
test('explicit cancel binds exact job/context/operation and retains cleanup result', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  await h.output.checks.start();
  await h.flush();
  h.control.job = f.job('cancelled');
  await h.output.checks.cancel();
  await h.flush();
  assert.deepEqual(h.calls.at(-1).body, {
    jobId: f.id(4),
    controlContextId: f.context,
    operationId: f.id(3),
  });
  assert.equal(h.output.checks.job.status, 'cancelled');
  assert.equal(h.output.checks.job.result, null);
  h.unmount();
});
test('unknown cancel cannot be cleared by running or unrelated history, only an exact terminal job', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  await h.output.checks.start();
  await h.flush();
  h.control.failPath = '/api/codex-network-checks/cancel';
  await h.output.checks.cancel();
  await h.flush();
  assert.equal(h.output.checks.pending.length, 1);
  h.control.failPath = null;
  h.control.checks = f.checkState([f.job()]);
  await h.output.checks.refresh(true);
  await h.flush();
  assert.equal(h.output.checks.pending.length, 1);
  h.control.checks = f.checkState([f.job('cancelled')]);
  await h.output.checks.refresh(true);
  await h.flush();
  assert.equal(h.output.checks.pending.length, 0);
  h.unmount();
});
test('three poll failures stop background updates without starting another check', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  await h.output.checks.start();
  await h.flush();
  h.control.failPath = '/api/codex-network-checks';
  for (let i = 0; i < 3; i++) await h.advance(1500);
  assert.equal(h.output.checks.pollFailures, 3);
  const count = h.calls.length;
  await h.advance(60000);
  assert.equal(h.calls.length, count);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/start')).length, 1);
  h.unmount();
});
test('synchronous A→B→A context changes discard late config and native previews', async () => {
  for (const type of ['guard', 'checks']) {
    const h = await setup();
    h.control.capture = f.capture(type === 'checks');
    await inspect(h);
    h.control.hold = true;
    const pending = h.output[type].prepare();
    await h.flush();
    const context = h.platform.localContext;
    h.platform.localContext = { workspace: { id: f.workspace } };
    h.render(false);
    h.platform.localContext = context;
    h.render(false);
    h.release();
    await pending;
    h.render(false);
    assert.equal(h.output[type].preview, null);
    await h.flush();
    h.unmount();
  }
});
test('unmount aborts an in-flight native start and preserves the exact unknown attempt', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  await h.output.checks.prepare();
  await h.flush();
  h.control.hold = true;
  const pending = h.output.checks.start();
  await h.flush();
  h.unmount();
  assert.equal(h.calls.at(-1).signal.aborted, true);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.client.codexNetworkCheckPending(h.platform.requestLocal).size, 1);
});
