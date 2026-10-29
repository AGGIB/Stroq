import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  ws,
  otherWs,
  bindingId,
  toolId,
  version,
} from './mcp-tool-contract-client-harness.mjs';
test('Opening overview and exact tool reads saved state only; explicit preview sends opaque selectors', async () => {
  for (const selected of [false, true]) {
    const h = harness(selected);
    h.render();
    await h.flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].path, '/api/mcp-tool-contracts');
    if (selected) {
      await h.prepare();
      assert(h.output.preview);
      assert.equal(h.calls[1].body.bindingId, bindingId);
      assert.equal(h.calls[1].body.toolId, toolId);
      assert.equal(h.calls[1].body.expectedContractSha256, version);
      assert.equal('contract' in h.calls[1].body, false);
    }
    h.unmount();
  }
});
test('Invalid, foreign and disconnected selections never read or decide', async () => {
  for (const values of [{ invalid: true }, { workspaceId: otherWs }]) {
    const h = harness();
    await h.context(values);
    assert.equal(h.calls.length, 0);
    h.unmount();
  }
  const h = harness();
  await h.context({}, undefined, false);
  assert.equal(h.calls.length, 0);
  h.unmount();
});
test('None/incomplete/missing/stale selections cannot preview or substitute another version', async () => {
  for (const mode of [
    'none',
    'incomplete',
    'missing-registration',
    'missing-tool',
    'changed-binding',
    'changed-version',
  ]) {
    const h = harness();
    h.mode(mode);
    h.render();
    await h.flush();
    await h.prepare();
    assert.equal(h.output.preview, null);
    assert.equal(h.calls.length, 1);
    h.unmount();
  }
});
test('Preview mismatch and private fields are refused', async () => {
  for (const mode of [
    'bad-preview-binding',
    'bad-preview-body',
    'bad-preview-capture',
    'private-preview',
  ]) {
    const h = harness();
    h.render();
    await h.flush();
    h.mode(mode);
    await h.prepare();
    assert.equal(h.output.preview, null);
    assert(h.output.error);
    h.unmount();
  }
});
test('Dual consent is required; verified exact approval rereads state without retrying a tool call', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  h.output.acknowledge('contract', true);
  await h.flush();
  await h.apply();
  assert.equal(h.calls.length, 2);
  await h.consent();
  await h.apply();
  assert(h.output.receipt);
  assert.equal(h.output.tool.decision, 'approved');
  assert.equal(h.output.needsRecheck, false);
  assert.deepEqual(
    h.calls.map((c) => c.path),
    [
      '/api/mcp-tool-contracts',
      '/api/mcp-tool-contracts/preview',
      '/api/mcp-tool-contracts/apply',
      '/api/mcp-tool-contracts',
    ],
  );
  await h.prepare('revoke');
  await h.consent();
  await h.apply();
  assert.equal(h.output.tool.decision, 'revoked');
  assert.equal(h.output.receipt.action, 'revoke');
  h.unmount();
});
test('Late preview cannot publish after tool version, binding, workspace or connection changes', async () => {
  for (const change of ['version', 'binding', 'workspace', 'connection', 'context']) {
    const h = harness();
    h.render();
    await h.flush();
    h.mode('hold-preview');
    const pending = h.output.prepare('approve');
    await h.flush();
    h.mode('ok');
    if (change === 'version') await h.context({ contractSha256: '4'.repeat(64) });
    else if (change === 'binding') await h.context({ bindingId: `binding-${'4'.repeat(64)}` });
    else if (change === 'workspace') await h.context({ workspaceId: otherWs }, otherWs);
    else if (change === 'connection') await h.reconnect();
    else await h.reconnectContext();
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.preview, null);
    h.unmount();
  }
});
test('A→B→A before passive cleanup cannot resurrect a preview or retained handlers', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  await h.consent();
  const old = h.output;
  await h.routeImmediate({ contractSha256: '4'.repeat(64) });
  await h.routeImmediate({ contractSha256: version });
  assert.equal(h.output.preview, null);
  const count = h.calls.length;
  await old.apply();
  old.refresh();
  await old.prepare('approve');
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('Close fences retained actions and evidence synchronously before any rerender', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  await h.consent();
  const old = h.output;
  old.invalidate();
  const count = h.calls.length;
  await old.apply();
  await old.prepare('approve');
  old.refresh();
  assert.equal(old.getEvidence(), null);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('Unmount fences retained read/preview/apply callbacks; StrictMode re-entry makes a fresh GET', async () => {
  const h = harness();
  h.render();
  await h.flush();
  await h.prepare();
  await h.consent();
  const old = h.output;
  h.unmount();
  const count = h.calls.length;
  await old.apply();
  await old.prepare('approve');
  old.refresh();
  assert.equal(h.calls.length, count);
  assert.equal(old.getEvidence(), null);
  const fresh = harness();
  fresh.render();
  await fresh.flush();
  await fresh.strictCycle();
  assert.equal(fresh.calls.length, 2);
  assert.equal(
    fresh.calls.every((c) => c.path === '/api/mcp-tool-contracts'),
    true,
  );
  fresh.unmount();
});
test('Visible deadlines clear busy even when read or preview transport ignores AbortSignal', async () => {
  for (const mode of ['hold-read', 'hold-preview']) {
    const h = harness();
    if (mode === 'hold-read') h.mode(mode);
    h.render();
    await h.flush();
    let pending;
    if (mode === 'hold-preview') {
      h.mode(mode);
      pending = h.output.prepare('approve');
      await h.flush();
    }
    await h.advance(25000);
    assert.equal(h.output.busy, null);
    assert(h.output.error);
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.preview, null);
    if (mode === 'hold-read') assert.equal(h.output.state, null);
    h.unmount();
  }
});
test('Unknown apply survives close/reopen and automatic reads; only exact explicit recheck clears it', async () => {
  for (const mode of ['bad-receipt-id', 'bad-receipt-version', 'private-receipt']) {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    await h.consent();
    h.mode(mode);
    await h.apply();
    assert.equal(h.output.needsRecheck, true);
    assert.equal(h.output.receipt, null);
    h.mode('ok');
    await h.context({ toolId: null, contractSha256: null });
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, true, 'Registration overview cannot resolve exact tool');
    await h.context({ toolId, contractSha256: version });
    assert.equal(h.output.needsRecheck, true);
    const count = h.calls.length;
    await h.prepare();
    assert.equal(h.calls.length, count);
    h.output.refresh();
    await h.flush();
    assert.equal(h.output.needsRecheck, false);
    assert.equal(h.output.tool.decision, 'approved');
    assert.equal(h.output.receipt, null);
    h.unmount();
  }
});
test('Ignored apply deadline or unmount cannot later publish a receipt or silently retry', async () => {
  for (const end of ['timeout', 'unmount']) {
    const h = harness();
    h.render();
    await h.flush();
    await h.prepare();
    await h.consent();
    h.mode('hold-apply');
    const pending = h.output.apply();
    await h.flush();
    if (end === 'timeout') {
      await h.advance(35000);
      assert.equal(h.output.busy, null);
      assert.equal(h.output.needsRecheck, true);
    } else h.unmount();
    const count = h.calls.length;
    h.release();
    await pending;
    await h.flush();
    assert.equal(h.output.receipt, null);
    assert.equal(h.calls.length, count);
    if (end === 'timeout') h.unmount();
  }
});
test('Raw errors and malformed/foreign state never become inferred empty healthy records', async () => {
  for (const mode of ['raw-read-error', 'foreign-read', 'private-read']) {
    const h = harness();
    h.mode(mode);
    h.render();
    await h.flush();
    assert.equal(h.output.state, null);
    assert(h.output.error);
    assert.equal(h.output.error.includes('PRIVATE'), false);
    h.unmount();
  }
  const h = harness();
  h.mode('fixed-read-error');
  h.render();
  await h.flush();
  assert.match(h.output.error, /limit was reached/);
  h.unmount();
});
