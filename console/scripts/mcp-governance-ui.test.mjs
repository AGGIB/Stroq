import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { governanceUI } from './mcp-governance-ui-harness.mjs';
const f = await tsImport('../lib/mcp-governance-fixtures.ts', { parentURL: import.meta.url });
const query = `mcpGovernance=history&governanceContext=${f.governanceContext}&governanceOperation=${f.governanceId(3)}&governanceWorkspace=${f.governanceWorkspace}`;
test('manual draft selection shows policy-only baseline and does not inspect on open', () => {
  const h = governanceUI();
  const html = h.open();
  assert.match(html, /Govern MCP calls/);
  assert.match(html, /Inspect configured servers/);
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(html, /Protected|Start server|Observe mode/);
});
test('capture lists each channel binding and retained choices separately; selection sends only opaque id', () => {
  const h = governanceUI();
  h.action.capture = f.governanceCapture();
  h.open();
  const i = h.elements.find((e) => e.type === 'input' && e.props.type === 'checkbox');
  assert(i);
  i.props.onChange({ target: { checked: true } });
  assert.deepEqual(h.calls.at(-1), ['select', h.action.capture.choices[0].id, true]);
  assert.match(h.render(), /Claude Code/);
  h.button('Preview MCP policy').props.onClick();
  assert.equal(h.calls.at(-1), 'preview');
});
test('review distinguishes actual core fixtures from adoption and requires shared/private copies consents', () => {
  const h = governanceUI();
  h.action.preview = f.governancePreview();
  const html = h.open();
  assert.match(html, /Unlisted and unknown identities are denied/);
  assert.match(html, /Other policy checks still apply/);
  assert.match(html, /Older runtimes reject policy v2/);
  assert.match(html, /unencrypted policy copies/);
  assert.match(html, /Existing proxies need restart/);
  assert.match(html, /Core fixtures/);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    2,
  );
  assert.equal(h.button('Apply MCP policy').props.disabled, true);
  assert.doesNotMatch(html, /Native verified|Host protected/);
});
test('weakening interruptions and recovery acknowledgements are separate', () => {
  const h = governanceUI();
  h.action.preview = {
    ...f.governancePreview(),
    requiresWeakening: true,
    requiresInterruptions: true,
    requiresRecoveryReview: true,
    unconfirmedRecords: [
      { id: f.governanceId(9), revision: '9'.repeat(64), operationId: f.governanceId(8) },
    ],
  };
  const html = h.open();
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    5,
  );
  assert.match(html, /earlier operations remain unconfirmed/);
  assert.match(html, /allowances|allowance/);
});
test('exact historical operation focuses after admission once and links full policy restoration', () => {
  const h = governanceUI(query, { effects: true });
  h.action.state = f.governanceState([f.governanceRecord()]);
  h.action.busy = 'load';
  h.render();
  h.commit();
  assert.equal(h.focused.length, 0);
  h.action.busy = null;
  const html = h.render();
  h.commit();
  assert.equal(h.focused.length, 1);
  assert.equal(h.scrolled.length, 1);
  assert.match(html, /Preview whole-policy restore/);
  assert.match(html, /policies\/history/);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1);
});
test('foreign or missing exact operation never falls back to another action', () => {
  for (const ctx of [f.governanceContext, 'governance-context-' + '9'.repeat(64)]) {
    const h = governanceUI(query.replace(f.governanceContext, ctx));
    h.action.state = f.governanceState([]);
    const html = h.render();
    assert.match(html, /Show current history/);
    assert.doesNotMatch(html, /Inspect configured servers|Preview whole-policy restore/);
  }
});
test('unknown pending remains visible even missing from unavailable retained history', () => {
  const h = governanceUI('mcpGovernance=history');
  h.action.state = { ...f.governanceState(), history: 'unavailable' };
  h.action.pending = [{ preview: f.governancePreview(), startedAt: new Date().toISOString() }];
  const html = h.render();
  assert.match(html, /Completion unknown/);
  assert.match(html, /could not be verified/);
  assert.doesNotMatch(html, /No retained operations/);
});
test('unsupported registration has no invented channel or selectable authority; masked eligible can be retained', () => {
  const h = governanceUI();
  h.action.capture = f.governanceCapture();
  h.action.capture.choices[0] = {
    ...h.action.capture.choices[0],
    pair: null,
    eligibility: 'unsupported',
    reason: 'unsupported-agent',
  };
  h.open();
  const i = h.elements.find((e) => e.type === 'input' && e.props.type === 'checkbox');
  assert.equal(i.props.disabled, true);
  assert.doesNotMatch(h.render(), /undefined/);
  h.action.capture.choices[0] = {
    ...f.governanceChoice(),
    pair: f.governancePair({ redacted: true, label: 'Identity cccccccc' }),
  };
  h.render();
  assert.equal(
    h.elements.find((e) => e.type === 'input' && e.props.type === 'checkbox').props.disabled,
    false,
  );
});
test('preview focuses once after admission; later rerenders never snap', () => {
  const h = governanceUI('', { effects: true });
  h.action.preview = f.governancePreview();
  h.action.busy = 'preview';
  h.open();
  h.commit();
  assert.equal(h.focused.length, 0);
  h.action.busy = null;
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1);
});
test('browser-local unknown review remains separate from server recovery consent', () => {
  const h = governanceUI();
  h.action.preview = {
    ...f.governancePreview(),
    requiresRecoveryReview: true,
    unconfirmedRecords: [
      { id: f.governanceId(9), revision: '9'.repeat(64), operationId: f.governanceId(8) },
    ],
  };
  h.action.pending = [{ preview: f.governancePreview(), startedAt: new Date().toISOString() }];
  const html = h.open();
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    4,
  );
  assert.match(html, /earlier browser operations remain unknown/);
});
test('whole-policy Restore explicitly exposes v2 gate removal even when ordinary rule counts are equal', () => {
  const h = governanceUI(),
    p = f.governancePreview(),
    before = { defaultEffect: 'allow', threshold: 80, rules: 3 };
  const html = h.renderRestore({
    target: 'backup',
    mcpGovernance: {
      ...f.governanceRestoreDiff(),
      current: { policyVersion: 2, gate: 'enforced', allowed: [f.governancePair()] },
      candidate: { policyVersion: 1, gate: 'absent', allowed: [] },
      diff: { added: [], removed: [f.governancePair()], retained: [] },
    },
    check: p.check,
    simulation: p.simulation,
    regressions: p.regressions,
    settings: { current: before, candidate: before },
    decisions: [],
    interruptions: [],
    blockers: [],
    expiresAt: p.expiresAt,
  });
  assert.match(html, /whole policy, including all rules/);
  assert.match(html, /removes the MCP gate/);
  assert.match(html, /1 removed/);
  assert.match(html, /I accept that restoring this policy may reduce protection/);
});
test('channel-labelled choice deduplicates source copy while retaining distinct Project and User origins', () => {
  const h = governanceUI();
  h.action.capture = f.governanceCapture();
  const row = h.action.capture.choices[0],
    ref = row.sourceRefs[0];
  row.pair = { ...row.pair, channel: 'cursor' };
  row.sourceRefs = [
    { ...ref, agent: 'cursor', sourceId: 'cursor-project', label: 'Cursor · project' },
    {
      ...ref,
      id: 'item-' + '5'.repeat(24),
      agent: 'cursor',
      sourceId: 'cursor-project',
      label: 'Cursor · project',
    },
    {
      ...ref,
      id: 'item-' + '6'.repeat(24),
      agent: 'cursor',
      scope: 'user',
      sourceId: 'cursor-user',
      label: 'Cursor · user',
    },
  ];
  const html = h.open();
  assert.match(html, /Project · User/);
  assert.doesNotMatch(html, /Cursor · project|Cursor · user|project · project/);
  const choice = h.elements.find(
    (e) => e.type === 'label' && e.props.className === 'mcp-governance-choice',
  );
  assert(choice);
  assert.equal((html.match(/>Cursor</g) ?? []).length, 1);
  assert.match(html, />notes</);
  assert.equal(h.calls.length, 0);
});
test('in-flight Apply is awaiting confirmation while prior current policy stays unverified after accepted receipt', () => {
  const h = governanceUI();
  h.action.pending = [{ preview: f.governancePreview(), startedAt: new Date().toISOString() }];
  h.action.busy = 'apply';
  assert.match(h.open(), /Applying · awaiting confirmation/);
  assert.doesNotMatch(h.render(), /Earlier completion unknown/);
  h.action.busy = 'load';
  h.action.state = {
    ...f.governanceState(),
    editable: false,
    current: { policyVersion: null, gate: 'unavailable', allowed: [] },
  };
  const html = h.render();
  assert.match(html, /Current policy could not be verified/);
  assert.doesNotMatch(html, /Current declared policy · v1/);
});
test('deny-all link opens focused block panel without Capture and explicit Preview starts only the block workflow', () => {
  const h = governanceUI('mcpGovernance=capture&governanceDraft=deny-all');
  h.action.prepareDenyAll = () => h.calls.push('block-preview');
  const html = h.render();
  assert.match(html, /Block MCP calls/);
  assert.match(html, /All workspaces using this Stroq home/);
  assert.match(html, /Servers and in-flight calls continue/);
  assert.equal(h.calls.length, 0);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    0,
  );
  h.button('Preview block MCP calls').props.onClick();
  assert.deepEqual(h.calls, ['block-preview']);
});
test('already declared empty v2 list is informational and never claims active native coverage', () => {
  const h = governanceUI('mcpGovernance=capture&governanceDraft=deny-all');
  h.action.state = {
    ...f.governanceState(),
    current: { policyVersion: 2, gate: 'enforced', allowed: [] },
  };
  const html = h.render();
  assert.match(html, /Already declared/);
  assert.match(html, /running agent or proxy/);
  assert.doesNotMatch(html, /Protected|Live verified/);
  assert.equal(h.button('Preview block MCP calls').props.disabled, true);
});
test('block preview preserves captured partial-source gaps in the existing review', () => {
  const h = governanceUI('mcpGovernance=capture&governanceDraft=deny-all');
  h.action.capture = f.governanceCapture();
  h.action.capture.gaps = [
    { code: 'partial-capture', agent: null, scope: 'unknown', sourceId: null },
  ];
  h.action.preview = f.governancePreview();
  h.action.preview.selected = [];
  h.action.preview.diff = { added: [], removed: [], retained: [] };
  const html = h.render();
  assert.match(html, /Inspection gaps/);
  assert.match(html, /partial registration capture/);
  assert.match(html, /all governed MCP calls/);
  assert.equal(h.button('Apply MCP policy').props.disabled, true);
});
test('invalid duplicate and foreign block links never offer the block workflow or substitute another context', () => {
  for (const q of [
    'mcpGovernance=history&governanceDraft=deny-all',
    'mcpGovernance=capture&governanceDraft=deny-all&governanceDraft=deny-all',
    `mcpGovernance=capture&governanceDraft=deny-all&governanceContext=governance-context-${'9'.repeat(64)}`,
    `mcpGovernance=capture&governanceDraft=deny-all&governanceWorkspace=workspace-${'9'.repeat(24)}`,
  ]) {
    const h = governanceUI(q);
    const html = h.render();
    assert.match(html, /Show current history/);
    assert.equal(h.button('Preview block MCP calls'), undefined);
    assert.equal(h.calls.length, 0);
  }
});
test('explicit Manage listed identities returns to the normal captured checkbox draft without requests', () => {
  const h = governanceUI('mcpGovernance=capture&governanceDraft=deny-all');
  h.action.capture = f.governanceCapture();
  h.render();
  h.button('Manage listed identities').props.onClick();
  const html = h.render();
  assert.match(html, /Choose reported identities/);
  assert.equal(
    h.elements.filter((e) => e.type === 'input' && e.props.type === 'checkbox').length,
    1,
  );
  assert.equal(h.calls.filter((c) => c === 'capture' || c === 'block-preview').length, 0);
});
