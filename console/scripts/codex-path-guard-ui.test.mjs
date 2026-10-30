import test from 'node:test';
import assert from 'node:assert/strict';
import { pathGuardUI } from './codex-path-guard-ui-harness.mjs';
import * as f from './codex-path-guard-client-fixtures.mjs';
const query = `codexPaths=history&pathContext=${f.context}&pathRecord=${f.id(1)}`;
test('quiet credential entry uses actual Codex glyph and passive static presets without fake check actions', () => {
  const h = pathGuardUI();
  const html = h.open();
  assert.match(html, /data-brand="Codex CLI"/);
  assert.match(html, /Credential paths/);
  assert.match(html, /Inspect settings/);
  for (const id of f.presets) assert.match(html, new RegExp(`value="${id}"`));
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(html, /Run check|Protected|Native verified/);
  assert.equal(h.button('Preview deny').props.disabled, true);
});
test('one radio preset is explicitly selected after Inspect before preview', () => {
  const h = pathGuardUI();
  h.action.capture = f.capture();
  h.open();
  const input = h.elements.find((e) => e.type === 'input' && e.props.value === 'npmrc');
  input.props.onChange();
  h.render();
  h.button('Preview deny').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['guard:preview', 'npmrc']);
});
test('review is concise about read/write denial, shared user scope, recovery copies and unverified adoption', () => {
  const h = pathGuardUI();
  h.action.preview = f.preview();
  const html = h.open();
  assert.match(html, /Deny reads and writes/);
  assert.match(html, /~\/.aws\/credentials/);
  assert.match(html, /unencrypted configuration copies/);
  assert.match(html, /Existing chats/);
  assert.match(html, /Networking/);
  assert.match(html, /Preserved/);
  assert.doesNotMatch(html, /Protect all|Native verified|Run check/);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    2,
  );
  assert.equal(h.button('Apply deny').props.disabled, true);
});
test('Restore has a separate weakening acknowledgement and preserves networking', () => {
  const h = pathGuardUI();
  h.action.preview = f.preview(true);
  const html = h.open();
  assert.match(html, /read or write access may return/);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    3,
  );
  assert.match(html, /Restore path rule/);
  assert.match(html, /Networking/);
  assert.match(html, /Preserved/);
});
test('history retains exact record without capture and superseded/restored records never offer Restore', () => {
  const h = pathGuardUI(query);
  h.action.state = f.state([f.record({ ownership: 'superseded', canRestore: false })]);
  const html = h.render();
  assert.match(html, /Superseded/);
  assert.doesNotMatch(html, /Preview restore/);
  assert.equal(h.action.capture, null);
  h.action.state = f.state([f.record({ operationStatus: 'restored', canRestore: false })]);
  assert.doesNotMatch(h.render(), /Preview restore/);
});
test('exact record waits for history admission, focuses once and never snaps after refresh', () => {
  const h = pathGuardUI(query, { effects: true });
  h.action.state = f.state([f.record()]);
  h.action.busy = 'load';
  h.render();
  h.commit();
  assert.equal(h.focused.length, 0);
  h.action.busy = null;
  h.render();
  h.commit();
  assert.deepEqual(h.focused, [{ label: `record:${f.id(1)}`, options: { preventScroll: true } }]);
  assert.equal(h.scrolled.length, 1);
  h.action.state = f.state([f.record({ standing: 'changed', canRestore: false })]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1);
  assert.equal(h.scrolled.length, 1);
});
test('missing and foreign exact links never substitute actionable current records', () => {
  for (const foreign of [false, true]) {
    const h = pathGuardUI(
      foreign ? query.replace(f.context, 'codex-context-' + '9'.repeat(64)) : query,
      { effects: true },
    );
    h.action.state = f.state(foreign ? [f.record()] : []);
    const html = h.render();
    h.commit();
    assert.doesNotMatch(html, /Preview restore|Inspect settings/);
    assert.equal(h.focused.length, 0);
    assert.match(html, /Show current history/);
  }
});
test('unavailable history and unresolved missing writes never claim an empty or safe state', () => {
  const h = pathGuardUI('codexPaths=history');
  h.action.state = {
    ...f.state(),
    available: false,
    history: 'unavailable',
    error: 'codex-path-guard-store-unavailable',
  };
  h.action.pending = [{ preview: f.preview(), startedAt: new Date().toISOString() }];
  const html = h.render();
  assert.match(html, /unavailable|could not be verified/);
  assert.match(html, /Completion unknown/);
  assert.doesNotMatch(html, /No retained changes/);
  assert.doesNotMatch(html, /Preview restore/);
});
test('unsafe or already-denied presets stay non-actionable and no credential contents claim is fabricated', () => {
  const h = pathGuardUI();
  h.action.capture = f.capture();
  h.action.capture.presets[0] = {
    ...h.action.capture.presets[0],
    target: 'unsafe',
    canGuard: false,
    reason: 'codex-path-guard-target-unsafe',
  };
  h.action.capture.presets[1] = {
    ...h.action.capture.presets[1],
    declaration: 'deny',
    canGuard: false,
    reason: 'codex-path-guard-already-denied',
  };
  const html = h.open();
  for (const id of ['aws-credentials', 'ssh-ed25519'])
    assert.equal(
      h.elements.find((e) => e.type === 'input' && e.props.value === id).props.disabled,
      true,
    );
  assert.match(html, /Declared denied/);
  assert.match(html, /metadata/);
});
test('preview remains visibly unavailable while retained recovery history is unverified', () => {
  const h = pathGuardUI();
  h.action.capture = f.capture();
  h.action.canPrepare = false;
  h.open();
  h.elements.find((e) => e.type === 'input' && e.props.value === 'npmrc').props.onChange();
  h.render();
  assert.equal(h.button('Preview deny').props.disabled, true);
});
test('uninspected paths stay two-line choices with one accurate credential-content boundary', () => {
  const h = pathGuardUI(),
    html = h.open();
  assert.doesNotMatch(html, /Not inspected/);
  assert.match(html, /Credential contents stay unread/);
  assert.doesNotMatch(html, /never file contents/);
  assert.equal(
    h.elements.filter((e) => e.type === 'span' && e.props.className === 'codex-path-preset-status')
      .length,
    0,
  );
});
test('shared capture refusal appears once while a distinct path refusal stays visible', () => {
  const h = pathGuardUI();
  h.action.capture = f.capture();
  h.action.capture.reason = 'codex-path-guard-unsupported';
  h.action.capture.presets = h.action.capture.presets.map((p) => ({
    ...p,
    canGuard: false,
    reason: 'codex-path-guard-unsupported',
    declaration: 'unknown',
  }));
  h.action.capture.presets[0].reason = 'codex-path-guard-target-unsafe';
  const html = h.open();
  assert.equal((html.match(/These settings cannot be changed safely here\./g) ?? []).length, 1);
  assert.match(html, /This path cannot be selected safely\./);
  assert.equal(
    h.elements.filter((e) => e.type === 'span' && e.props.className === 'codex-path-preset-status')
      .length,
    7,
  );
});
