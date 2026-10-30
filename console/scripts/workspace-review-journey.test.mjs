import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startServer } from './serve.mjs';
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
  await writeFile(join(root, 'index.html'), '<main>fixture</main>');
  const server = await startServer({
    root,
    project: f.project,
    userHome: f.userHome,
    home: f.home,
    port: 0,
    workspaceReview: f.service,
  });
  t.after(() => server.close());
  const origin = server.url.split('/#')[0];
  async function request(path, body, extra = {}) {
    const headers = {
      Authorization: `Bearer ${server.token}`,
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...extra.headers,
    };
    const result = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...extra,
    });
    const raw = await result.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: result.status, body: parsed };
  }
  async function check() {
    const reply = await request('/api/workspace-review/check', {});
    assert.equal(reply.status, 202, JSON.stringify(reply));
    for (let i = 0; i < 100; i++) {
      const state = await request('/api/workspace-review');
      const run = state.body.runs.find((r) => r.id === reply.body.id);
      if (run?.status !== 'running') return run;
      await setTimeout(20);
    }
    throw new Error('fixture-deadline');
  }
  return { ...f, server, origin, request, check };
}

test('actual authenticated HTTP check/review/change loop is read-only until explicit review acknowledgement', async (t) => {
  const f = await fixture(t),
    path = join(f.project, '.envrc'),
    sentinel = join(f.base, 'never-run');
  await writeFile(path, `touch '${sentinel}'\n# private-http-command\n`);
  const state = await f.request('/api/workspace-review');
  assert.equal(state.status, 200);
  assert(built.schema.validateWorkspaceReviewState(state.body));
  assert.equal(state.body.runs.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const run = await f.check();
  assert.equal(run.status, 'completed');
  assert(built.schema.validateWorkspaceReviewRun(run));
  assert.equal(run.result.comparison.status, 'missing');
  const input = reviewInput(run);
  assert.equal(
    (await f.request('/api/workspace-review/review', { ...input, acknowledgeReviewOnly: false }))
      .status,
    400,
  );
  assert.equal((await f.request('/api/workspace-review')).body.baseline.status, 'missing');
  const receipt = await f.request('/api/workspace-review/review', input);
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  assert(built.schema.validateWorkspaceReviewReceipt(receipt.body));
  await writeFile(path, `touch '${sentinel}'\n# changed-only-comment\n`);
  const next = await f.check();
  assert.equal(next.result.comparison.sources.length, 1);
  assert.equal(next.result.comparison.entries.added.length, 0);
  await f.request('/api/workspace-review');
  assert.equal(
    (await f.request('/api/workspace-review')).body.baseline.revision,
    receipt.body.revision,
  );
  await writeFile(path, `touch '${sentinel}'\nexport ADDITION=1\n`);
  assert.equal(
    (await f.request('/api/workspace-review/review', reviewInput(next))).body.error,
    'stale-capture',
  );
  assert.equal(
    (await f.request('/api/workspace-review')).body.baseline.revision,
    receipt.body.revision,
  );
  const serialized = JSON.stringify({ run, next, receipt });
  for (const secret of [sentinel, f.project, f.userHome, 'private-http-command'])
    assert(!serialized.includes(secret));
  await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
  assert.equal(await readFile(path, 'utf8'), `touch '${sentinel}'\nexport ADDITION=1\n`);
});

test('HTTP authentication, Origin, method, closed payload and body bounds guard every workspace action', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/api/workspace-review')).status, 401);
  assert.equal(
    (
      await f.request(
        '/api/workspace-review/check',
        {},
        {
          headers: {
            Authorization: `Bearer ${f.server.token}`,
            Origin: 'https://foreign.invalid',
            'Content-Type': 'application/json',
          },
        },
      )
    ).status,
    403,
  );
  for (const [route, input] of [
    ['check', { path: f.project }],
    ['check', { command: 'touch bad' }],
    ['check', { base: 'HEAD' }],
    ['review', { runId: '../outside' }],
    ['cancel', { id: '../outside' }],
  ])
    assert.equal((await f.request('/api/workspace-review/' + route, input)).status, 400);
  assert.equal(
    (await f.request('/api/workspace-review/check', { padding: 'x'.repeat(5000) })).status,
    413,
  );
  assert.equal((await f.request('/api/workspace-review/check')).status, 405);
  assert.equal((await f.request('/api/workspace-review', {})).status, 405);
  assert.equal((await f.request('/api/workspace-review/unknown', {})).status, 404);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
