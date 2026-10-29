import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from './serve.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-session-taint-server-')));
  await mkdir(join(dir, 'out'));
  await mkdir(join(dir, 'user'));
  await writeFile(join(dir, 'out/index.html'), '<h1>Stroq fixture</h1>');
  const calls = [];
  const service = Object.fromEntries(
    ['getState', 'inspect', 'preview', 'clear', 'recheck'].map((kind) => [
      kind,
      async (input) => {
        calls.push({ kind, input });
        return { status: 200, body: { accepted: kind } };
      },
    ]),
  );
  service.close = async () => calls.push({ kind: 'close' });
  const app = await startServer({
    root: join(dir, 'out'),
    userHome: join(dir, 'user'),
    home: join(dir, 'user/.stroq'),
    project: dir,
    port: 0,
    sessionTaint: service,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  const headers = {
    Authorization: `Bearer ${app.token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const send = (path, method = 'POST', body = '{}', extra = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: app.server.address().port,
          path,
          method,
          headers: { ...headers, ...extra },
        },
        (res) => {
          const parts = [];
          res.on('data', (chunk) => parts.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(parts).toString(),
              headers: res.headers,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : body);
    });
  return { ...app, calls, send, dir };
}

test('server wires only the fixed taint operations after all outer request gates', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.dir, 'out/index.html'));
  for (const action of ['inspect', 'preview', 'clear', 'recheck']) {
    const path = `/api/session-taint/${action}`;
    for (const [extra, status] of [
      [{ Authorization: '' }, 401],
      [{ Origin: 'https://foreign.invalid' }, 403],
      [{ Host: 'localhost' }, 403],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
      [{ 'Content-Type': 'text/plain' }, 415],
    ]) {
      assert.equal((await f.send(path, 'POST', '{}', extra)).status, status);
      assert.equal(f.calls.length, 0);
    }
    assert.equal((await f.send(path, 'POST', '{"id":"a","id":"b"}')).status, 400);
    assert.equal((await f.send(path, 'POST', '{"id":"\\ud800"}')).status, 400);
    assert.equal((await f.send(path + '?session=private')).status, 400);
    assert.equal((await f.send(path, 'GET')).status, 405);
    assert.equal(f.calls.length, 0);
  }
  for (const [path, method, expected] of [
    ['/api/session-taint', 'GET', 'getState'],
    ...['inspect', 'preview', 'clear', 'recheck'].map((action) => [
      `/api/session-taint/${action}`,
      'POST',
      action,
    ]),
  ]) {
    const response = await f.send(path, method);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { accepted: expected });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(f.calls.at(-1).kind, expected);
  }
  const count = f.calls.length;
  for (const path of ['/api/session-taint/all', '/api/session-taint/restore'])
    assert.equal((await f.send(path)).status, 404);
  assert.equal(f.calls.length, count);
  assert.deepEqual(await readFile(join(f.dir, 'out/index.html')), before);
});
