import test from 'node:test';
import assert from 'node:assert/strict';
import { controlsHarness } from './codex-skill-controls-client-harness.mjs';
import {
  sourceReport,
  controlRecord,
  controlReceipt,
  controlState,
  controlPreview,
  contextId,
  otherContextId,
} from './codex-skill-controls-client-fixtures.mjs';
const target = () => {
  const report = sourceReport();
  return { report, item: report.items[0] };
};
async function setup() {
  const h = controlsHarness();
  h.render();
  await h.flush();
  return h;
}
test('closed dialog reads nothing; opening performs one state read and no native source capture', async () => {
  const h = controlsHarness(false);
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.control.enabled = true;
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body, undefined);
  assert.equal(h.calls[0].path, '/api/inventory/codex-controls');
  h.unmount();
});
test('disable preview is exact candidate/config/runtime-bound and never applies on preview alone', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  assert.equal(h.output.preview.binding.candidateId, item.id);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.at(-1).body, {
    operation: 'disable',
    controlContextId: contextId,
    sourceId: item.sourceId,
    candidateId: item.id,
    expectedEntrypointSha256: item.entrypointSha256,
    expectedConfigSha256: report.settings.sha256,
    expectedRuntimeSha256: report.runtimeSha256,
  });
  assert.equal(h.output.canApply, false);
  await h.output.apply();
  assert.equal(h.calls.length, 2);
  h.unmount();
});
test('wrong context, candidate, runtime or expired preview cannot become an actionable plan', async () => {
  for (const change of ['context', 'candidate', 'runtime', 'expiry']) {
    const h = await setup(),
      { report, item } = target();
    if (change === 'context') h.control.preview.controlContextId = otherContextId;
    if (change === 'candidate')
      h.control.preview.binding.candidateId = 'candidate-' + 'f'.repeat(24);
    if (change === 'runtime') h.control.preview.binding.runtimeSha256 = 'f'.repeat(64);
    if (change === 'expiry') {
      h.control.preview.createdAt = new Date(Date.now() - 240000).toISOString();
      h.control.preview.expiresAt = new Date(Date.now() - 120000).toISOString();
    }
    await h.output.prepareDisable(report, item);
    await h.flush();
    assert.equal(h.output.preview, null, change);
    assert.ok(h.output.error);
    assert.doesNotMatch(h.output.error, /PRIVATE/);
    h.unmount();
  }
});
test('apply requires explicit acknowledgements, consumes plan and matches its exact receipt', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.preview, null);
  assert.equal(h.output.completion.writeConfirmed, true);
  assert.equal(h.control.changed, 1);
  assert.deepEqual(h.calls.at(-1).body, {
    controlContextId: contextId,
    previewId: h.control.preview.id,
    acknowledgeSharedUserConfig: true,
    acknowledgeRetention: true,
  });
  assert.equal(h.output.pending.length, 0);
  await h.output.apply();
  assert.equal(h.calls.length, 3);
  h.unmount();
});
test('restore requires separate weakening consent and preserves prior declaration semantics', async () => {
  const h = await setup(),
    record = controlRecord();
  h.control.preview = controlPreview('restore');
  h.control.receipt = controlReceipt('restore');
  await h.output.prepareRestore(record);
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
  assert.equal(h.output.completion.record.operationStatus, 'restored');
  h.unmount();
});
test('failed apply stays unknown across close, state refresh and missing record; no automatic retry', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  assert.equal(h.output.preview, null);
  h.control.enabled = false;
  h.render();
  await h.flush();
  h.control.enabled = true;
  h.control.fail = false;
  h.render();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  const count = h.calls.length;
  await h.output.prepareDisable(report, item);
  await h.flush();
  assert.equal(h.calls.length, count);
  assert.ok(h.output.error);
  h.unmount();
});
test('only explicit exact-operation recheck clears unknown after a valid durable record appears', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  h.control.state = controlState([controlRecord()]);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.receipt = controlReceipt('recheck');
  await h.output.recheck(h.output.state.records[0]);
  await h.flush();
  assert.equal(h.output.pending.length, 0);
  assert.equal(h.calls.at(-1).body.operationId, h.control.preview.operationId);
  h.unmount();
});
test('unknown cannot be cleared by a later operation on the same retained record', async () => {
  const h = await setup();
  const preview = controlPreview();
  h.client
    .codexSkillControlPendingWrites(h.platform.requestLocal)
    .set(`${contextId}:${preview.recordId}`, { preview, startedAt: preview.createdAt });
  const receipt = controlReceipt('recheck');
  receipt.operationId = '30000000-0000-4000-8000-000000000003';
  receipt.record.operationId = receipt.operationId;
  h.client.confirmCodexSkillControlWrite(h.platform.requestLocal, receipt);
  assert.equal(h.client.codexSkillControlPendingWrites(h.platform.requestLocal).size, 1);
  h.unmount();
});
test('in-flight apply survives unmount as unknown; ignored-abort replies cannot publish completion', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  h.control.hold = true;
  const pending = h.output.apply();
  await h.flush();
  h.unmount();
  assert.equal(h.calls.at(-1).signal.aborted, true);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.client.codexSkillControlPendingWrites(h.platform.requestLocal).size, 1);
});
test('legacy capture, historical capture and incomplete item cannot prepare a mutation', async () => {
  for (const invalid of ['legacy', 'incomplete', 'disabled']) {
    const h = await setup(),
      { report, item } = target();
    if (invalid === 'legacy') delete report.context.controlContextId;
    if (invalid === 'incomplete') item.scan.status = 'incomplete';
    if (invalid === 'disabled') item.declaredState = 'disabled';
    await h.output.prepareDisable(report, item);
    await h.flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.output.preview, null);
    h.unmount();
  }
});
test('preview expiry resets acknowledgements and never sends apply', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  await h.advance(120010);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.canApply, false);
  const count = h.calls.length;
  await h.output.apply();
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('duplicate apply serializes and timeout retains exactly one unknown intent', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  h.control.hold = true;
  const pending = h.output.apply();
  await h.flush();
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.path.endsWith('-apply')).length, 1);
  await h.advance(60000);
  assert.equal(h.output.busy, null);
  assert.equal(h.output.pending.length, 1);
  assert.match(h.output.error, /unknown/);
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.completion, null);
  assert.equal(h.output.pending.length, 1);
  h.unmount();
});
test('synchronous A→B→A context and transport changes discard stale preview responses', async () => {
  for (const change of ['context', 'transport']) {
    const h = await setup(),
      { report, item } = target();
    h.control.hold = true;
    const pending = h.output.prepareDisable(report, item);
    await h.flush();
    const context = h.platform.localContext,
      transport = h.platform.requestLocal;
    if (change === 'context') h.platform.localContext = { workspace: { id: context.workspace.id } };
    else h.platform.requestLocal = (...args) => transport(...args);
    h.render(false);
    h.platform.localContext = context;
    h.platform.requestLocal = transport;
    h.render(false);
    h.release();
    await pending;
    h.render(false);
    assert.equal(h.output.preview, null);
    await h.flush();
    h.unmount();
  }
});
test('wrong operation receipt is unknown and GET does not reconcile it', async () => {
  const h = await setup(),
    { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  h.output.acknowledge('shared', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  h.control.receipt.operationId = '30000000-0000-4000-8000-000000000003';
  h.control.receipt.record.operationId = h.control.receipt.operationId;
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.completion, null);
  assert.equal(h.output.pending.length, 1);
  h.control.state = controlState([controlRecord()]);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.unmount();
});
test('foreign unknowns stay separate and global pending bound refuses a ninth preview', async () => {
  const h = await setup();
  const map = h.client.codexSkillControlPendingWrites(h.platform.requestLocal);
  for (let i = 0; i < 8; i++) {
    const preview = controlPreview();
    preview.controlContextId = otherContextId;
    preview.recordId = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    map.set(`${otherContextId}:${preview.recordId}`, { preview, startedAt: preview.createdAt });
  }
  h.render();
  assert.equal(h.output.pending.length, 0);
  assert.equal(h.output.foreignPending.length, 8);
  const { report, item } = target();
  await h.output.prepareDisable(report, item);
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.unmount();
});
test('failed and malformed state reads never expose raw errors or authorize changes', async () => {
  for (const kind of ['network', 'schema']) {
    const h = controlsHarness();
    if (kind === 'network') h.control.fail = true;
    else h.control.state.rawConfig = 'PRIVATE_CONFIG_CONTENT_SENTINEL';
    h.render();
    await h.flush();
    assert.equal(h.output.state, null);
    assert.ok(h.output.error);
    assert.doesNotMatch(h.output.error, /PRIVATE/);
    const { report, item } = target();
    await h.output.prepareDisable(report, item);
    assert.equal(h.calls.length, 1);
    h.unmount();
  }
});
