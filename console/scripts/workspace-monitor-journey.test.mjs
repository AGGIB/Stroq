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
test('authenticated monitor performs inert static checks and retains explicit review after change and pause', async (t) => {
  const f = await fixture(t),
    sentinel = join(f.base, 'never-run');
  await writeFile(join(f.project, '.envrc'), `touch '${sentinel}'\n`);
  const initial = await f.request('/api/workspace-monitor');
  assert.equal(initial.body.status, 'disabled');
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  await f.action('enable');
  const a = await f.completion();
  assert.equal(a.result.baseline.status, 'missing');
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  const receipt = await f.request('/api/workspace-review/review', reviewInput(a));
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  await f.action('pause');
  const paused = (await f.request('/api/workspace-monitor')).body;
  assert.equal(paused.status, 'disabled');
  assert.equal(paused.nextCheckAt, null);
  await writeFile(join(f.project, '.envrc'), `touch '${sentinel}'\nexport CHANGED=1\n`);
  await f.action('enable');
  const b = await f.completion(a.id);
  assert.equal(b.result.comparison.status, 'comparable');
  assert.equal(b.result.comparison.sources.length, 1);
  assert.equal(b.result.baseline.revision, receipt.body.revision);
  assert.notEqual(b.result.capture.captureSha256, a.result.capture.captureSha256);
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  await f.action('pause');
  const end = (await f.request('/api/workspace-review')).body;
  assert.equal(end.baseline.revision, receipt.body.revision);
  assert.equal(end.runs.filter((r) => r.status === 'completed').length, 2);
});
test('HTTP monitor rejects unauthenticated, cross-origin, duplicate, path and oversized writes', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request('/api/workspace-monitor', undefined, { headers: { Authorization: '' } }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request(
        '/api/workspace-monitor/preview',
        { action: 'enable', expectedRevision: null },
        { headers: { Origin: 'http://foreign.invalid' } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/workspace-monitor/preview',
        {},
        { body: '{"action":"pause","action":"enable","expectedRevision":null}' },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/workspace-monitor/preview', {
        action: 'enable',
        expectedRevision: null,
        project: '/tmp',
      })
    ).status,
    400,
  );
  assert.equal((await f.request('/api/workspace-monitor?start=true')).status, 400);
  assert.equal(
    (await f.request('/api/workspace-monitor/preview', {}, { body: 'x'.repeat(4097) })).status,
    413,
  );
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
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
