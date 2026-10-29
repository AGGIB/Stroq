import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
  runtime,
  revision,
} from './workspace-monitor-client-harness.mjs';
const at = '2026-10-24T00:00:00.000Z',
  nextAt = '2026-10-24T01:01:00.000Z';
function fixtures() {
  return {
    queue: true,
    state: () => ({
      '/api/inventory': {
        schema: 'stroq-inventory/1',
        source: 'local',
        generatedAt: at,
        workspace: { id: workspace, label: 'Fixture' },
        baseline: { status: 'missing', reviewedAt: null },
        items: [],
        gaps: [],
        limitations: [],
      },
      '/api/workspace-monitor': {
        schema: 'stroq-workspace-monitor/1',
        workspaceId: workspace,
        reason: null,
        revision,
        configuredAt: at,
        runtimeSha256: runtime,
        status: 'enabled',
        intervalMs: 300000,
        nextCheckAt: '2026-10-24T01:05:00.000Z',
        activeRunId: null,
        lastAttempt: null,
      },
      '/api/workspace-review': {
        schema: 'stroq-workspace-review/1',
        workspaceId: workspace,
        engine: { available: true, version: '0.28.0' },
        history: { status: 'ready' },
        baseline: { status: 'missing', revision: null, reviewedAt: null, capture: null },
        runs: [],
      },
    }),
  };
}
async function start() {
  const h = monitorHarness(fixtures());
  h.render();
  await h.flush();
  return h;
}
test('only a valid matching inventory read updates inventory freshness; unrelated polls never do', async () => {
  const h = await start();
  assert.equal(h.output.inventoryFreshness, 'current');
  assert.equal(h.output.inventory.generatedAt, at);
  const retained = h.output.inventory;
  await h.advance(1000);
  h.control.fail = '/api/inventory';
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.inventory, retained);
  assert.equal(h.output.inventoryFreshness, 'historical');
  assert.equal(h.output.inventory.generatedAt, at);
  const before = h.calls.length;
  h.control.state['/api/workspace-monitor'].revision = 'e'.repeat(64);
  await h.advance(10000);
  assert.deepEqual(
    h.calls
      .slice(before)
      .map((v) => v.path)
      .sort(),
    ['/api/mcp-governance', '/api/workspace-monitor', '/api/workspace-review'],
  );
  assert.equal(h.output.workspaceMonitor.revision, 'e'.repeat(64));
  assert.equal(h.output.inventoryFreshness, 'historical');
  assert.equal(h.output.inventory.generatedAt, at);
  h.control.fail = '';
  h.control.state['/api/inventory'].generatedAt = nextAt;
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.inventoryFreshness, 'current');
  assert.equal(h.output.inventory.generatedAt, nextAt);
  assert(h.calls.every((v) => v.body === undefined));
  h.unmount();
});
test('invalid and foreign inventory replies cannot refresh retained evidence or fabricate empty current', async () => {
  for (const kind of ['invalid', 'foreign'])
    for (const retained of [false, true]) {
      const h = monitorHarness(fixtures());
      if (retained) {
        h.render();
        await h.flush();
      }
      if (kind === 'invalid') h.control.bad = '/api/inventory';
      else h.control.state['/api/inventory'].workspace.id = foreignWorkspace;
      if (retained) await h.output.refresh();
      else h.render();
      await h.flush();
      assert.equal(h.output.inventoryFreshness, retained ? 'historical' : 'unavailable');
      assert.equal(h.output.inventory?.generatedAt ?? null, retained ? at : null);
      h.unmount();
    }
});
test('pending, deadline and late ignored-abort inventory replies remain historical until a new read', async () => {
  const h = await start();
  const retained = h.output.inventory;
  h.control.hold = '/api/inventory';
  h.control.state['/api/inventory'].generatedAt = nextAt;
  const pending = h.output.refresh();
  await h.flush();
  assert.equal(h.output.inventoryFreshness, 'historical');
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  assert.equal(h.output.inventoryFreshness, 'historical');
  assert.equal(h.output.inventory, retained);
  h.control.hold = '';
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.inventoryFreshness, 'historical');
  assert.equal(h.output.inventory.generatedAt, at);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.inventoryFreshness, 'current');
  assert.equal(h.output.inventory.generatedAt, nextAt);
  h.unmount();
});
test('context changes synchronously hide inventory and its prior successful read state', async () => {
  const h = await start();
  h.platform.localContext = { workspace: { id: foreignWorkspace, label: 'Other' } };
  h.render(false);
  assert.equal(h.output.inventory, null);
  assert.equal(h.output.inventoryFreshness, 'unavailable');
  h.unmount();
});
test('an accepted watch check can refresh only current inventory without rerunning unrelated checks', async () => {
  const h = await start(),
    before = h.calls.length;
  h.control.state['/api/inventory'].generatedAt = nextAt;
  assert.equal(h.output.refreshInventory(), true);
  await h.flush();
  assert.deepEqual(
    h.calls.slice(before).map((call) => call.path),
    ['/api/inventory'],
  );
  assert.equal(h.output.inventory.generatedAt, nextAt);
  assert.equal(h.output.inventoryFreshness, 'current');
  assert(h.calls.every((call) => call.body === undefined));
  h.unmount();
});
test('watch-triggered inventory refresh refuses overlapping reads and preserves historical evidence after failure', async () => {
  const h = await start(),
    retained = h.output.inventory;
  h.control.hold = '/api/inventory';
  assert.equal(h.output.refreshInventory(), true);
  await h.flush();
  const count = h.calls.length;
  assert.equal(h.output.refreshInventory(), false);
  assert.equal(h.calls.length, count);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  assert.equal(h.output.inventoryFreshness, 'historical');
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.inventory, retained);
  h.control.bad = '/api/inventory';
  assert.equal(h.output.refreshInventory(), true);
  await h.flush();
  assert.equal(h.output.inventory, retained);
  assert.equal(h.output.inventoryFreshness, 'historical');
  h.unmount();
  assert.equal(h.output.refreshInventory(), false);
});
test('a new watch check can recover inventory after the initial full projection reached its deadline', async () => {
  const h = monitorHarness(fixtures());
  h.control.hold = 'load';
  h.render();
  await h.flush();
  await h.advance(45000);
  assert.equal(h.output.inventory, null);
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.refreshInventory(), true);
  await h.flush();
  assert.equal(h.output.inventory?.generatedAt, at);
  assert.equal(h.output.inventoryFreshness, 'current');
  h.unmount();
});
test('a batched full refresh restarts enabled-watch polling even with an unchanged clock and state', async () => {
  const h = await start();
  const at = h.output.refreshedAt;
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.refreshedAt, at);
  const before = h.calls.length;
  await h.advance(10000);
  assert.deepEqual(
    h.calls
      .slice(before)
      .map((v) => v.path)
      .sort(),
    ['/api/mcp-governance', '/api/workspace-monitor', '/api/workspace-review'],
  );
  assert.equal(h.output.inventoryFreshness, 'current');
  h.unmount();
});
