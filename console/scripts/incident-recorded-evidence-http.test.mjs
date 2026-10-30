import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

const PATH = '/api/incidents/evidence';
const sha = 'a'.repeat(64);
const input = { id: `incident-${sha}`, expectedEvidenceSha: sha };

async function fixture(t, explain) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-recorded-evidence-http-')));
  const project = join(dir, 'project'),
    root = join(dir, 'out');
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.all([mkdir(project), mkdir(root)]);
  await writeFile(join(root, 'index.html'), 'fixture');
  app = await startServer({
    home: join(dir, '.stroq'),
    userHome: dir,
    project,
    root,
    port: 0,
    incidents: { explain, close: async () => undefined },
  });
  const origin = app.url.split('/#')[0];
  async function request(body = input, options = {}) {
    const headers = {
      Authorization: `Bearer ${app.token}`,
      Origin: origin,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
    const response = await fetch(origin + (options.path ?? PATH), {
      method: options.method ?? 'POST',
      headers,
      body: options.method === 'GET' ? undefined : (options.raw ?? JSON.stringify(body)),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  return { request };
}

test('recorded-evidence HTTP has exact route, closed scalar grammar and ordinary authenticated action gates', async (t) => {
  const calls = [];
  const { request } = await fixture(t, async (body) => {
    calls.push(body);
    return { result: 'fixture' };
  });
  assert.deepEqual(await request(), { status: 200, body: { result: 'fixture' } });
  assert.deepEqual(calls, [input]);
  assert.equal((await request(input, { method: 'GET' })).status, 405);
  assert.equal((await request(input, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(
    (await request(input, { headers: { Origin: 'https://foreign.invalid' } })).status,
    403,
  );
  assert.equal((await request(input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request({ padding: 'x'.repeat(4097) })).status, 413);
  assert.equal((await request(input, { path: PATH + '?seq=1' })).status, 400);
  assert.equal(
    (
      await request(input, {
        raw: `{"id":"first","i\\u0064":"second","expectedEvidenceSha":"${sha}"}`,
      })
    ).status,
    400,
  );
  assert.equal((await request(input, { raw: '{"id":{}}' })).status, 400);
  assert.equal((await request(input, { raw: Buffer.from([0xc3, 0x28]) })).status, 400);
  assert.equal((await request(input, { path: PATH + '/extra' })).status, 404);
  assert.equal(calls.length, 1);
});

test('recorded-evidence HTTP returns finite refusals and withholds unexpected private error text', async (t) => {
  let error = 'stale-evidence';
  const { request } = await fixture(t, async () => {
    throw Error(error);
  });
  assert.deepEqual(await request(), { status: 409, body: { error: 'stale-evidence' } });
  error = 'PRIVATE_PATH_OR_COMMAND';
  assert.deepEqual(await request(), { status: 503, body: { error: 'operation-unavailable' } });
});
