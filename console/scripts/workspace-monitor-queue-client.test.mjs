import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
  runtime,
  revision,
} from './workspace-monitor-client-harness.mjs';
function fixtures(status = 'enabled') {
  return {
    queue: true,
    state: () => ({
      '/api/mcp-governance': {
        schema: 'stroq-mcp-governance/1',
        generatedAt: '2026-10-24T01:00:00.000Z',
        contextId: 'governance-context-' + 'a'.repeat(64),
        workspaceId: workspace,
        runtimeSha256: runtime,
        policyRawSha256: null,
        policyFingerprint: revision,
        current: { policyVersion: 1, gate: 'absent', allowed: [] },
        editable: true,
        history: 'missing',
        records: [],
        error: null,
      },
      '/api/workspace-monitor': {
        schema: 'stroq-workspace-monitor/1',
        workspaceId: workspace,
        reason: null,
        revision,
        configuredAt: '2026-10-24T00:00:00.000Z',
        runtimeSha256: runtime,
        status,
        intervalMs: 300000,
        nextCheckAt: status === 'enabled' ? '2026-10-24T01:05:00.000Z' : null,
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
async function start(status) {
  const h = monitorHarness(fixtures(status));
  h.render();
  await h.flush();
  return h;
}
test('an enabled watch refreshes passive workspace and MCP state every10s; no inventory rerun', async () => {
  const h = await start('enabled');
  assert.equal(h.calls.length, 21);
  assert.equal(h.calls.filter((call) => call.path === '/api/mcp-call-controls').length, 1);
  assert.equal(h.output.workspaceMonitor.status, 'enabled');
  const refreshedAt = h.output.refreshedAt;
  await h.advance(10000);
  assert.deepEqual(
    h.calls
      .slice(21)
      .map((call) => call.path)
      .sort(),
    ['/api/mcp-governance', '/api/workspace-monitor', '/api/workspace-review'],
  );
  assert.equal(h.output.refreshedAt, refreshedAt);
  assert.ok(h.calls.every((call) => call.body === undefined));
  h.unmount();
});
test('disabled and needs-review watches perform no automatic reads after initial projection', async () => {
  for (const status of ['disabled', 'needs-review']) {
    const h = await start(status);
    const count = h.calls.length;
    await h.advance(600000);
    assert.equal(h.calls.length, count);
    h.unmount();
  }
});
test('invalid monitor polling is bounded, retains historical evidence and never invents disabled success', async () => {
  const h = await start('enabled');
  const initial = h.output.workspaceMonitor;
  h.control.bad = '/api/workspace-monitor';
  await h.advance(60000);
  assert.equal(h.calls.length, 30);
  assert.equal(h.output.workspaceMonitor, initial);
  assert.match(h.output.error, /Automatic updates paused/);
  const count = h.calls.length;
  await h.advance(60000);
  assert.equal(h.calls.length, count);
  h.control.bad = '';
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.workspaceMonitor.status, 'enabled');
  h.unmount();
});
test('foreign monitor reply is a visible evidence gap and does not enable polling', async () => {
  const h = monitorHarness(fixtures('enabled'));
  h.control.state['/api/workspace-monitor'].workspaceId = foreignWorkspace;
  h.render();
  await h.flush();
  assert.equal(h.output.workspaceMonitor, null);
  assert.match(h.output.error, /Change watch state/);
  const count = h.calls.length;
  await h.advance(60000);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('synchronous context and transport replacement fence ignored-abort queue reads across A→B→A', async () => {
  for (const change of ['workspace', 'context', 'connection']) {
    const h = monitorHarness(fixtures('enabled'));
    h.control.hold = 'load';
    h.render();
    await h.flush();
    const before = h.platform.localContext,
      transport = h.platform.requestLocal;
    if (change === 'connection') h.platform.requestLocal = (...args) => transport(...args);
    else
      h.platform.localContext = {
        workspace: { id: change === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    h.platform.localContext = before;
    h.platform.requestLocal = transport;
    h.render(false);
    h.control.hold = '';
    h.release();
    await Promise.resolve();
    await Promise.resolve();
    h.render(false);
    assert.equal(h.output.workspaceMonitor, null);
    await h.flush();
    h.unmount();
  }
});
test('unmounted retained refresh cannot send, StrictMode re-entry performs read-only refresh', async () => {
  const h = await start('enabled'),
    before = h.output;
  h.unmount();
  const count = h.calls.length;
  await before.refresh();
  assert.equal(h.calls.length, count);
  h.reenterEffects();
  await h.flush();
  assert.equal(h.calls.length, count + 21);
  assert.ok(h.calls.every((call) => call.body === undefined));
  h.unmount();
});
test('ignored read aborts end visible busy at deadline and late replies do not restore evidence', async () => {
  const h = monitorHarness(fixtures('enabled'));
  h.control.hold = 'load';
  h.render();
  await h.flush();
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  assert.match(h.output.error, /deadline|refreshed/);
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.workspaceMonitor, null);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.workspaceMonitor.status, 'enabled');
  h.unmount();
});
