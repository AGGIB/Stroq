import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readFile,
  access,
  realpath,
} from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';
import { createControl } from './control.mjs';

async function fixture(t, control) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-console-http-')));
  await mkdir(join(dir, 'out'));
  await mkdir(join(dir, 'home'));
  await writeFile(join(dir, 'out', 'index.html'), '<h1>Console fixture</h1>');
  const app = await startServer({
    root: join(dir, 'out'),
    home: join(dir, 'home'),
    userHome: join(dir, 'home'),
    project: dir,
    port: 0,
    control,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...app, dir };
}

function get(app, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: app.server.address().port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('snapshot requires bearer authentication and never accepts URL query tokens', async (t) => {
  const app = await fixture(t);
  assert.match(app.url, /#token=[A-Za-z0-9_-]{43}$/);
  assert.equal((await get(app, '/api/snapshot')).status, 401);
  assert.equal((await get(app, `/api/snapshot?token=${app.token}`)).status, 401);
  assert.equal((await get(app, '/api/snapshot', { Authorization: 'Bearer wrong' })).status, 401);
  const result = await get(app, '/api/snapshot', { Authorization: `Bearer ${app.token}` });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text).calls, []);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.ok(!result.text.includes(app.token));
});

test('control jobs require bearer, exact origin, JSON, closed inputs and bounded request bodies', async (t) => {
  const control = await createControl({
    engine: { available: true, version: '0.28.0' },
    execute: async () => ({ version: 1, ok: true, checks: [{ name: 'rules', ok: true }] }),
  });
  const app = await fixture(t, control);
  const auth = { Authorization: `Bearer ${app.token}` };
  const headers = { ...auth, Origin: app.url.split('/#')[0], 'Content-Type': 'application/json' };
  assert.equal((await get(app, '/api/control')).status, 401);
  assert.equal((await get(app, '/api/control', auth)).status, 200);
  assert.equal(
    (
      await get(
        app,
        '/api/runs',
        { Origin: headers.Origin, 'Content-Type': 'application/json' },
        'POST',
        '{"kind":"doctor"}',
      )
    ).status,
    401,
  );
  assert.equal((await get(app, '/api/runs', auth, 'POST', '{"kind":"doctor"}')).status, 403);
  assert.equal(
    (
      await get(
        app,
        '/api/runs',
        { ...headers, Origin: 'https://attacker.example' },
        'POST',
        '{"kind":"doctor"}',
      )
    ).status,
    403,
  );
  assert.equal(
    (await get(app, '/api/runs', { ...headers, Host: 'localhost' }, 'POST', '{"kind":"doctor"}'))
      .status,
    403,
  );
  assert.equal(
    (
      await get(
        app,
        '/api/runs',
        { ...headers, 'Content-Type': 'text/plain' },
        'POST',
        '{"kind":"doctor"}',
      )
    ).status,
    415,
  );
  assert.equal(
    (await get(app, '/api/runs', { ...headers, 'Content-Encoding': 'gzip' }, 'POST', '{}')).status,
    415,
  );
  for (const body of [
    'null',
    '{',
    '{"kind":"doctor","command":"touch /tmp/no"}',
    '{"kind":"doctor","__proto__":{}}',
    '{"kind":"content-scan","target":"skill","content":{}}',
  ]) {
    assert.equal((await get(app, '/api/runs', headers, 'POST', body)).status, 400);
  }
  assert.equal((await get(app, '/api/runs', headers, 'POST', 'x'.repeat(65537))).status, 413);
  const response = await get(app, '/api/runs', headers, 'POST', '{"kind":"doctor"}');
  assert.equal(response.status, 202);
  const run = JSON.parse(response.text);
  await control.idle();
  const finished = await get(app, `/api/runs/${run.id}`, auth);
  assert.equal(finished.status, 200);
  assert.equal(JSON.parse(finished.text).status, 'completed');
  assert.equal((await get(app, '/api/runs/not-an-id', auth)).status, 404);
  assert.equal((await get(app, '/api/runs', headers, 'DELETE')).status, 405);
  assert.equal((await get(app, '/', headers, 'POST')).status, 405);
});

test('host, origin and fetch-site gates prevent cross-origin reads, even with token', async (t) => {
  const app = await fixture(t);
  const auth = { Authorization: `Bearer ${app.token}` };
  for (const extra of [
    { Host: 'attacker.example' },
    { Host: 'localhost' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await get(app, '/api/snapshot', { ...auth, ...extra })).status, 403);
  }
  const origin = app.url.split('/#')[0];
  assert.equal(
    (await get(app, '/api/snapshot', { ...auth, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }))
      .status,
    200,
  );
  assert.equal((await get(app, '/api/snapshot', auth, 'POST')).status, 405);
});

test('all action routes enforce auth, same Origin, media type, body bounds and closed service inputs', async (t) => {
  const app = await fixture(t);
  const auth = { Authorization: `Bearer ${app.token}` };
  const headers = { ...auth, Origin: app.url.split('/#')[0], 'Content-Type': 'application/json' };
  for (const path of ['/api/agent-setup', '/api/policy', '/api/inventory']) {
    assert.equal((await get(app, path)).status, 401);
    assert.equal((await get(app, path, { ...auth, Host: 'attacker.example' })).status, 403);
    assert.equal((await get(app, path, headers, 'POST', '{}')).status, 405);
  }
  for (const path of [
    '/api/agent-setup/preview',
    '/api/agent-setup/apply',
    '/api/policy/preview',
    '/api/policy/apply',
    '/api/inventory/review',
    '/api/inventory/inspect',
    '/api/inventory/compare',
    '/api/inventory/signals/state',
    '/api/inventory/signals/preview',
    '/api/inventory/signals/apply',
  ]) {
    assert.equal(
      (
        await get(
          app,
          path,
          { Origin: headers.Origin, 'Content-Type': 'application/json' },
          'POST',
          '{}',
        )
      ).status,
      401,
    );
    assert.equal((await get(app, path, auth, 'POST', '{}')).status, 403);
    assert.equal(
      (await get(app, path, { ...headers, Origin: 'https://attacker.example' }, 'POST', '{}'))
        .status,
      403,
    );
    assert.equal(
      (await get(app, path, { ...headers, 'Sec-Fetch-Site': 'same-site' }, 'POST', '{}')).status,
      403,
    );
    assert.equal(
      (await get(app, path, { ...headers, 'Content-Type': 'text/plain' }, 'POST', '{}')).status,
      415,
    );
    assert.equal((await get(app, path, headers, 'GET')).status, 405);
    assert.equal((await get(app, path, headers, 'POST', '{broken')).status, 400);
    assert.equal(
      (await get(app, path, headers, 'POST', '{"path":"/outside","command":"never"}')).status,
      400,
    );
    assert.equal((await get(app, path, headers, 'POST', 'x'.repeat(65537))).status, 413);
  }
  const setupState = await get(app, '/api/agent-setup', auth);
  assert.equal(setupState.status, 200);
  const setupBody = JSON.parse(setupState.text);
  assert.equal(setupBody.schema, 'stroq-agent-setup/2');
  assert.match(setupBody.workspaceId, /^workspace-[a-f0-9]{24}$/);
  for (const invalid of [
    {
      previewId: '11111111-2222-4333-8444-555555555555',
      confirm: true,
      acknowledgeRetainedCopy: 'yes',
    },
    {
      previewId: '11111111-2222-4333-8444-555555555555',
      confirm: true,
      acknowledgeSharedScope: [],
    },
  ])
    assert.equal(
      (await get(app, '/api/agent-setup/apply', headers, 'POST', JSON.stringify(invalid))).status,
      400,
    );
  assert.equal((await get(app, '/api/policy', auth)).status, 200);
  assert.equal((await get(app, '/api/inventory', auth)).status, 200);
});

test('inventory review works through HTTP on a temporary project and GET never adopts drift', async (t) => {
  const app = await fixture(t);
  const directory = join(app.dir, '.claude', 'skills', 'notes');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# Notes\nSummarize the test results.');
  const headers = {
    Authorization: `Bearer ${app.token}`,
    Origin: app.url.split('/#')[0],
    'Content-Type': 'application/json',
  };
  const initial = JSON.parse((await get(app, '/api/inventory', headers)).text);
  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].state, 'unreviewed');
  await assert.rejects(access(join(app.dir, 'home', 'console')));
  const reviewed = await get(
    app,
    '/api/inventory/review',
    headers,
    'POST',
    JSON.stringify({
      itemId: initial.items[0].id,
      sha256: initial.items[0].sha256,
      expectedReviewedSha256: initial.items[0].reviewedSha256 ?? null,
    }),
  );
  assert.equal(reviewed.status, 200);
  assert.equal(JSON.parse(reviewed.text).items[0].state, 'unchanged');
  const baseline = join(app.dir, 'home', 'console', `inventory-${initial.workspace.id}.json`);
  const before = await readFile(baseline, 'utf8');
  await writeFile(join(directory, 'SKILL.md'), '# New notes\nSummarize the release.');
  const changed = JSON.parse((await get(app, '/api/inventory', headers)).text);
  assert.equal(changed.items[0].state, 'changed');
  assert.equal(await readFile(baseline, 'utf8'), before);
});

test('static files are served with security headers, traversal and symlinks are denied', async (t) => {
  const app = await fixture(t);
  await writeFile(join(app.dir, 'private.txt'), 'PRIVATE_SENTINEL');
  await symlink(join(app.dir, 'private.txt'), join(app.dir, 'out', 'leak.txt'));
  const root = await get(app, '/');
  assert.equal(root.status, 200);
  assert.match(root.text, /Console fixture/);
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  assert.equal(root.headers['referrer-policy'], 'no-referrer');
  assert.match(root.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const path of [
    '/../private.txt',
    '/%2e%2e/private.txt',
    '/%252e%252e/private.txt',
    '/%2f..%2fprivate.txt',
    '/leak.txt',
    '/.env',
    '/api/other',
  ]) {
    const result = await get(app, path);
    assert.ok(result.status >= 400, path);
    assert.ok(!result.text.includes('PRIVATE_SENTINEL'));
  }
});
