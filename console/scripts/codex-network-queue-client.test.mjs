import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
} from './workspace-monitor-client-harness.mjs';
import * as f from './codex-network-client-fixtures.mjs';
const context = f.context;
const fixtures = () => ({
  queue: true,
  state: () => ({
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
    '/api/inventory/codex-controls': {
      schema: 'stroq-codex-skill-controls/1',
      controlContextId: context,
      generatedAt: '2026-10-26T01:00:00.000Z',
      available: true,
      history: 'missing',
      records: [],
      error: null,
    },
    '/api/codex-network-guard': f.state(),
    '/api/codex-network-checks': { ...f.checkState(), workspaceId: workspace },
  }),
});
async function setup() {
  const h = monitorHarness(fixtures());
  h.render();
  await h.flush();
  return h;
}
test('home serializes inventory, skill, guard and copied-check GETs without capture or native/config actions', async () => {
  const h = monitorHarness(fixtures());
  h.control.hold = '/api/inventory';
  h.render();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.startsWith('/api/codex-network')).length, 0);
  h.control.hold = '/api/inventory/codex-controls';
  h.release();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path.startsWith('/api/codex-network')).length, 0);
  h.control.hold = '/api/codex-network-guard';
  h.release();
  await h.flush();
  assert.equal(h.calls.filter((c) => c.path === '/api/codex-network-checks').length, 0);
  h.control.hold = '';
  h.release();
  await h.flush();
  assert.equal(h.output.codexNetworkGuard.controlContextId, context);
  assert.equal(h.output.codexNetworkChecks.workspaceId, workspace);
  assert.deepEqual(
    h.calls.slice(-4).map((c) => c.path),
    [
      '/api/inventory/codex-controls',
      '/api/codex-network-guard',
      '/api/codex-network-checks',
      '/api/codex-path-guard',
    ],
  );
  assert(h.calls.every((c) => c.body === undefined));
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('pending subscriptions reproject independently without GET or clearing absent history', async () => {
  const h = await setup(),
    preview = f.preview();
  h.networkGuardWrites.set('fixture', { preview, startedAt: preview.createdAt });
  const cp = f.checkPreview();
  h.networkCheckWrites.set('fixture', {
    action: 'start',
    id: cp.jobId,
    operationId: cp.operationId,
    binding: { ...cp.binding, workspaceId: workspace },
    startedAt: cp.createdAt,
  });
  const count = h.calls.length;
  h.notifyNetworkWrites();
  await h.flush();
  assert.equal(h.output.unconfirmedNetworkGuard.length, 1);
  assert.equal(h.output.unconfirmedNetworkChecks.length, 1);
  assert.equal(h.calls.length, count);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.codexNetworkGuard.records.length, 0);
  assert.equal(h.output.codexNetworkChecks.jobs.length, 0);
  assert.equal(h.output.unconfirmedNetworkGuard.length, 1);
  assert.equal(h.output.unconfirmedNetworkChecks.length, 1);
  assert.equal(h.networkGuardWrites.size, 1);
  assert.equal(h.networkCheckWrites.size, 1);
  h.unmount();
});
test('malformed, failed and foreign history become gaps while exact requests remain independent', async () => {
  for (const kind of ['failed', 'malformed', 'foreign-workspace', 'foreign-context']) {
    const h = await setup(),
      p = f.preview();
    h.networkGuardWrites.set('fixture', { preview: p, startedAt: p.createdAt });
    if (kind === 'failed') h.control.fail = '/api/codex-network-guard';
    else if (kind === 'malformed') h.control.bad = '/api/codex-network-guard';
    else if (kind === 'foreign-workspace')
      h.control.state['/api/codex-network-checks'].workspaceId = foreignWorkspace;
    else
      h.control.state['/api/codex-network-checks'].controlContextId =
        'codex-context-' + '9'.repeat(64);
    await h.output.refresh();
    await h.flush();
    if (kind === 'failed' || kind === 'malformed') assert.equal(h.output.codexNetworkGuard, null);
    else assert.equal(h.output.codexNetworkChecks, null);
    assert.equal(h.output.unconfirmedNetworkGuard.length, 1);
    assert.doesNotMatch(h.output.error, /PRIVATE/);
    h.unmount();
  }
});
test('deadline and late ignored-abort responses cannot restore current network history', async () => {
  const h = await setup();
  h.control.hold = '/api/codex-network-guard';
  const pending = h.output.refresh();
  await h.flush();
  assert.equal(h.output.codexNetworkGuard, null);
  assert.equal(h.output.codexNetworkChecks, null);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  h.control.hold = '';
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.codexNetworkGuard, null);
  assert.equal(h.output.codexNetworkChecks, null);
  h.unmount();
});
test('workspace/context/transport changes synchronously hide current network snapshots', async () => {
  for (const kind of ['workspace', 'context', 'transport']) {
    const h = await setup();
    if (kind === 'transport') {
      const transport = h.platform.requestLocal;
      h.platform.requestLocal = (...a) => transport(...a);
    } else
      h.platform.localContext = {
        workspace: { id: kind === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    assert.equal(h.output.codexNetworkGuard, null);
    assert.equal(h.output.codexNetworkChecks, null);
    h.unmount();
  }
});
