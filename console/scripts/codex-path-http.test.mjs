import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-http-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    root = join(base, 'out'),
    home = join(base, 'state');
  for (const p of [project, userHome, root, home]) await mkdir(p);
  await writeFile(join(root, 'index.html'), 'fixture');
  const calls = [],
    action = (name) => async (input) => {
      calls.push({ name, input });
      return { status: 200, body: { fixture: name } };
    };
  const guard = Object.fromEntries(
    ['read', 'capture', 'preview', 'apply', 'recheck', 'close'].map((n) => [n, action(n)]),
  );
  const app = await startServer({ project, userHome, home, root, port: 0, codexPathGuard: guard });
  t.after(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0],
    request = async (path, method = 'GET', body, headers = {}) => {
      const r = await fetch(origin + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + app.token,
          Origin: origin,
          'Content-Type': 'application/json',
          ...headers,
        },
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: r.status, text: await r.text(), headers: r.headers };
    };
  return { calls, request, userHome };
}
test('only five exact Path API routes dispatch and passive GET never inspects credentials or changes configuration', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/codex-path-guard')).status, 200);
  assert.deepEqual(f.calls, [{ name: 'read', input: undefined }]);
  assert.equal((await f.request('/api/codex-path-guard')).headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/api/codex-path-guard', 'POST', {})).status, 405);
  for (const name of ['capture', 'preview', 'apply', 'recheck']) {
    const path = '/api/codex-path-guard/' + name;
    assert.equal((await f.request(path)).status, 405);
    assert.equal((await f.request(path, 'POST', {})).status, 200);
    assert.deepEqual(f.calls.at(-1), { name, input: {} });
  }
  for (const path of [
    '/api/codex-path-guard/start',
    '/api/codex-path-guard/apply/extra',
    '/api/codex-path-guard/capture?path=/private/tmp/arbitrary',
  ])
    assert.equal((await f.request(path, 'POST', {})).status, 404);
  await assert.rejects(lstat(join(f.userHome, '.codex')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.userHome, '.aws')), { code: 'ENOENT' });
});
test('Path routes enforce existing authentication, Origin, methods, encoding and bounded JSON before dispatch', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/codex-path-guard/capture',
    '/api/codex-path-guard/preview',
    '/api/codex-path-guard/apply',
    '/api/codex-path-guard/recheck',
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
