import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
} from './workspace-monitor-client-harness.mjs';
const fixtures = await tsImport('../lib/mcp-governance-fixtures.ts', {
  parentURL: import.meta.url,
});
const state = (records = []) => ({
  ...fixtures.governanceState(records),
  workspaceId: workspace,
  history: 'ready',
  records: records.map((r) => ({ ...r, binding: { ...r.binding, workspaceId: workspace } })),
});
async function start(records = []) {
  const h = monitorHarness({
    queue: true,
    state: () => ({ '/api/mcp-governance': state(records) }),
  });
  h.render();
  await h.flush();
  return h;
}
test('Protection reads governance passively once and never starts capture/check or polls unknown changes', async () => {
  const h = await start([fixtures.governanceRecord({ status: 'unknown' })]);
  assert.equal(h.output.mcpGovernance.contextId, fixtures.governanceContext);
  assert.equal(h.output.mcpGovernanceUnresolved.records.length, 1);
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  assert.ok(h.calls.every((c) => c.body === undefined));
  assert.equal(h.calls.filter((c) => c.path === '/api/mcp-governance').length, 1);
  h.unmount();
});
test('failed malformed foreign reads hide current authority but retain exact previously observed unknown', async () => {
  for (const kind of ['fail', 'bad', 'foreign', 'absent']) {
    const h = await start([fixtures.governanceRecord({ status: 'unknown' })]);
    if (kind === 'foreign') h.control.state['/api/mcp-governance'].workspaceId = foreignWorkspace;
    else if (kind === 'absent') h.control.state['/api/mcp-governance'] = state();
    else h.control[kind] = '/api/mcp-governance';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.mcpGovernanceUnresolved.records.length, 1);
    if (kind !== 'absent') {
      assert.equal(h.output.mcpGovernance, null);
      assert.match(h.output.error, /MCP governance/);
    }
    h.unmount();
  }
});
test('browser pending subscription is passive and survives empty/foreign current context without reconciliation', async () => {
  const h = await start(),
    preview = fixtures.governancePreview();
  preview.binding.workspaceId = workspace;
  h.governanceWrites.set('owned', { preview, startedAt: preview.createdAt });
  const count = h.calls.length;
  h.notifyGovernanceWrites();
  await h.flush();
  assert.equal(h.output.unconfirmedMcpGovernance.length, 1);
  assert.equal(h.calls.length, count);
  h.control.state['/api/mcp-governance'].contextId = 'governance-context-' + '2'.repeat(64);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.unconfirmedMcpGovernance.length, 1);
  assert.equal(h.governanceWrites.size, 1);
  h.unmount();
});
test('workspace/context/transport replacement synchronously hides previous governance authority and retained ledger', async () => {
  for (const kind of ['workspace', 'context', 'transport']) {
    const h = await start([fixtures.governanceRecord({ status: 'unknown' })]);
    if (kind === 'transport') {
      const request = h.platform.requestLocal;
      h.platform.requestLocal = (...args) => request(...args);
    } else
      h.platform.localContext = {
        workspace: { id: kind === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    assert.equal(h.output.mcpGovernance, null);
    assert.equal(h.output.mcpGovernanceUnresolved.records.length, 0);
    h.unmount();
  }
});
