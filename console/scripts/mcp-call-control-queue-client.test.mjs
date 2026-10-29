import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monitorHarness,
  workspace,
  foreignWorkspace,
} from './workspace-monitor-client-harness.mjs';
const contextId = 'context-' + 'a'.repeat(64),
  state = (context = contextId) => ({
    schema: 'stroq-mcp-call-controls/1',
    workspaceId: workspace,
    contextId: context,
    checkedAt: '2026-10-24T01:00:00.000Z',
    authority: 'missing',
    revision: null,
    gaps: [],
    controls: [],
    hostEnforcement: false,
  });
async function start() {
  const h = monitorHarness({ queue: true, state: () => ({ '/api/mcp-call-controls': state() }) });
  h.render();
  await h.flush();
  return h;
}
test('Protection captures one bounded passive call-control overview without preview/apply or automatic polling', async () => {
  const h = await start();
  assert.equal(h.output.mcpCallControls?.contextId, contextId);
  assert.equal(h.calls.filter((c) => c.path === '/api/mcp-call-controls').length, 1);
  assert.ok(h.calls.every((c) => c.body === undefined));
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  h.unmount();
});
test('failed malformed and foreign call-control overview become an explicit current gap', async () => {
  for (const kind of ['fail', 'bad', 'foreign']) {
    const h = await start();
    if (kind === 'foreign')
      h.control.state['/api/mcp-call-controls'].workspaceId = foreignWorkspace;
    else h.control[kind] = '/api/mcp-call-controls';
    await h.output.refresh();
    await h.flush();
    assert.equal(h.output.mcpCallControls, null);
    assert.match(h.output.error, /MCP call-control authority could not be refreshed/);
    h.unmount();
  }
});
test('refresh clears earlier desired authority; ignored timeout responses cannot restore it', async () => {
  const h = await start();
  h.control.hold = '/api/mcp-call-controls';
  const pending = h.output.refresh();
  await h.flush();
  assert.equal(h.output.mcpCallControls, null);
  await h.advance(45000);
  assert.equal(h.output.loading, false);
  h.control.hold = '';
  h.release();
  await pending;
  await h.flush();
  assert.equal(h.output.mcpCallControls, null);
  h.control.state['/api/mcp-call-controls'] = state('context-' + 'b'.repeat(64));
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.mcpCallControls.contextId, 'context-' + 'b'.repeat(64));
  h.unmount();
});
test('workspace context and transport replacement synchronously hide former profile authority', async () => {
  for (const kind of ['workspace', 'context', 'transport']) {
    const h = await start();
    if (kind === 'transport') {
      const transport = h.platform.requestLocal;
      h.platform.requestLocal = (...args) => transport(...args);
    } else
      h.platform.localContext = {
        workspace: { id: kind === 'workspace' ? foreignWorkspace : workspace },
      };
    h.render(false);
    assert.equal(h.output.mcpCallControls, null);
    h.unmount();
  }
});

function unknownWrite(context = contextId) {
  const control = '00000000-0000-4000-8000-000000000001',
    operation = '00000000-0000-4000-8000-000000000003';
  return {
    preview: {
      schema: 'stroq-mcp-call-control-preview/1',
      id: '00000000-0000-4000-8000-000000000002',
      operationId: operation,
      createdAt: '2026-10-24T01:00:00.000Z',
      expiresAt: '2026-10-24T01:02:00.000Z',
      workspaceId: workspace,
      contextId: context,
      proxyWorkspaceId: workspace,
      action: 'pause',
      artifact: {
        id: 'item-' + 'c'.repeat(24),
        kind: 'mcp',
        name: 'Notes',
        agent: 'cursor',
        scope: 'project',
        sha256: 'd'.repeat(64),
        digestFormat: 'mcp-entry-canonical-json/1',
        configSource: 'cursor-project',
      },
      controlId: control,
      invocationSha256: 'e'.repeat(64),
      expectedRevision: 'f'.repeat(64),
      expectedEventId: '00000000-0000-4000-8000-000000000004',
      changesConfiguration: false,
      requiresReconnect: false,
      sharedUserScope: false,
      retention: {
        maxControls: 64,
        maxEvents: 512,
        maxBytes: 1048576,
        setupMaxRecords: 32,
        setupMaxBytes: 17825792,
      },
      hostEnforcement: false,
    },
    startedAt: '2026-10-24T01:00:00.000Z',
  };
}
test('explicit passive refresh retains unknown writes independently of empty native history and later profile selection', async () => {
  const h = await start(),
    write = unknownWrite();
  h.callControlWrites.set(write.preview.operationId, write);
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.mcpCallControls.controls.length, 0);
  assert.equal(h.output.unconfirmedMcpCallControls.length, 1);
  assert.equal(h.callControlWrites.has(write.preview.operationId), true);
  const count = h.calls.length;
  await h.advance(600000);
  assert.equal(h.calls.length, count);
  assert.equal(h.output.unconfirmedMcpCallControls.length, 1);
  h.control.state['/api/mcp-call-controls'] = state('context-' + 'b'.repeat(64));
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.mcpCallControls.contextId, 'context-' + 'b'.repeat(64));
  assert.equal(h.output.unconfirmedMcpCallControls[0].preview.contextId, contextId);
  assert.equal(h.callControlWrites.has(write.preview.operationId), true);
  assert.ok(h.calls.every((c) => c.body === undefined));
  h.unmount();
});
test('pending writes remain visible through overview failure and disappear only after the shared explicit-recheck owner removes them', async () => {
  const h = await start(),
    write = unknownWrite();
  h.callControlWrites.set(write.preview.operationId, write);
  h.control.fail = '/api/mcp-call-controls';
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.mcpCallControls, null);
  assert.equal(h.output.unconfirmedMcpCallControls.length, 1);
  assert.equal(h.callControlWrites.size, 1);
  h.callControlWrites.delete(write.preview.operationId);
  h.control.fail = '';
  await h.output.refresh();
  await h.flush();
  assert.equal(h.output.unconfirmedMcpCallControls.length, 0);
  h.unmount();
});
