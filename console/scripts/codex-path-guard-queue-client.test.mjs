import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
} from './workspace-monitor-client-harness.mjs';
import * as f from './codex-path-guard-client-fixtures.mjs';
import * as network from './codex-network-client-fixtures.mjs';
const fixtures = () => ({
  queue: true,
  state: () => ({
    '/api/inventory': {
      schema: 'stroq-inventory/1',
      source: 'local',
      generatedAt: '2026-10-27T00:00:00.000Z',
      workspace: { id: workspace, label: 'Fixture' },
      baseline: { status: 'missing', reviewedAt: null },
      items: [],
      gaps: [],
      limitations: [],
    },
    '/api/inventory/codex-controls': {
      schema: 'stroq-codex-skill-controls/1',
      controlContextId: f.context,
      generatedAt: '2026-10-27T00:00:00.000Z',
      available: true,
      history: 'missing',
      records: [],
      error: null,
    },
    '/api/codex-network-guard': network.state(),
    '/api/codex-network-checks': { ...network.checkState(), workspaceId: workspace },
    '/api/codex-path-guard': { ...f.state(), history: 'missing' },
  }),
});
async function setup() {
  const h = monitorHarness(fixtures());
  h.render();
  await h.flush();
  return h;
}
test('Protection serializes one path-history GET after network reads and never captures, polls or writes', async () => {
  const h = monitorHarness(fixtures());
  h.control.hold = '/api/codex-network-checks';
  h.render();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path === '/api/codex-path-guard').length, 0);
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.codexPathGuard.controlContextId, f.context);
  assert.deepEqual(
    h.calls.slice(-3).map((c) => c.path),
    ['/api/codex-network-guard', '/api/codex-network-checks', '/api/codex-path-guard'],
  );
  assert(h.calls.every((c) => c.body === undefined));
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('pending subscription only rerenders and preserves unknowns across absent history or later matching declaration', async () => {
  const h = await setup(),
    preview = f.preview();
  h.pathGuardWrites.set('fixture', { preview, startedAt: preview.createdAt });
  const count = h.calls.length;
  h.notifyPathGuardWrites();
  await h.flush();
  assert.equal(h.output.unconfirmedCodexPaths.length, 1);
  assert.equal(h.calls.length, count);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.codexPathGuard.records.length, 0);
  assert.equal(h.output.unconfirmedCodexPaths.length, 1);
  h.control.state['/api/codex-path-guard'] = f.state([f.record()]);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.unconfirmedCodexPaths.length, 1);
  assert.equal(h.pathGuardWrites.size, 1);
  h.unmount();
});
test('failed malformed or foreign-context state stays unavailable independently of exact pending', async () => {
  for (const kind of ['fail', 'bad', 'foreign']) {
    const h = await setup(),
      preview = f.preview();
    h.pathGuardWrites.set('fixture', { preview, startedAt: preview.createdAt });
    if (kind === 'foreign')
      h.control.state['/api/codex-path-guard'].controlContextId = 'codex-context-' + '9'.repeat(64);
    else h.control[kind] = '/api/codex-path-guard';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.codexPathGuard, null);
    assert.equal(h.output.unconfirmedCodexPaths.length, 1);
    assert.doesNotMatch(h.output.error ?? '', /PRIVATE/);
    h.unmount();
  }
});
test('existing45s deadline clears path snapshot and ignores late response without starting another operation', async () => {
  const h = await setup();
  h.control.hold = '/api/codex-path-guard';
  const refresh = h.output.refresh();
  await h.flush();
  assert.equal(h.output.codexPathGuard, null);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  assert.equal(h.calls.at(-1).signal.aborted, true);
  const count = h.calls.length;
  h.control.hold = '';
  h.release();
  await refresh;
  await h.flush();
  assert.equal(h.output.codexPathGuard, null);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('workspace context and transport changes synchronously hide current path facts', async () => {
  for (const kind of ['workspace', 'context', 'transport']) {
    const h = await setup();
    if (kind === 'transport') {
      const transport = h.platform.requestLocal;
      h.platform.requestLocal = (...args) => transport(...args);
    } else
      h.platform.localContext = {
        workspace: { id: kind === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    assert.equal(h.output.codexPathGuard, null);
    h.unmount();
  }
});
