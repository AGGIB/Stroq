import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorHarness, workspace } from './workspace-monitor-client-harness.mjs';
const context = 'codex-context-' + 'a'.repeat(64);
const state = () => ({
  schema: 'stroq-codex-skill-controls/1',
  controlContextId: context,
  generatedAt: '2026-10-26T01:00:00.000Z',
  available: true,
  history: 'missing',
  records: [],
  error: null,
});
const fixtures = () => ({
  queue: true,
  state: () => ({
    '/api/inventory/codex-controls': state(),
    '/api/inventory': {
      schema: 'stroq-inventory/1',
      source: 'local',
      generatedAt: '2026-10-26T01:00:00.000Z',
      workspace: { id: workspace, label: 'Fixture' },
      baseline: { status: 'missing', reviewedAt: null },
      items: [],
      gaps: [],
      limitations: [],
    },
  }),
});
test('Protection reads Codex skill history once, after the inventory worker settles, without capture or polling', async () => {
  const h = monitorHarness(fixtures());
  h.control.hold = '/api/inventory';
  h.render();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path === '/api/inventory/codex-controls').length, 0);
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.codexSkillControls?.controlContextId, context);
  assert.equal(h.calls.filter((c) => c.path === '/api/inventory/codex-controls').length, 1);
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  assert(h.calls.every((c) => c.body === undefined));
  h.unmount();
});
test('failed or malformed passive reads hide current declarations and keep unknown writes independently', async () => {
  for (const kind of ['fail', 'bad']) {
    const h = monitorHarness(fixtures());
    h.render();
    await h.flush();
    h.codexSkillWrites.set('fixture', {
      preview: { controlContextId: context },
      startedAt: 'fixture',
    });
    h.control[kind] = '/api/inventory/codex-controls';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.codexSkillControls, null);
    assert.equal(h.output.unconfirmedCodexSkillControls.length, 1);
    assert.equal(h.codexSkillWrites.size, 1);
    h.control[kind] = '';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.codexSkillControls.records.length, 0);
    assert.equal(h.output.unconfirmedCodexSkillControls.length, 1);
    h.unmount();
  }
});
