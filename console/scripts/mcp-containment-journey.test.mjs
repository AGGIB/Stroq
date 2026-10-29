import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';
async function fixture(t, projectIsHome = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-mcp-http-')));
  const userHome = join(dir, 'user'),
    project = projectIsHome ? userHome : join(dir, 'workspace'),
    root = join(dir, 'out');
  await Promise.all([...new Set([project, userHome, root])].map((path) => mkdir(path)));
  const config = join(project, '.mcp.json');
  const doc = JSON.parse(
    '{"mcpServers":{"notes":{"command":"never-executed","args":["PRIVATE_CONFIG_SENTINEL"],"future":{"opaque":[1,true]}},"constructor":{"url":"https://provider.invalid/mcp"}},"preferences":{"zoom":1.25}}',
  );
  const bytes = Buffer.from(
    '\uFEFF' + JSON.stringify(doc, null, '\t').replaceAll('\n', '\r\n') + '\r\n',
  );
  await writeFile(config, bytes, { mode: 0o640 });
  await writeFile(join(root, 'index.html'), 'fixture');
  const app = await startServer({
    root,
    project,
    userHome,
    home: join(userHome, '.stroq'),
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  async function request(path, body, extra = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function item() {
    const result = await request('/api/inventory');
    assert.equal(result.status, 200);
    const target = result.body.items.find((row) => row.name === 'notes');
    assert.ok(target?.sha256);
    return target;
  }
  const preview = async () => {
    const target = await item();
    return await request('/api/mcp-containment/preview', {
      action: 'remove-registration',
      id: target.id,
      expectedSha256: target.sha256,
    });
  };
  const apply = (body) =>
    request('/api/mcp-containment/apply', {
      previewId: body.id,
      confirm: true,
      acknowledgeSessionLimits: true,
      acknowledgePrivateRetention: true,
    });
  const schema = await import('../.local-engine/local-api-schema.js');
  return { dir, root, project, userHome, config, bytes, doc, request, preview, apply, schema };
}
test('actual MCP HTTP journey preserves raw recovery, removes one registration and restores exact BOM bytes', async (t) => {
  const f = await fixture(t);
  const before = await f.request('/api/mcp-containment');
  assert.equal(before.status, 200);
  assert.equal(f.schema.validateMcpContainment(before.body), true);
  assert.equal(before.body.records.length, 0);
  await assert.rejects(access(join(f.userHome, '.stroq')));
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(f.schema.validateMcpContainmentPreview(preview.body), true);
  await assert.rejects(access(join(f.userHome, '.stroq')));
  assert.deepEqual(await readFile(f.config), f.bytes);
  const receipt = await f.apply(preview.body);
  assert.equal(receipt.status, 200);
  assert.equal(f.schema.validateMcpContainmentReceipt(receipt.body), true);
  assert.equal(receipt.body.hostEnforcement, false);
  assert.equal(receipt.body.reviewBaselineChanged, false);
  const removed = JSON.parse((await readFile(f.config, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(Object.hasOwn(removed.mcpServers, 'notes'), false);
  assert.deepEqual(removed.mcpServers.constructor, f.doc.mcpServers.constructor);
  assert.deepEqual(removed.preferences, f.doc.preferences);
  assert.equal((await f.apply(preview.body)).status, 409);
  const state = await f.request('/api/mcp-containment');
  assert.equal(f.schema.validateMcpContainment(state.body), true);
  assert.equal(state.body.records[0].status, 'removed');
  for (const body of [preview.body, receipt.body, state.body]) {
    const json = JSON.stringify(body);
    assert.ok(!json.includes(f.dir));
    assert.ok(!json.includes('PRIVATE_CONFIG_SENTINEL'));
    assert.ok(!json.includes('never-executed'));
  }
  const restore = await f.request('/api/mcp-containment/preview', {
    action: 'restore-registration',
    recordId: receipt.body.recordId,
  });
  assert.equal(restore.status, 200);
  assert.equal((await f.apply(restore.body)).status, 200);
  assert.deepEqual(await readFile(f.config), f.bytes);
  assert.equal((await f.request('/api/mcp-containment')).body.records[0].status, 'restored');
});
test('MCP HTTP restore keeps new siblings and refuses occupied keys or changes after preview', async (t) => {
  const f = await fixture(t);
  const receipt = await f.apply((await f.preview()).body);
  assert.equal(receipt.status, 200);
  const doc = JSON.parse((await readFile(f.config, 'utf8')).replace(/^\uFEFF/, ''));
  doc.mcpServers.notes = null;
  await writeFile(f.config, JSON.stringify(doc));
  const input = { action: 'restore-registration', recordId: receipt.body.recordId };
  assert.equal((await f.request('/api/mcp-containment/preview', input)).status, 409);
  delete doc.mcpServers.notes;
  doc.mcpServers.newer = { url: 'https://newer.invalid/mcp', future: { preserve: true } };
  doc.preferences.zoom = 2;
  await writeFile(f.config, JSON.stringify(doc));
  const stale = await f.request('/api/mcp-containment/preview', input);
  assert.equal(stale.status, 200);
  doc.preferences.zoom = 3;
  await writeFile(f.config, JSON.stringify(doc));
  assert.equal((await f.apply(stale.body)).status, 409);
  const fresh = await f.request('/api/mcp-containment/preview', input);
  assert.equal(fresh.status, 200);
  assert.equal((await f.apply(fresh.body)).status, 200);
  const after = JSON.parse(await readFile(f.config, 'utf8'));
  assert.deepEqual(after.mcpServers.notes, f.doc.mcpServers.notes);
  assert.deepEqual(after.mcpServers.newer, doc.mcpServers.newer);
  assert.equal(after.preferences.zoom, 3);
});
test('actual MCP routes enforce authentication, exact Origin and duplicate-key refusal', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/mcp-containment',
    '/api/mcp-containment/preview',
    '/api/mcp-containment/apply',
  ]) {
    const body = path.endsWith('containment') ? undefined : {};
    assert.equal((await f.request(path, body, { Authorization: '' })).status, 401);
    assert.equal((await f.request(path, body, { Origin: 'https://foreign.invalid' })).status, 403);
  }
  for (const path of ['/api/mcp-containment/preview', '/api/mcp-containment/apply']) {
    assert.equal(
      (await f.request(path, Buffer.from('{"confirm":true,"confirm":false}'))).status,
      400,
    );
    assert.equal((await f.request(path, Buffer.from([0xff]))).status, 400);
    assert.equal((await f.request(path, Buffer.alloc(4097, 'x'))).status, 413);
    assert.equal((await f.request(path, { path: '/outside', command: 'never-run' })).status, 400);
  }
  assert.deepEqual(await readFile(f.config), f.bytes);
});

test('home-as-workspace Cursor source is user-wide and restores through another workspace', async (t) => {
  const f = await fixture(t, true);
  const directory = join(f.userHome, '.cursor'),
    file = join(directory, 'mcp.json');
  await mkdir(directory);
  const original = JSON.stringify({
    mcpServers: { 'shared-cursor': { command: 'never-executed' } },
  });
  await writeFile(file, original);
  const inventory = await f.request('/api/inventory');
  assert.equal(inventory.status, 200);
  const entries = inventory.body.items.filter((item) => item.name === 'shared-cursor');
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].scope,
    'user',
    'A shared user configuration must not be labelled project-only',
  );
  const preview = await f.request('/api/mcp-containment/preview', {
    action: 'remove-registration',
    id: entries[0].id,
    expectedSha256: entries[0].sha256,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.artifact.scope, 'user');
  assert.equal(preview.body.artifact.configSource, 'cursor-user');
  const removed = await f.apply(preview.body);
  assert.equal(removed.status, 200);
  const project = join(f.dir, 'another-workspace');
  await mkdir(project);
  const other = await startServer({
    root: f.root,
    userHome: f.userHome,
    project,
    home: join(f.userHome, '.stroq'),
    port: 0,
  });
  try {
    const origin = new URL(other.url).origin;
    const action = async (path, body) => {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${other.token}`,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    const restore = await action('/api/mcp-containment/preview', {
      action: 'restore-registration',
      recordId: removed.body.recordId,
    });
    await action('/api/mcp-containment/apply', {
      previewId: restore.id,
      confirm: true,
      acknowledgeSessionLimits: true,
      acknowledgePrivateRetention: true,
    });
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await other.close();
  }
});
