import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  protectionFixture,
  proxyApply,
  exerciseFixtureProxy,
} from './mcp-protection-http-helpers.mjs';

test('actual HTTP protect, inert MCP allow/block and exact undo preserve unrelated configuration', async (t) => {
  const f = await protectionFixture(t);
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(f.schema.validateMcpContainmentPreview(preview.body), true);
  assert.equal(preview.body.proxy.mode, 'strict');
  assert.deepEqual(await readFile(f.config), f.original);
  await assert.rejects(access(f.environment));
  const missingAck = { ...proxyApply(preview.body) };
  delete missingAck.acknowledgeProxyEffects;
  assert.equal((await f.request('/api/mcp-containment/apply', missingAck)).status, 400);
  assert.deepEqual(await readFile(f.config), f.original);
  const applied = await f.request('/api/mcp-containment/apply', proxyApply(preview.body));
  assert.equal(applied.status, 200);
  assert.equal(f.schema.validateMcpContainmentReceipt(applied.body), true);
  assert.equal(applied.body.status, 'configured');
  assert.equal(applied.body.hostEnforcement, false);
  await assert.rejects(access(f.environment), 'Configuration apply must not launch the server');
  const config = JSON.parse((await readFile(f.config, 'utf8')).replace(/^\uFEFF/, ''));
  assert.deepEqual(config.mcpServers.sibling, f.document.mcpServers.sibling);
  assert.deepEqual(config.preferences, f.document.preferences);
  assert.deepEqual(config.mcpServers.notes.future, { preserve: true });
  const state = await f.request('/api/mcp-containment');
  assert.equal(f.schema.validateMcpContainment(state.body), true);
  assert.equal(state.body.records[0].status, 'configured');
  assert.equal(state.body.records[0].proxy.runtimeMatches, true);
  assert.notEqual(state.body.records[0].changedEntrySha256, state.body.records[0].artifact.sha256);
  for (const body of [preview.body, applied.body, state.body]) {
    assert.ok(!JSON.stringify(body).includes(f.dir));
    assert.ok(!JSON.stringify(body).includes('fixture-declared-value'));
    assert.ok(!JSON.stringify(body).includes('inert-server.mjs'));
  }
  await exerciseFixtureProxy(f);
  const restore = await f.request('/api/mcp-containment/preview', {
    action: 'restore-registration',
    recordId: applied.body.recordId,
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.proxy.mode, 'strict');
  const restored = await f.request('/api/mcp-containment/apply', proxyApply(restore.body));
  assert.equal(restored.status, 200);
  assert.deepEqual(await readFile(f.config), f.original);
  assert.equal((await f.request('/api/mcp-containment')).body.records[0].status, 'restored');
});

test('user proxy requires shared context consent; another workspace can only undo the exact installed entry', async (t) => {
  const f = await protectionFixture(t, 'user');
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifact.scope, 'user');
  assert.equal(
    (await f.request('/api/mcp-containment/apply', proxyApply(preview.body))).status,
    400,
  );
  assert.deepEqual(await readFile(f.config), f.original);
  const applied = await f.request('/api/mcp-containment/apply', proxyApply(preview.body, true));
  assert.equal(applied.status, 200);
  const configured = JSON.parse((await readFile(f.config, 'utf8')).replace(/^\uFEFF/, ''));
  const project = join(f.dir, 'another-workspace');
  await mkdir(project);
  const other = await f.connect(project);
  const retained = await other('/api/mcp-containment');
  assert.equal(f.schema.validateMcpContainment(retained.body), true);
  assert.equal(retained.body.records[0].proxy.policyWorkspaceId, preview.body.workspaceId);
  assert.notEqual(retained.body.workspaceId, preview.body.workspaceId);
  configured.mcpServers.notes.future.changedByUser = true;
  await writeFile(f.config, JSON.stringify(configured));
  const input = { action: 'restore-registration', recordId: applied.body.recordId };
  assert.equal((await other('/api/mcp-containment/preview', input)).status, 409);
  delete configured.mcpServers.notes.future.changedByUser;
  configured.mcpServers.newer = { url: 'https://newer.invalid/mcp' };
  configured.preferences.keep = 'newer';
  await writeFile(f.config, JSON.stringify(configured));
  const restore = await other('/api/mcp-containment/preview', input);
  assert.equal(restore.status, 200);
  assert.equal(restore.body.proxy.policyWorkspaceId, preview.body.workspaceId);
  assert.equal((await other('/api/mcp-containment/apply', proxyApply(restore.body))).status, 200);
  const restored = JSON.parse(await readFile(f.config, 'utf8'));
  assert.deepEqual(restored.mcpServers.notes, f.document.mcpServers.notes);
  assert.deepEqual(restored.mcpServers.newer, configured.mcpServers.newer);
  assert.equal(restored.preferences.keep, 'newer');
});
