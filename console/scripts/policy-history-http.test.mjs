import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '../../packages/core/dist/index.js';
import { startServer } from './serve.mjs';
import { exercisePolicyHistory } from './policy-history-journey-helpers.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-http-')));
  const userHome = join(dir, 'profile'),
    project = join(dir, 'workspace'),
    root = join(dir, 'out');
  const home = join(userHome, '.stroq');
  await Promise.all([userHome, project, root].map((path) => mkdir(path)));
  await writeFile(join(root, 'index.html'), 'policy history fixture');
  const app = await startServer({ root, home, userHome, project, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  const headers = { authorization: `Bearer ${app.token}` };
  const inspectHeaders = { ...headers, Origin: origin, 'Content-Type': 'application/json' };
  return { dir, userHome, project, root, home, app, origin, headers, inspectHeaders };
}

test('authenticated policy history restores exact prior bytes, explicitly returns to current default and recovers again', async (t) => {
  const f = await fixture(t);
  const schema = await import('../.local-engine/local-api-schema.js');
  const before = await fetch(f.origin + '/api/policy/history', { headers: f.headers });
  assert.equal(before.status, 200);
  const initial = await before.json();
  assert(schema.validatePolicyHistoryState(initial), JSON.stringify(initial));
  assert.equal(initial.history.status, 'ready');
  assert.equal(initial.entries.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  await mkdir(f.home, { mode: 0o700 });
  await exercisePolicyHistory({ ...f, schema, defaultPolicy: DEFAULT_POLICY });
});

test('history and both restore routes enforce authentication, Origin, methods and bounded closed inputs', async (t) => {
  const f = await fixture(t);
  const routes = [
    '/api/policy/history',
    '/api/policy/restore/preview',
    '/api/policy/restore/apply',
  ];
  for (const route of routes) {
    assert.equal((await fetch(f.origin + route)).status, 401);
    assert.equal(
      (
        await fetch(f.origin + route, {
          headers: { ...f.headers, Origin: 'https://foreign.invalid' },
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await fetch(f.origin + routes[0], { method: 'POST', headers: f.inspectHeaders, body: '{}' }))
      .status,
    405,
  );
  for (const route of routes.slice(1)) {
    assert.equal((await fetch(f.origin + route, { headers: f.headers })).status, 405);
    assert.equal(
      (await fetch(f.origin + route, { method: 'POST', headers: f.headers, body: '{}' })).status,
      403,
    );
    for (const body of [
      '{',
      JSON.stringify({ path: f.project }),
      JSON.stringify({ command: 'never-run' }),
      JSON.stringify({ entryId: '../outside' }),
    ])
      assert.equal(
        (await fetch(f.origin + route, { method: 'POST', headers: f.inspectHeaders, body })).status,
        400,
      );
    assert.equal(
      (
        await fetch(f.origin + route, {
          method: 'POST',
          headers: f.inspectHeaders,
          body: JSON.stringify({ padding: 'x'.repeat(5000) }),
        })
      ).status,
      413,
    );
  }
  assert.equal(
    (
      await fetch(f.origin + '/api/policy/restore/run', {
        method: 'POST',
        headers: f.inspectHeaders,
        body: '{}',
      })
    ).status,
    404,
  );
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});
