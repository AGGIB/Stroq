import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './codex-skill-sources-ui-harness.mjs';
const ids = ['claude-code', 'cursor', 'codex', 'windsurf'];
const agent = (id, patch = {}) => ({
  id,
  scopes: ['project', 'user'].map((scope) => ({
    scope,
    state: 'missing',
    approval: 'not-required',
    events: [],
    reason: 'hooks-missing',
  })),
  observation: { state: 'missing', lastHookAt: null },
  proof: { state: 'unsupported', checkedAt: null },
  ...patch,
});
const report = () => ({
  schema: 'stroq-agents/1',
  source: 'local',
  generatedAt: '2026-10-27T00:00:00.000Z',
  agents: ids.map((id) => agent(id)),
});
test('Agents presents all four branded rows without the three large inspection metrics', () => {
  const h = harness({ page: true, pageReport: report() }),
    html = h.render();
  assert.equal((html.match(/class="[^"]*agent-row[\s"]/g) ?? []).length, 4);
  assert.doesNotMatch(
    html,
    /stat-grid|Agents inspected|Hooks configured|Approval unverified<\/span><strong/,
  );
  for (const id of ids) assert(html.includes(`id="${id}"`));
  assert.deepEqual(h.calls, []);
});
test('Codex controls remain outside Details with real component state and no capture on render', () => {
  const h = harness({}, agent('codex')),
    html = h.render();
  const details = html.indexOf('<details class="agent-row-details"'),
    actions = html.indexOf('class="agent-row-controls"');
  assert(actions >= 0 && details > actions);
  for (const text of ['Network guard', 'Credential paths', 'Skill sources'])
    assert(html.indexOf(text) < details);
  assert.equal(h.button('Manage').props.disabled, false);
  assert.deepEqual(h.calls, []);
});
test('each agent offers its scoped offline hook check before the separate in-agent subscription test', () => {
  const descendants = (value) => {
    if (Array.isArray(value)) return value.flatMap(descendants);
    if (!value || typeof value !== 'object') return [];
    return [value, ...descendants(value.props?.children)];
  };
  const h = harness({ page: true, pageReport: report() });
  h.render();
  for (const id of ids) {
    const card = h.elements.find((e) => e.type === 'article' && e.props.id === id);
    const primary = descendants(card).find(
      (e) => e.type === 'div' && e.props.className === 'agent-row-actions',
    );
    const details = descendants(card).find(
      (e) => e.type === 'div' && e.props.className === 'agent-row-detail-actions',
    );
    const offline = descendants(primary).find((e) => e.props?.label === 'Test hook');
    assert(offline, id + ' offers the model-free check without opening Details');
    assert.equal(offline.props.agent, id);
    assert.equal(offline.props.scope, 'project');
    assert.equal(typeof offline.props.onChanged, 'function');
    assert(!descendants(primary).some((e) => e.props?.label === 'Test in agent'));
    assert(descendants(details).some((e) => e.props?.label === 'Test in agent'));
    assert(!descendants(details).some((e) => e.props?.label === 'Test hook'));
    assert.deepEqual(h.calls, []);
  }
});
test('native Details preserves approval, hook evidence, native gap, observation and events without toggle requests', () => {
  const a = agent('codex');
  a.scopes[0] = {
    ...a.scopes[0],
    state: 'changed',
    approval: 'unknown',
    reason: 'hook-changed',
    events: [{ event: 'PreToolUse', state: 'changed' }],
  };
  a.proof = { state: 'stale', checkedAt: '2026-10-26T00:00:00.000Z' };
  a.observation = { state: 'recorded', lastHookAt: '2026-10-26T01:00:00.000Z' };
  const h = harness({}, a),
    html = h.render();
  // The row says one state in plain words; the exact fields stay in Details.
  assert.match(html, /Needs attention/);
  // A changed install shows the Configure button, and the line names that button.
  assert.match(html, /Use Configure to fix it/);
  for (const text of [
    'Hook approval',
    'Not verified',
    'Stroq hook',
    'In-agent check',
    'Needs a fresh check',
    'Last hook on this machine',
    'PreToolUse',
    'Current host version unverified',
  ])
    assert(html.includes(text), text);
  const details = h.elements.find(
    (e) => e.type === 'details' && e.props.className === 'agent-row-details',
  );
  assert(details);
  assert.equal(details.props.onToggle, undefined);
  assert.deepEqual(h.calls, []);
});
test('agent anchor and selected scope remain exact while presentation compacts', () => {
  const h = harness({}, agent('cursor')),
    html = h.render();
  assert.match(html, /<article id="cursor"[^>]*tabindex="-1"/);
  assert.match(html, /Workspace/);
  assert.equal((html.match(/Credential paths/g) ?? []).length, 0);
  assert.deepEqual(h.calls, []);
});
test('scoped row layout keeps a single desktop list and 44px controls without shrinking body type', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../app/agents.css', import.meta.url), 'utf8');
  assert(/\.agent-grid\.agent-rows\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css));
  assert(/\.agent-row-controls button\s*\{[^}]*min-height:\s*44px/.test(css));
  assert(/\.agent-row \.agent-brand\s*\{[^}]*width:\s*30px/.test(css));
  assert(!/font-size:\s*(?:1[0-5]|[0-9])px/.test(css));
});
test('44px row button declarations beat the later global small-button cascade', async () => {
  const { readFileSync } = await import('node:fs');
  const own = readFileSync(new URL('../app/agents.css', import.meta.url), 'utf8'),
    global = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rules = (css) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
      const height = body.match(/min-height:\s*(\d+)px/);
      return height
        ? selectors
            .split(',')
            .map((selector) => ({ selector: selector.trim(), height: Number(height[1]) }))
        : [];
    });
  const specificity = (selector) =>
    (selector.match(/\.[a-z_-][\w-]*/gi) ?? []).length * 100 +
    (/(?:^|\s)button\s*$/.test(selector) ? 1 : 0);
  const small = rules(global).find((r) => r.selector === '.button.small');
  assert(small);
  assert.equal(small.height, 36);
  assert.equal(
    specificity('.agent-row-actions .button'),
    specificity(small.selector),
    'old action selector ties the late small-button rule',
  );
  for (const region of ['agent-row-actions', 'agent-row-detail-actions', 'agent-row-controls']) {
    const candidates = rules(own).filter(
      (r) => r.selector.includes('.' + region) && /(?:\.button|\bbutton)$/.test(r.selector),
    );
    const highest = candidates.sort((a, b) => specificity(b.selector) - specificity(a.selector))[0];
    assert(highest, region);
    const winner = specificity(highest.selector) > specificity(small.selector) ? highest : small;
    assert.equal(winner.height, 44, region + ' must beat the global small rule imported later');
  }
});
