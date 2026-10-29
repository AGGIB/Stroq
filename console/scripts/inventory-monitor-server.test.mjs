import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startServer as createConsoleServer } from './serve.mjs';

test('production Skills and MCP watch calls only the baseline-independent observation reader', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-monitor-server-')));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  let server,
    observe = 0,
    read = 0;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspaceId =
    'workspace-' + createHash('sha256').update(project).digest('hex').slice(0, 24);
  server = await createConsoleServer({
    project,
    userHome,
    home,
    port: 0,
    inventory: {
      async read() {
        read++;
        throw new Error('baseline-decorated-reader-must-not-run');
      },
      async observe() {
        observe++;
        return {
          status: 200,
          body: {
            schema: 'stroq-inventory/1',
            source: 'local',
            generatedAt: new Date().toISOString(),
            workspace: { id: workspaceId, label: 'project' },
            baseline: { status: 'missing', reviewedAt: null },
            items: [],
            gaps: [],
            limitations: [],
          },
        };
      },
      async close() {},
    },
  });
  const origin = new URL(server.url).origin,
    headers = {
      authorization: `Bearer ${server.token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    };
  async function request(path, body) {
    const response = await fetch(origin + path, {
      headers,
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const state = await request('/api/inventory-monitor');
  assert.equal(state.status, 'disabled');
  assert.equal(observe, 0);
  assert.equal(read, 0);
  const preview = await request('/api/inventory-monitor/preview', {
    action: 'enable',
    expectedRevision: state.revision,
  });
  await request('/api/inventory-monitor/apply', {
    previewId: preview.id,
    confirm: true,
    acknowledgeLocalChecks: true,
    acknowledgeUserSources: true,
    acknowledgeRetention: true,
  });
  const deadline = Date.now() + 15000;
  let observed;
  while (Date.now() < deadline) {
    observed = await request('/api/inventory-monitor');
    if (observed.latestCheckId) break;
    await delay(100);
  }
  assert.equal(observe, 1);
  assert.equal(read, 0);
  assert(observed.latestCheckId);
  assert.equal(observed.history.status, 'ready');
  const pause = await request('/api/inventory-monitor/preview', {
    action: 'pause',
    expectedRevision: observed.revision,
  });
  await request('/api/inventory-monitor/apply', {
    previewId: pause.id,
    confirm: true,
    acknowledgeLocalChecks: false,
    acknowledgeUserSources: false,
    acknowledgeRetention: false,
  });
  assert.equal((await request('/api/inventory-monitor')).status, 'disabled');
});
