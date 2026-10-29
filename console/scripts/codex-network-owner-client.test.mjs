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
test('unowned retained running history is read-only but allows a fresh explicit admission preview', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  h.control.checks = f.checkState([f.job()], false);
  await h.output.checks.refresh();
  await h.flush();
  await inspect(h);
  assert.equal(h.output.checks.currentOwned, false);
  await h.output.checks.cancel();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/cancel')).length, 0);
  await h.output.checks.prepare();
  await h.flush();
  assert.equal(h.output.checks.preview.jobId, f.id(4));
  h.unmount();
});
test('exact unknown on an unowned running record permits a new admission without clearing old intent', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  const old = f.job();
  h.control.checks = f.checkState([old], false);
  await h.output.checks.refresh();
  await h.flush();
  h.client.codexNetworkCheckPending(h.platform.requestLocal).set(`${f.context}:${old.id}`, {
    action: 'cancel',
    id: old.id,
    operationId: old.operationId,
    binding: old.binding,
    startedAt: old.startedAt,
  });
  h.render();
  await h.output.checks.prepare();
  await h.flush();
  assert.ok(h.output.checks.preview);
  assert.equal(h.output.checks.pending.length, 1);
  h.unmount();
});
test('foreign, absent and different-binding unknowns cannot authorize fresh admission', async () => {
  for (const kind of ['foreign', 'absent', 'changed']) {
    const h = await setup();
    h.control.capture = f.capture(true);
    await inspect(h);
    const old = f.job();
    h.control.checks = f.checkState(kind === 'absent' ? [] : [old], false);
    await h.output.checks.refresh();
    await h.flush();
    const binding = { ...old.binding };
    if (kind === 'foreign') binding.controlContextId = 'codex-context-' + '9'.repeat(64);
    if (kind === 'changed') binding.profileCopySha256 = '9'.repeat(64);
    h.client
      .codexNetworkCheckPending(h.platform.requestLocal)
      .set(`${binding.controlContextId}:${old.id}`, {
        action: 'cancel',
        id: old.id,
        operationId: old.operationId,
        binding,
        startedAt: old.startedAt,
      });
    h.render();
    await h.output.checks.prepare();
    await h.flush();
    assert.equal(h.output.checks.preview, null, kind);
    h.unmount();
  }
});
test('fresh owned job preserves earlier unknown intent while allowing its own poll and cancellation', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  const old = f.job();
  h.control.checks = f.checkState([old], false);
  await h.output.checks.refresh();
  await h.flush();
  const oldIntent = {
    action: 'cancel',
    id: old.id,
    operationId: old.operationId,
    binding: old.binding,
    startedAt: old.startedAt,
  };
  h.client
    .codexNetworkCheckPending(h.platform.requestLocal)
    .set(`${f.context}:${old.id}`, oldIntent);
  h.render();
  h.control.checkPreview = {
    ...f.checkPreview(),
    id: f.id(6),
    operationId: f.id(6),
    jobId: f.id(7),
  };
  h.control.job = { ...f.job(), id: f.id(7), operationId: f.id(6) };
  await h.output.checks.prepare();
  await h.flush();
  await h.output.checks.start();
  await h.flush();
  assert.equal(h.output.checks.job.id, f.id(7));
  assert.equal(h.output.checks.currentOwned, true);
  assert.equal(h.output.checks.canCancel, true);
  assert.equal(h.output.checks.pending.length, 1);
  assert.equal(h.output.checks.pending[0].id, old.id);
  const completed = { ...f.job('completed'), id: f.id(7), operationId: f.id(6) };
  h.control.checks = f.checkState([completed, f.job('failed')], false);
  await h.advance(1500);
  assert.equal(h.output.checks.job.status, 'completed');
  assert.equal(h.output.checks.pending.length, 1);
  assert.equal(
    h.client.codexNetworkCheckPending(h.platform.requestLocal).get(`${f.context}:${old.id}`),
    oldIntent,
  );
  h.unmount();
});
test('only exact HTTP409 pre-admission codes create typed native-start refusals', async () => {
  const h = await setup();
  for (const code of [
    'codex-network-check-busy',
    'codex-network-check-stale',
    'codex-network-check-expired',
  ]) {
    const refusal = h.client.createCodexNetworkCheckStartRefusal(code, 409);
    assert(refusal instanceof h.client.CodexNetworkCheckStartRefusal);
    assert.equal(refusal.code, code);
    assert.equal(h.client.createCodexNetworkCheckStartRefusal(code, 503), null);
    assert.equal(h.client.createCodexNetworkCheckStartRefusal(code, 200), null);
  }
  for (const code of [
    null,
    {},
    'codex-network-check-unavailable',
    'codex-network-check-history-unavailable',
  ])
    assert.equal(h.client.createCodexNetworkCheckStartRefusal(code, 409), null);
  h.unmount();
});
test('typed pre-admission busy/stale/expired consume preview but leave no unknown new attempt', async () => {
  for (const code of [
    'codex-network-check-busy',
    'codex-network-check-stale',
    'codex-network-check-expired',
  ]) {
    const h = await setup();
    h.control.capture = f.capture(true);
    await inspect(h);
    await h.output.checks.prepare();
    await h.flush();
    h.control.failPath = '/api/codex-network-checks/start';
    h.control.error = h.client.createCodexNetworkCheckStartRefusal(code, 409);
    await h.output.checks.start();
    await h.flush();
    assert.equal(h.output.checks.pending.length, 0, code);
    assert.equal(h.output.checks.preview, null);
    assert.equal(h.output.error, h.client.CODEX_NETWORK_ERROR_MESSAGES[code]);
    h.unmount();
  }
});
test('plain same-message error and malformed Start response remain unknown', async () => {
  for (const kind of ['plain', 'malformed']) {
    const h = await setup();
    h.control.capture = f.capture(true);
    await inspect(h);
    await h.output.checks.prepare();
    await h.flush();
    if (kind === 'plain') {
      h.control.failPath = '/api/codex-network-checks/start';
      h.control.error = new Error(
        h.client.CODEX_NETWORK_ERROR_MESSAGES['codex-network-check-busy'],
      );
    } else h.control.job = { ...f.job(), unexpected: true };
    await h.output.checks.start();
    await h.flush();
    assert.equal(h.output.checks.pending.length, 1, kind);
    assert.match(h.output.error, /unconfirmed/);
    h.unmount();
  }
});
test('typed new-admission refusal never clears an earlier exact unknown intent', async () => {
  const h = await setup();
  h.control.capture = f.capture(true);
  await inspect(h);
  const old = f.job();
  h.control.checks = f.checkState([old], false);
  await h.output.checks.refresh();
  await h.flush();
  const oldIntent = {
    action: 'cancel',
    id: old.id,
    operationId: old.operationId,
    binding: old.binding,
    startedAt: old.startedAt,
  };
  h.client
    .codexNetworkCheckPending(h.platform.requestLocal)
    .set(`${f.context}:${old.id}`, oldIntent);
  h.render();
  h.control.checkPreview = {
    ...f.checkPreview(),
    id: f.id(6),
    operationId: f.id(6),
    jobId: f.id(7),
  };
  await h.output.checks.prepare();
  await h.flush();
  h.control.failPath = '/api/codex-network-checks/start';
  h.control.error = h.client.createCodexNetworkCheckStartRefusal('codex-network-check-busy', 409);
  await h.output.checks.start();
  await h.flush();
  assert.equal(h.output.checks.pending.length, 1);
  assert.equal(h.output.checks.pending[0], oldIntent);
  h.unmount();
});
