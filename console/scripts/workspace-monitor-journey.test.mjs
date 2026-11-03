import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startServer } from './serve.mjs';
import { createWorkspaceMonitorControl } from './workspace-monitor-control.mjs';
import { parseWorkspaceMonitorJson } from './workspace-monitor-http.mjs';
import {
  buildWorkspaceFixture,
  workspaceFixture,
  reviewInput,
} from './workspace-review-test-helpers.mjs';
const built = await buildWorkspaceFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));
async function fixture(t) {
  const f = await workspaceFixture(t, built),
    root = join(f.base, 'static');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<main>test</main>');
  const monitor = await createWorkspaceMonitorControl({ ...f.options, workspaceReview: f.service });
  const server = await startServer({
    root,
    home: f.home,
    project: f.project,
    userHome: f.userHome,
    workspaceReview: f.service,
    workspaceMonitor: monitor,
    port: 0,
  });
  t.after(() => server.close());
  const origin = server.url.split('/#')[0];
  async function request(path, body, overrides = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        ...overrides.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'headers')),
    });
    let value;
    try {
      value = await response.json();
    } catch {}
    return { status: response.status, body: value };
  }
  async function action(action) {
    const state = await request('/api/workspace-monitor');
    assert(built.schema.validateWorkspaceMonitorState(state.body), JSON.stringify(state));
    const p = await request('/api/workspace-monitor/preview', {
      action,
      expectedRevision: state.body.revision,
    });
    assert.equal(p.status, 200, JSON.stringify(p));
    assert(built.schema.validateWorkspaceMonitorPreview(p.body));
    const r = await request('/api/workspace-monitor/apply', {
      previewId: p.body.id,
      confirm: true,
      acknowledgeLocalChecks: action === 'enable',
      acknowledgeRetention: action === 'enable',
    });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert(built.schema.validateWorkspaceMonitorReceipt(r.body));
    return r.body;
  }
  async function completion(previousId = null) {
    for (let i = 0; i < 150; i++) {
      const state = (await request('/api/workspace-review')).body;
      const run = state.runs.find((r) => r.id !== previousId && r.status === 'completed');
      if (run) return run;
      await setTimeout(20);
    }
    throw Error('check-deadline');
  }
  return { ...f, monitor, server, request, action, completion };
}
test('scalar parser refuses decoded duplicates, nested values and invalid Unicode', () => {
  assert.deepEqual(parseWorkspaceMonitorJson('{"action":"enable","expectedRevision":null}'), {
    action: 'enable',
    expectedRevision: null,
  });
  for (const value of [
    '{"action":"pause","\\u0061ction":"enable"}',
    '{"action":{}}',
    '{"action":"\\ud800"}',
  ])
    assert.throws(() => parseWorkspaceMonitorJson(value));
});
