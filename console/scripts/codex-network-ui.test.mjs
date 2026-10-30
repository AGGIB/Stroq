import test from 'node:test';
import assert from 'node:assert/strict';
import { networkUI } from './codex-network-ui-harness.mjs';
import * as f from './codex-network-client-fixtures.mjs';
test('Codex row has one Manage entry and opening never captures or mutates', () => {
  const h = networkUI();
  let html = h.render();
  assert.match(html, /Network guard/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  html = h.open();
  assert.match(html, /Codex network guard/);
  assert.match(html, /Inspect settings/);
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(html, />Protected<|data-tone="green"/);
});
test('profile network-only preview keeps filesystem unchanged and acks are contextual', () => {
  const h = networkUI();
  h.guard.preview = f.preview();
  h.open();
  const html = h.render();
  assert.match(html, /Filesystem/);
  assert.match(html, /Unchanged/);
  assert.match(html, /default selector stay unchanged/);
  assert.equal(h.elements.filter((e) => e.type === 'input').length, 2);
  assert.equal(h.button('Apply network guard').props.disabled, true);
});
test('full-access transition explicitly shows filesystem strengthening and Restore retained child', () => {
  const h = networkUI();
  h.guard.preview = f.preview(false, 'profile-child');
  h.open();
  let html = h.render();
  assert.match(html, /restricts file writes/);
  assert.match(html, /workspace/i);
  h.guard.preview = f.preview(true, 'profile-child');
  html = h.render();
  assert.match(html, /owned profile remains inactive/);
  assert.equal(h.elements.filter((e) => e.type === 'input').length, 3);
});
test('network-off users can prepare a check without configuration ownership', () => {
  const h = networkUI();
  h.guard.capture = f.capture(true);
  h.open();
  const html = h.render();
  assert.match(html, /Declared networking/);
  assert.match(html, />Off</);
  assert.ok(h.button('Preview native check'));
  assert.doesNotMatch(html, /Apply network guard/);
  h.button('Preview native check').props.onClick();
  assert.deepEqual(h.calls, ['check:preview']);
});
test('native review explicitly runs isolated TCP and Unix copy test without fake subscription consent', () => {
  const h = networkUI();
  h.checks.preview = f.checkPreview();
  h.open();
  const html = h.render();
  assert.match(html, /Native profile-copy check/);
  assert.match(html, /TCP loopback \+ Unix socket/);
  assert.match(html, /not a running chat/);
  assert.equal(h.elements.filter((e) => e.type === 'input').length, 0);
  h.button('Run check').props.onClick();
  assert.deepEqual(h.calls, ['check:start']);
});
test('completed proof names literal socket outcomes and separate inspected-settings relation', () => {
  const h = networkUI();
  h.checks.job = f.job('completed');
  h.open();
  const html = h.render();
  assert.match(html, /Copy refused both connections/);
  assert.match(html, /OS refused/);
  assert.match(html, /Positive controls: 2\/2/);
  assert.match(html, /current relation unverified/);
  assert.doesNotMatch(html, />Protected<|Network blocked globally|data-tone="green"/);
});
test('superseded history record has no ghost restore and inactive profile is visible', () => {
  const h = networkUI('codexNetwork=history');
  h.guard.state = f.state([f.record({ ownership: 'superseded', canRestore: false })]);
  const html = h.render();
  assert.match(html, /Superseded/);
  assert.doesNotMatch(html, /Preview restore/);
});
test('foreign context or workspace link is read-only and never substitutes current record', () => {
  for (const query of [
    `codexNetwork=history&context=codex-context-${'9'.repeat(64)}&record=${f.id(1)}`,
    `codexNetwork=history&context=${f.context}&check=${f.id(4)}&networkWorkspace=workspace-${'9'.repeat(24)}`,
  ]) {
    const h = networkUI(query);
    h.guard.state = f.state([f.record()]);
    const html = h.render();
    assert.match(html, /another/);
    assert.doesNotMatch(html, /Preview restore|Run check/);
    assert.deepEqual(h.calls, []);
  }
});
test('unavailable history never asserts that no records exist', () => {
  const h = networkUI('codexNetwork=history');
  h.guard.state = {
    ...f.state(),
    available: false,
    history: 'unavailable',
    error: 'codex-network-store-unavailable',
  };
  h.checks.state = {
    ...f.checkState(),
    history: 'unavailable',
    error: 'codex-network-check-history-unavailable',
  };
  const html = h.render();
  assert.match(html, /unavailable/);
  assert.doesNotMatch(html, /No retained configuration changes|No retained native checks/);
});
test('foreign copied-policy result is explicitly historical and never cancellable', () => {
  const h = networkUI();
  h.checks.job = f.job();
  h.checks.job.binding.controlContextId = 'codex-context-' + '9'.repeat(64);
  h.open();
  const html = h.render();
  assert.match(html, /another Codex data directory/);
  assert.equal(h.button('Cancel check').props.disabled, true);
});
test('running check announces genuine progress and confirmed write has a focus target', () => {
  const h = networkUI();
  h.checks.job = f.job();
  h.checks.currentOwned = true;
  h.checks.canCancel = true;
  h.open();
  assert.match(h.render(), /<strong role="status">Running native socket canaries<\/strong>/);
  h.checks.job = null;
  h.guard.receipt = f.receipt();
  const html = h.render();
  assert.match(
    html,
    /class="codex-network-completion control-meta"[^>]*tabindex="-1"[^>]*role="status"/,
  );
});
test('exact recheck of a completed Restore never claims network was turned off', () => {
  const h = networkUI();
  h.guard.receipt = {
    ...f.receipt('recheck'),
    record: f.record({ operationStatus: 'restored', canRestore: false }),
  };
  h.open();
  const html = h.render();
  assert.match(html, /Prior setting restored and read back/);
  assert.doesNotMatch(html, /Network-off setting written and read back/);
});
test('unowned recorded running job is labelled ownership-unverified and does not hide inspection', () => {
  const h = networkUI();
  h.checks.job = f.job();
  h.checks.state = f.checkState([h.checks.job], false);
  h.open();
  const html = h.render();
  assert.match(html, /ownership unverified/i);
  assert.ok(h.button('Inspect settings'));
  assert.equal(h.button('Cancel check').props.disabled, true);
});
