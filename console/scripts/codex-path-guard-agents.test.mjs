import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from './codex-skill-sources-ui-harness.mjs';
function page(connected = true) {
  const pageReport = {
    generatedAt: new Date().toISOString(),
    agents: ['claude-code', 'codex', 'cursor', 'windsurf'].map((id) => ({
      id,
      scopes: ['project', 'user'].map((scope) => ({
        scope,
        state: 'missing',
        reason: 'hooks-missing',
        events: [],
        approval: 'not-required',
      })),
      observation: { state: 'missing', lastHookAt: null },
      proof: { state: 'missing', checkedAt: null },
    })),
  };
  const h = harness({ page: true, pageReport, connected });
  return { html: h.render(), calls: h.calls };
}
test('actual Agents composition exposes the real Credential paths component exactly once under Codex', () => {
  const { html, calls } = page();
  assert.equal((html.match(/class="codex-path-entry"/g) ?? []).length, 1);
  const codex = html.indexOf('id="codex"'),
    entry = html.indexOf('class="codex-path-entry"'),
    cursor = html.indexOf('id="cursor"');
  assert(codex < entry && entry < cursor);
  assert(html.includes('Credential paths'));
  assert.deepEqual(calls, []);
});
test('disconnected supported-agent cards do not fabricate a configured File Guard', () => {
  assert.doesNotMatch(page(false).html, /codex-path-entry|Path denial written|Protected/);
});
test('global stylesheet imports the scoped File Guard surface', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert(css.includes("@import './codex-path-guard.css';"));
});
