import test from 'node:test';
import assert from 'node:assert/strict';
import { codexSourcesFixture, candidateId, sourceId } from './codex-skill-sources-fixtures.mjs';
import { harness } from './codex-skill-sources-ui-harness.mjs';
test('both manual entry points inspect once on click and never during rendering', () => {
  for (const compact of [false, true]) {
    const h = harness({ compact });
    const html = h.render();
    assert.match(html, compact ? /Skill sources/ : /Codex sources/);
    assert.deepEqual(h.calls, []);
    h.open();
    assert.deepEqual(h.calls, ['inspect']);
    h.render();
    assert.deepEqual(h.calls, ['inspect']);
  }
});
test('drawer separates source presence, captured user configuration and unverified session loading', () => {
  const h = harness();
  h.action.report = codexSourcesFixture();
  h.open();
  const html = h.render();
  for (const text of [
    'Files and user declarations',
    'session loading unverified',
    'Source chain',
    'Present',
    'Absent',
    'Uninspected',
    'User config: disabled',
    '<dt>Codex data directory</dt><dd>Default</dd>',
    'User configuration',
    'Named profile and session overrides are unverified',
    'Ancestor',
    '../.agents/skills',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(
    html,
    /User profile|Default profile|Profile configuration|data-tone="green"|Loaded by Codex|Active skill|Protected|href="\/skills|Mark reviewed|Quarantine/,
  );
});
test('same-name candidates remain distinct and unknown or unspecified user config declarations remain explicit', () => {
  const h = harness(),
    report = codexSourcesFixture(),
    first = report.items[0];
  report.items = ['disabled', 'enabled', 'not-specified', 'unknown'].map((declaredState, n) => ({
    ...first,
    id: candidateId(n + 1),
    declaredState,
    ...(n === 3
      ? {
          location: { label: 'Folder name withheld', redacted: true },
          metadata: 'invalid',
          entrypointSha256: null,
          scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
        }
      : {}),
  }));
  report.sources[0].candidates = report.items.length;
  report.gaps.push({ code: 'metadata-invalid', sourceId: first.sourceId });
  h.action.report = report;
  h.open();
  const html = h.render();
  for (const label of [
    'User config: disabled',
    'User config: enabled',
    'User config: not specified',
    'User config: unknown',
    'Metadata unverified',
    'Skill metadata could not be verified by this inspection',
    'Entrypoint fingerprint unavailable',
  ])
    assert.ok(html.includes(label), label);
  assert.equal((html.match(/data-candidate-id=/g) ?? []).length, 4);
  assert.match(html, /Folder name withheld/);
  assert.ok(html.includes(candidateId(4).slice(-8)));
  assert.doesNotMatch(html, /Metadata invalid|Skill metadata is invalid/);
});
test('derived details identify entrypoint-only fingerprints, static rule evidence and capability counts', () => {
  const h = harness();
  h.action.report = codexSourcesFixture();
  h.open();
  const html = h.render();
  for (const value of [
    'SKILL.md SHA-256',
    'b'.repeat(64),
    'INJ.1',
    'Instruction override',
    'high',
    'fs.read',
    '2',
    '1 additional match omitted',
  ])
    assert.ok(html.includes(value), value);
  assert.match(html, /Entrypoint only/);
  assert.doesNotMatch(html, /Full tree fingerprint|No signals|Safe skill/);
  const exported = h.elements
    .find(({ props }) => props.label === 'Export source evidence')
    .props.data();
  assert.deepEqual(exported.report, h.action.report);
  assert.equal(exported.historical, false);
});
test('custom data directory, unknown config, partial sources and uninspected families remain observable', () => {
  const h = harness(),
    report = codexSourcesFixture();
  report.context.profile = 'custom';
  report.context.boundary = 'unverifiable';
  report.context.ancestorCount = 0;
  report.context.markerPolicy = 'unverified';
  report.settings.status = 'unsupported';
  Object.assign(report.sources[0], {
    status: 'partial',
    scope: 'cwd',
    distance: 0,
    label: '.agents/skills',
  });
  report.items[0].declaredState = 'unknown';
  report.omitted = { sources: 2, items: 3 };
  h.action.report = report;
  h.open();
  const html = h.render();
  for (const text of [
    '<dt>Codex data directory</dt><dd>Custom</dd>',
    'Unsupported',
    'Partial',
    'Boundary unverified',
    'Codex legacy',
    'System',
    'Admin',
    'Plugins',
    '2 sources',
    '3 entrypoints',
  ])
    assert.ok(html.includes(text), text);
});
test('equal-name shared and Codex legacy copies expose their own source and scope inside each candidate', () => {
  const h = harness(),
    report = codexSourcesFixture(),
    first = report.items[0];
  const roots = [
    { family: 'agents', scope: 'cwd', distance: 0, label: '.agents/skills' },
    { family: 'codex-legacy', scope: 'cwd', distance: 0, label: '.codex/skills' },
    { family: 'agents', scope: 'user', distance: null, label: '~/.agents/skills' },
    { family: 'codex-legacy', scope: 'user', distance: null, label: '~/.codex/skills' },
  ];
  report.sources = roots.map((source, n) => ({
    ...source,
    id: sourceId(n + 1),
    status: 'complete',
    candidates: 1,
  }));
  report.items = roots.map((_, n) => ({
    ...first,
    id: candidateId(n + 1),
    sourceId: sourceId(n + 1),
    name: 'Release notes',
    location: { label: 'release/notes', redacted: false },
    declaredState: n === 0 ? 'disabled' : 'enabled',
  }));
  report.gaps = [{ code: 'source-limit' }];
  h.action.report = report;
  h.open();
  const html = h.render();
  const candidates = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(
    (match) => match[0],
  );
  assert.equal(candidates.length, 4);
  for (const [index, expected] of [
    'Shared · Current directory',
    'Codex legacy · Current directory',
    'Shared · User',
    'Codex legacy · User',
  ].entries()) {
    assert.ok(candidates[index].replace(/<[^>]*>/g, '').includes(expected), expected);
    assert.ok(candidates[index].includes('release/notes'));
    assert.ok(
      candidates[index].includes(index === 0 ? 'User config: disabled' : 'User config: enabled'),
    );
  }
  assert.match(html, /Source inspection limit reached/);
  assert.doesNotMatch(
    html,
    /Compatibility|Project trust required|Trust required|Active skill|Loaded by Codex/,
  );
});
test('an unverified CODEX_HOME is labelled as an unverified data directory, not a named profile', () => {
  const h = harness(),
    report = codexSourcesFixture();
  report.context.profile = 'unverified';
  report.settings.status = 'unsupported';
  report.settings.sha256 = null;
  report.items = report.items.map((item) => ({ ...item, declaredState: 'unknown' }));
  report.gaps.push({ code: 'custom-profile-unsupported' });
  h.action.report = report;
  h.open();
  const html = h.render();
  assert.match(html, /<dt>Codex data directory<\/dt><dd>Unverified<\/dd>/);
  assert.match(html, /Custom Codex data directory is unsupported/);
  assert.doesNotMatch(
    html,
    /User profile|Default profile|Custom profile|Profile unverified|Profile configuration/,
  );
});
test('failed refresh keeps historical result visible with retry and an export labelled historical', () => {
  const h = harness();
  h.action.report = codexSourcesFixture();
  h.action.historical = true;
  h.action.error = 'Source inspection failed. Retry to inspect again.';
  h.open();
  const html = h.render();
  assert.match(html, /Historical capture/);
  assert.match(html, /Source inspection failed/);
  assert.equal(h.button('Inspect again').props.disabled, false);
  const exported = h.elements
    .find(({ props }) => props.label === 'Export source evidence')
    .props.data();
  assert.equal(exported.historical, true);
});
test('close cancels a pending read, restores trigger focus and disabled entry cannot inspect', () => {
  const h = harness();
  let focused = 0;
  h.render();
  h.button('Codex sources').props.onClick({
    currentTarget: {
      isConnected: true,
      focus() {
        focused++;
      },
    },
  });
  h.render();
  const content = h.elements.find(({ type }) => type === h.Dialog.Content);
  content.props.onCloseAutoFocus({ preventDefault() {} });
  assert.equal(focused, 1);
  h.elements.find(({ type }) => type === h.Dialog.Root).props.onOpenChange(false);
  assert.deepEqual(h.calls, ['inspect', 'cancel', 'controls:cancel']);
  const blocked = harness({ disabled: true });
  blocked.render();
  assert.equal(blocked.button('Codex sources').props.disabled, true);
  blocked.button('Codex sources').props.onClick({ currentTarget: {} });
  assert.deepEqual(blocked.calls, []);
});
test('actual agent cards expose the shared compact inspection only for Codex without auto capture', () => {
  for (const id of ['claude-code', 'cursor', 'codex', 'windsurf']) {
    const h = harness(
      {},
      {
        id,
        scopes: [
          {
            scope: 'project',
            state: 'missing',
            approval: 'not-required',
            events: [],
            reason: 'hooks-missing',
          },
        ],
        observation: { state: 'missing', lastHookAt: null },
        proof: { state: 'unsupported', checkedAt: null },
      },
    );
    const html = h.render();
    assert.equal(html.includes('Skill sources'), id === 'codex');
    assert.equal(html.includes('Network guard'), id === 'codex');
    assert.equal(html.includes('Credential paths'), id === 'codex');
    assert.equal(!!h.button('Manage'), id === 'codex');
    assert.deepEqual(h.calls, []);
  }
});
test('close falls back to the live entry wrapper when the original trigger became disabled', () => {
  const h = harness();
  let fallback = 0;
  h.render();
  h.button('Codex sources').props.onClick({
    currentTarget: {
      isConnected: true,
      disabled: true,
      focus() {
        assert.fail('disabled trigger cannot receive focus');
      },
    },
  });
  h.render();
  const anchor = h.elements.find(
    ({ type, props }) => type === 'span' && props.className === 'codex-source-trigger',
  );
  assert.ok(anchor);
  anchor.props.ref.current = {
    focus() {
      fallback++;
    },
  };
  h.elements
    .find(({ type }) => type === h.Dialog.Content)
    .props.onCloseAutoFocus({ preventDefault() {} });
  assert.equal(fallback, 1);
});
