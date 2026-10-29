import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-http-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    root = join(base, 'out');
  for (const p of [project, userHome, root]) await mkdir(p);
  await writeFile(join(root, 'index.html'), 'fixture');
  const calls = [],
    action = (name) => async (input) => {
      calls.push({ name, input });
      return { status: 200, body: { fixture: name } };
    };
  const guard = Object.fromEntries(
      ['read', 'capture', 'preview', 'apply', 'recheck', 'close'].map((n) => [
        n,
        action('guard.' + n),
      ]),
    ),
    checks = Object.fromEntries(
      ['read', 'preview', 'start', 'cancel', 'close'].map((n) => [n, action('checks.' + n)]),
    );
  const app = await startServer({
    project,
    userHome,
    root,
    port: 0,
    codexNetworkGuard: guard,
    codexNetworkChecks: checks,
  });
  t.after(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  const request = async (path, method = 'GET', body, headers = {}) => {
    const r = await fetch(origin + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + app.token,
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  return { calls, request, userHome };
}
test('only exact fixed routes dispatch; passive GETs never capture, apply or execute', async (t) => {
  const f = await fixture(t);
  for (const [prefix, type, actions] of [
    ['codex-network-guard', 'guard', ['capture', 'preview', 'apply', 'recheck']],
    ['codex-network-checks', 'checks', ['preview', 'start', 'cancel']],
  ]) {
    const r = await f.request('/api/' + prefix);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.calls.at(-1), { name: type + '.read', input: undefined });
    assert.equal((await f.request('/api/' + prefix, 'POST', {})).status, 405);
    for (const name of actions) {
      const path = '/api/' + prefix + '/' + name;
      assert.equal((await f.request(path)).status, 405);
      assert.equal((await f.request(path, 'POST', {})).status, 200);
      assert.deepEqual(f.calls.at(-1), { name: type + '.' + name, input: {} });
    }
    assert.equal((await f.request('/api/' + prefix + '/start/extra', 'POST', {})).status, 404);
  }
  await assert.rejects(lstat(join(f.userHome, '.codex')), { code: 'ENOENT' });
});
test('network mutations require existing loopback auth/origin/JSON bounds before dispatch', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/codex-network-guard/apply',
    '/api/codex-network-checks/start',
    '/api/codex-network-checks/cancel',
  ])
    for (const [body, headers, status] of [
      [{}, { Authorization: '' }, 401],
      [{}, { Origin: 'https://foreign.invalid' }, 403],
      [{}, { 'Content-Type': 'text/plain' }, 415],
      [{}, { 'Content-Encoding': 'gzip' }, 415],
      ['{', {}, 400],
      ['x'.repeat(4097), {}, 413],
    ])
      assert.equal((await f.request(path, 'POST', body, headers)).status, status);
  assert.equal(f.calls.length, 0);
});
