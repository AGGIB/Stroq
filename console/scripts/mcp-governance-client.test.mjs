import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { governanceHarness } from './mcp-governance-client-harness.mjs';
const f = await tsImport('../lib/mcp-governance-fixtures.ts', { parentURL: import.meta.url });
async function setup() {
  const h = governanceHarness(true);
  h.render();
  await h.flush();
  return h;
}
async function review(h) {
  await h.output.inspect();
  await h.flush();
  h.output.selectChoice(h.control.capture.choices[0].id, true);
  await h.flush();
  await h.output.prepare();
  await h.flush();
  h.output.acknowledge('scope', true);
  h.output.acknowledge('retention', true);
  await h.flush();
}
test('open reads policy/history once without capturing registrations or starting servers', async () => {
  const h = governanceHarness();
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.control.open = true;
  h.render();
  await h.flush();
  assert.deepEqual(
    h.calls.map((c) => [c.path, c.body]),
    [['/api/mcp-governance', undefined]],
  );
  h.unmount();
});
test('manual capture binds opaque choice ids and hashes; no channel/name/path is sent', async () => {
  const h = await setup();
  await review(h);
  assert.deepEqual(h.calls.at(-1).body, {
    captureId: h.control.capture.captureId,
    binding: h.control.capture.binding,
    selected: [
      {
        id: h.control.capture.choices[0].id,
        expectedSha256: h.control.capture.choices[0].expectedSha256,
      },
    ],
  });
  assert(!JSON.stringify(h.calls.map((c) => c.body)).includes('notes'));
  assert(h.output.preview);
  h.unmount();
});
test('Apply is one use, consent-bound and receipt matches full candidate/operation', async () => {
  const h = await setup();
  await review(h);
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 1);
  assert.deepEqual(h.calls.findLast((c) => c.path.endsWith('/apply')).body, {
    previewId: f.governanceId(2),
    operationId: f.governanceId(3),
    contextId: f.governanceContext,
    acknowledgeScope: true,
    acknowledgeRetention: true,
  });
  assert.equal(h.output.receipt.writeConfirmed, true);
  assert.equal(h.output.pending.length, 0);
  h.unmount();
});
test('v2 additions and ordinary interruptions require their own acknowledgements', async () => {
  const h = await setup();
  h.control.capture.current = { policyVersion: 2, gate: 'enforced', allowed: [] };
  h.control.preview.current = h.control.capture.current;
  h.control.preview.requiresWeakening = true;
  h.control.preview.requiresInterruptions = true;
  await review(h);
  assert.equal(h.output.canApply, false);
  h.output.acknowledge('weakening', true);
  h.output.acknowledge('interruptions', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.findLast((c) => c.path.endsWith('/apply')).body.acknowledgeWeakening, true);
  assert.equal(
    h.calls.findLast((c) => c.path.endsWith('/apply')).body.acknowledgeInterruptions,
    true,
  );
  h.unmount();
});
test('unknown write survives absent GET and a different pass, then only exact recheck confirms it', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.fail = false;
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.state = f.governanceState([f.governanceRecord()]);
  await h.output.refresh();
  await h.flush();
  await h.output.recheck(h.output.state.records[0]);
  await h.flush();
  assert.equal(h.output.pending.length, 0);
  h.unmount();
});
test('explicit not-applied proof resolves exact unknown while ordinary GET never does', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  const r = f.governanceRecord({ status: 'not-applied', historyRef: null });
  h.control.state = f.governanceState([r]);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  h.control.recheck = { ...f.governanceRecheck(), writeConfirmed: false, record: r };
  await h.output.recheck(r);
  await h.flush();
  assert.equal(h.output.pending.length, 0);
  assert.equal(h.output.completion.record.status, 'not-applied');
  h.unmount();
});
test('unknown historical operations permit fresh independent review with exact recovery acknowledgement', async () => {
  const h = await setup();
  const old = f.governanceRecord({ status: 'unknown', historyRef: null });
  h.control.state = f.governanceState([old]);
  await h.output.refresh();
  await h.flush();
  h.control.preview.unconfirmedRecords = [
    { id: old.id, revision: old.revision, operationId: old.operationId },
  ];
  h.control.preview.requiresRecoveryReview = true;
  h.control.preview.operationId = f.governanceId(10);
  h.control.receipt.operationId = f.governanceId(10);
  h.control.receipt.record.operationId = f.governanceId(10);
  h.control.receipt.record.id = f.governanceId(11);
  await review(h);
  assert(h.output.preview);
  assert.equal(h.output.canApply, false);
  h.output.acknowledge('recovery', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  assert.equal(
    h.calls.findLast((c) => c.path.endsWith('/apply')).body.acknowledgeUnconfirmed,
    true,
  );
  h.unmount();
});
test('ineligible identities, stale choice hashes and mismatched preview are refused', async () => {
  const h = await setup();
  h.control.capture.choices[0] = {
    ...h.control.capture.choices[0],
    eligibility: 'unsupported',
    reason: 'redacted-identity',
    pair: { ...h.control.capture.choices[0].pair, redacted: true },
  };
  await h.output.inspect();
  await h.flush();
  h.output.selectChoice(h.control.capture.choices[0].id, true);
  await h.flush();
  assert.equal(h.output.selected.length, 0);
  h.unmount();
  const other = await setup();
  other.control.preview.selected[0].expectedSha256 = '0'.repeat(64);
  await review(other);
  assert.equal(other.output.preview, null);
  other.unmount();
});
test('closing or timing out Apply keeps exact pending and ignores late successful response', async () => {
  for (const mode of ['close', 'timeout']) {
    const h = await setup();
    await review(h);
    h.control.hold = true;
    const applying = h.output.apply();
    if (mode === 'close') {
      h.control.open = false;
      h.render();
      await h.flush();
    } else await h.advance(60001);
    h.release();
    await applying;
    await h.flush();
    assert.equal(h.output.receipt, null);
    assert.equal(h.client.mcpGovernancePending(h.platform.requestLocal).size, 1);
    h.unmount();
  }
});
test('preview expiry clears consent without retries and passive reads share the operation slot', async () => {
  const h = await setup();
  await review(h);
  const count = h.calls.length;
  await h.advance(120001);
  assert.equal(h.output.preview, null);
  assert.equal(h.output.canApply, false);
  assert.equal(h.calls.length, count);
  h.unmount();
  const held = governanceHarness(true);
  held.control.hold = true;
  held.render();
  await held.flush();
  await held.output.inspect();
  assert.equal(held.calls.length, 1);
  held.release();
  await held.flush();
  held.unmount();
});
test('independent fresh change requires browser unknown review, never retries or clears absent earlier intent', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  h.control.preview.operationId = f.governanceId(10);
  h.control.receipt.operationId = f.governanceId(10);
  h.control.receipt.record.operationId = f.governanceId(10);
  h.control.receipt.record.id = f.governanceId(11);
  await review(h);
  assert.equal(h.output.canApply, false);
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 1);
  h.output.acknowledge('pendingReview', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  await h.output.apply();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 2);
  assert.equal(h.output.pending.length, 1);
  assert.equal(h.output.pending[0].preview.operationId, f.governanceId(3));
  assert.equal(
    'acknowledgePendingReview' in h.calls.findLast((c) => c.path.endsWith('/apply')).body,
    false,
  );
  h.unmount();
});
test('masked valid current allowance stays preselected and selectable without raw name authority', async () => {
  const h = await setup();
  const pair = f.governancePair({ redacted: true, label: 'Identity cccccccc' });
  h.control.capture.current = { policyVersion: 2, gate: 'enforced', allowed: [pair] };
  h.control.capture.choices[0] = {
    ...f.governanceChoice(),
    pair,
    kind: 'retained',
    sourceRefs: [],
    inAllowSet: true,
  };
  await h.output.inspect();
  await h.flush();
  assert.equal(h.output.selected.length, 1);
  h.output.selectChoice(h.control.capture.choices[0].id, false);
  await h.flush();
  assert.equal(h.output.selected.length, 0);
  h.unmount();
});
test('new unknown intent invalidates previously reviewed browser pending set', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  h.control.preview.operationId = f.governanceId(10);
  await review(h);
  h.output.acknowledge('pendingReview', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  const p = { ...f.governancePreview(), operationId: f.governanceId(12) };
  h.client
    .mcpGovernancePending(h.platform.requestLocal)
    .set(h.client.governanceOperationKey(p.binding.contextId, p.operationId), {
      preview: p,
      startedAt: new Date().toISOString(),
    });
  await h.output.apply();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 1);
  h.client.notifyMcpGovernancePending(h.platform.requestLocal);
  await h.flush();
  assert.equal(h.output.canApply, false);
  h.unmount();
});
test('confirmed Apply invalidates old current policy and serially reads fresh state without deriving it from receipt', async () => {
  const h = await setup();
  await review(h);
  h.control.state = {
    ...f.governanceState(),
    current: { policyVersion: 2, gate: 'enforced', allowed: [] },
  };
  h.control.holdPath = '/api/mcp-governance';
  const applying = h.output.apply();
  await h.flush();
  assert.equal(h.output.receipt.writeConfirmed, true);
  assert.equal(h.output.state.current.gate, 'unavailable');
  assert.equal(h.output.state.editable, false);
  assert.equal(h.output.state.records[0].operationId, f.governanceId(3));
  assert.equal(h.output.busy, 'load');
  assert.deepEqual(
    h.calls.slice(-2).map((c) => c.path),
    ['/api/mcp-governance/apply', '/api/mcp-governance'],
  );
  h.release();
  await applying;
  await h.flush();
  assert.deepEqual(h.output.state.current, h.control.state.current);
  assert.equal(h.output.state.records[0].status, 'applied');
  assert.equal(h.output.state.records[0].current, 'unavailable');
  assert.equal(h.output.pending.length, 0);
  h.unmount();
});
test('received unknown and explicit Recheck each reread current state while absent GET never discards operation or settles pending', async () => {
  const h = await setup();
  await review(h);
  const r = f.governanceRecord({ status: 'unknown', historyRef: null });
  h.control.receipt = { ...f.governanceReceipt(), writeConfirmed: false, record: r };
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.pending.length, 1);
  assert.equal(h.output.state.records[0].status, 'unknown');
  assert.equal(h.calls.filter((c) => c.path === '/api/mcp-governance').length, 2);
  await h.output.recheck(h.output.state.records[0]);
  await h.flush();
  assert.equal(h.output.pending.length, 0);
  assert.equal(h.output.state.records[0].status, 'applied');
  assert.equal(h.calls.filter((c) => c.path === '/api/mcp-governance').length, 3);
  h.unmount();
});
test('failed or unverified Apply performs no automatic read or write retry', async () => {
  for (const malformed of [false, true]) {
    const h = await setup();
    await review(h);
    const before = h.calls.length;
    if (malformed) h.control.receipt = {};
    else h.control.failPath = '/api/mcp-governance/apply';
    await h.output.apply();
    await h.flush();
    assert.equal(h.calls.length, before + 1);
    assert.equal(h.output.pending.length, 1);
    h.unmount();
  }
});
test('failed post-write current read leaves cached policy unavailable but preserves the exact receipt and operation', async () => {
  const h = await setup();
  await review(h);
  h.control.failPath = '/api/mcp-governance';
  await h.output.apply();
  await h.flush();
  assert.equal(h.output.receipt.writeConfirmed, true);
  assert.equal(h.output.state.current.gate, 'unavailable');
  assert.equal(h.output.state.editable, false);
  assert.equal(h.output.state.records[0].operationId, f.governanceId(3));
  assert.equal(h.output.state.records[0].status, 'applied');
  assert.equal(h.output.pending.length, 0);
  assert.match(h.output.error, /could not be read/);
  assert.equal(h.calls.filter((c) => c.path === '/api/mcp-governance').length, 2);
  h.unmount();
});
function emptyBlockPreview(h) {
  h.control.preview.selected = [];
  h.control.preview.diff = { added: [], removed: [], retained: [] };
  h.control.preview.gateChecks.cases[0].status = 'not-applicable';
}
test('one explicit block preview serially captures then previews exact empty opaque selection without applying', async () => {
  const h = await setup();
  emptyBlockPreview(h);
  const before = h.calls.length;
  await h.output.prepareDenyAll();
  await h.flush();
  assert.deepEqual(
    h.calls.slice(before).map((c) => c.path),
    ['/api/mcp-governance/capture', '/api/mcp-governance/preview'],
  );
  assert.deepEqual(h.calls.at(-1).body, {
    captureId: h.control.capture.captureId,
    binding: h.control.capture.binding,
    selected: [],
  });
  assert(h.output.preview);
  assert.equal(h.output.canApply, false);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 0);
  h.unmount();
});
test('block preview does not run automatically and a held capture prevents competing block preview', async () => {
  const h = await setup();
  emptyBlockPreview(h);
  h.control.hold = true;
  const preparing = h.output.prepareDenyAll();
  await h.flush();
  await h.output.prepareDenyAll();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/capture')).length, 1);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/preview')).length, 0);
  h.control.hold = false;
  h.release();
  await preparing;
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/preview')).length, 1);
  h.unmount();
});
test('closed or timed out block capture never starts its chained preview or accepts a late capture', async () => {
  for (const mode of ['close', 'timeout']) {
    const h = await setup();
    emptyBlockPreview(h);
    h.control.hold = true;
    const preparing = h.output.prepareDenyAll();
    if (mode === 'close') {
      h.control.open = false;
      h.render();
      await h.flush();
    } else await h.advance(30001);
    h.release();
    await preparing;
    await h.flush();
    assert.equal(h.calls.filter((c) => c.path.endsWith('/preview')).length, 0);
    assert.equal(h.output.preview, null);
    h.unmount();
  }
});
test('fresh capture already declaring deny-all does not prepare a no-op mutation or infer native blocking', async () => {
  const h = await setup();
  h.control.capture.current = { policyVersion: 2, gate: 'enforced', allowed: [] };
  await h.output.prepareDenyAll();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/capture')).length, 1);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/preview')).length, 0);
  assert.equal(h.output.capture.current.allowed.length, 0);
  assert.equal(h.output.preview, null);
  h.unmount();
});
test('failed or foreign Capture and stale block Preview refuse without a server write or automatic retry', async () => {
  for (const failure of ['capture', 'foreign', 'preview']) {
    const h = await setup();
    emptyBlockPreview(h);
    if (failure === 'capture') h.control.failPath = '/api/mcp-governance/capture';
    else if (failure === 'foreign')
      h.control.capture.binding.workspaceId = 'workspace-' + '9'.repeat(24);
    else h.control.failPath = '/api/mcp-governance/preview';
    await h.output.prepareDenyAll();
    await h.flush();
    assert.equal(h.output.preview, null);
    assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 0);
    assert.equal(h.calls.filter((c) => c.path.endsWith('/capture')).length, 1);
    assert.equal(
      h.calls.filter((c) => c.path.endsWith('/preview')).length,
      failure === 'preview' ? 1 : 0,
    );
    assert(h.output.error);
    h.unmount();
  }
});
test('block candidate removes current v2 allowances and still requires captured interruption and shared consents', async () => {
  const h = await setup(),
    pair = f.governancePair();
  h.control.capture.current = { policyVersion: 2, gate: 'enforced', allowed: [pair] };
  emptyBlockPreview(h);
  h.control.preview.current = h.control.capture.current;
  h.control.preview.diff.removed = [pair];
  h.control.preview.requiresInterruptions = true;
  await h.output.prepareDenyAll();
  await h.flush();
  assert.deepEqual(h.calls.at(-1).body.selected, []);
  assert(h.output.preview);
  h.output.acknowledge('scope', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  assert.equal(h.output.canApply, false);
  h.output.acknowledge('interruptions', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  h.unmount();
});
test('closing during chained block Preview discards its late result with no Apply', async () => {
  const h = await setup();
  emptyBlockPreview(h);
  h.control.holdPath = '/api/mcp-governance/preview';
  const preparing = h.output.prepareDenyAll();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.endsWith('/preview')).length, 1);
  h.control.open = false;
  h.render();
  await h.flush();
  h.release();
  await preparing;
  await h.flush();
  assert.equal(h.output.preview, null);
  assert.equal(h.calls.filter((c) => c.path.endsWith('/apply')).length, 0);
  h.unmount();
});
test('fresh deny-all draft keeps an earlier unknown operation and still requires its separate browser review', async () => {
  const h = await setup();
  await review(h);
  h.control.fail = true;
  await h.output.apply();
  await h.flush();
  h.control.fail = false;
  emptyBlockPreview(h);
  h.control.preview.operationId = f.governanceId(10);
  await h.output.prepareDenyAll();
  await h.flush();
  assert(h.output.preview);
  assert.equal(h.output.pending.length, 1);
  h.output.acknowledge('scope', true);
  h.output.acknowledge('retention', true);
  await h.flush();
  assert.equal(h.output.canApply, false);
  h.output.acknowledge('pendingReview', true);
  await h.flush();
  assert.equal(h.output.canApply, true);
  assert.equal(h.output.pending[0].preview.operationId, f.governanceId(3));
  h.unmount();
});
