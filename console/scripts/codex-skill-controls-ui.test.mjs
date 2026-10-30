import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './codex-skill-sources-ui-harness.mjs';
import {
  sourceReport,
  controlPreview,
  controlRecord,
  contextId,
  otherContextId,
} from './codex-skill-controls-client-fixtures.mjs';
test('complete captured candidate has a per-path disable action with no generic enable', () => {
  const h = harness();
  h.action.report = sourceReport();
  h.open();
  const html = h.render();
  assert.match(html, /Disable this path/);
  assert.equal(h.button('Disable this path').props.disabled, false);
  h.button('Disable this path').props.onClick();
  assert.equal(h.calls.at(-1)[0], 'controls:disable');
  assert.doesNotMatch(html, />Enable skill<|>Trust skill<|>Protected<|data-tone="green"/);
});
test('saved changes opens without a source capture and remains reachable after source removal', () => {
  const h = harness();
  h.controls.state.records = [controlRecord()];
  h.render();
  h.button('Saved changes').props.onClick({ currentTarget: { isConnected: true, focus() {} } });
  const html = h.render();
  assert.match(html, /Disable recorded/);
  assert.match(html, /Preview restore/);
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(html, /Source chain/);
  h.button('Preview restore').props.onClick();
  assert.equal(h.calls.at(-1)[0], 'controls:restore');
});
test('disable preview exposes scope, retained copies and alternate-copy effect before apply', () => {
  const h = harness();
  h.action.report = sourceReport();
  h.controls.preview = controlPreview();
  h.open();
  const html = h.render();
  for (const value of [
    'Disable this SKILL.md path',
    'future versions',
    'named profiles and session overrides',
    '2 other captured copies',
    'unencrypted configuration copies',
    'Apply disable',
    'Configuration fingerprints',
  ])
    assert.ok(html.includes(value), value);
  assert.equal(h.button('Apply disable').props.disabled, true);
  const boxes = h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox');
  assert.equal(boxes.length, 2);
  boxes[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(h.calls.at(-1), ['controls:ack', 'shared', true]);
});
test('preview omits repeated name-location text while preserving distinct and withheld locations', () => {
  for (const kind of ['same', 'distinct', 'redacted']) {
    const h = harness();
    h.controls.preview = controlPreview();
    h.controls.preview.name = 'fixture-skill';
    h.controls.preview.location = {
      label: kind === 'distinct' ? 'nested/fixture-skill' : 'fixture-skill',
      redacted: kind === 'redacted',
    };
    h.open();
    const preview = h
      .render()
      .match(/<section class="codex-skill-control-preview"[\s\S]*?<\/section>/)?.[0];
    assert.ok(preview);
    assert.match(preview, /<strong>fixture-skill<\/strong>/);
    if (kind === 'same') assert.doesNotMatch(preview, /<code>fixture-skill<\/code>/);
    if (kind === 'distinct') assert.match(preview, /nested\/fixture-skill/);
    if (kind === 'redacted') assert.match(preview, /location withheld/);
  }
});
test('restore preview adds weakening consent and describes prior-declaration recovery', () => {
  const h = harness();
  h.controls.preview = controlPreview('restore');
  h.open();
  const html = h.render();
  assert.match(html, /Restore previous declaration/);
  assert.match(html, /preserves later unrelated settings/);
  assert.match(html, /prior declaration may allow this path again/);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    3,
  );
  assert.doesNotMatch(html, />Enable skill</);
});
test('browser deep link opens retained history without inspecting and refuses a different context', () => {
  const record = controlRecord();
  const h = harness({}, null, `codexControl=${record.id}&context=${contextId}`);
  h.controls.state.records = [record];
  let html = h.render();
  assert.match(html, /Disable recorded/);
  assert.deepEqual(h.calls, []);
  const foreign = harness({}, null, `codexControl=${record.id}&context=${otherContextId}`);
  foreign.controls.state.records = [record];
  html = foreign.render();
  assert.match(html, /another Codex data directory/);
  assert.doesNotMatch(html, /Preview restore/);
  assert.deepEqual(foreign.calls, []);
});
test('unknown write has explicit exact recheck while independent current standing remains visible', () => {
  const record = controlRecord(),
    p = controlPreview(),
    h = harness({}, null, `codexControl=${record.id}&context=${contextId}`);
  h.controls.state.records = [record];
  h.controls.pending = [{ preview: p, startedAt: p.createdAt }];
  const html = h.render();
  assert.match(html, /Completion unknown/);
  assert.match(html, /Current base declaration: disabled/);
  assert.doesNotMatch(html, /Preview restore/);
  h.button('Recheck exact change').props.onClick();
  assert.equal(h.calls.at(-1)[0], 'controls:recheck');
});
test('history read waits for the parent inventory request and manual source capture to settle', () => {
  const h = harness({ controlsReady: false }, null, 'codexControls=history');
  h.render();
  assert.equal(h.controls.enabled, false);
  const source = harness({}, null, 'codexControls=history');
  source.action.busy = true;
  source.render();
  assert.equal(source.controls.enabled, false);
});
