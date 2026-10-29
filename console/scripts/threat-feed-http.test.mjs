import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

// The real server with a stand-in for the threat feed: these tests never reach the network.
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-threats-http-')));
  await mkdir(join(dir, 'out'));
  const home = join(dir, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, 'out', 'index.html'), 'x');
  const asked = [];
  const threatFeed = {
    read: async (input) => {
      asked.push(input);
      return { status: 200, body: { stand: 'in' } };
    },
    close: async () => {},
  };
  const app = await startServer({
    root: join(dir, 'out'),
    home,
    userHome: home,
    project: dir,
    port: 0,
    threatFeed,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  const call = (path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: app.server.address().port,
          path,
          method,
          headers: { authorization: `Bearer ${app.token}`, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const post = (payload, extra = {}) =>
    call('/api/threats', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...extra },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  return { asked, call, post };
}

test('the threat feed is a POST from the page itself, with a small JSON body', async (t) => {
  const { asked, call, post } = await fixture(t);
  const ok = await post({ source: 'pwn.watch' });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { stand: 'in' });
  assert.deepEqual(asked, [{ source: 'pwn.watch' }]);
  // A plain load, a link or another site never reaches it.
  assert.equal((await call('/api/threats')).status, 405);
  assert.equal(
    (await post({ source: 'pwn.watch' }, { origin: 'https://attacker.invalid' })).status,
    403,
  );
  assert.equal((await post({ source: 'pwn.watch' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('/api/threats?url=https://x', { method: 'POST' })).status, 400);
  assert.equal((await post({ source: 'x'.repeat(2000) })).status, 413);
  assert.equal((await post('{broken')).status, 400);
  assert.equal((await call('/api/threats/fetch', { method: 'POST' })).status, 404);
  assert.equal(asked.length, 1, 'only the one good request reached the feed');
});

test('without the token the threat feed is not reached', async (t) => {
  const { asked, call } = await fixture(t);
  const res = await call('/api/threats', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'pwn.watch' }),
  });
  assert.equal(res.status, 401);
  assert.equal(asked.length, 0);
});
