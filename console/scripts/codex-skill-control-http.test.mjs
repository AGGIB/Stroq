import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-controls-http-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'user'),
    root = join(dir, 'out');
  await Promise.all([mkdir(project), mkdir(userHome), mkdir(root)]);
  await writeFile(join(root, 'index.html'), 'fixture');
  const calls = [];
  const action = (name) => async (input) => {
    calls.push({ name, input });
    return { status: 200, body: { fixture: name } };
  };
  const inventory = {
    codexControlState: action('state'),
    codexControlPreview: action('preview'),
    codexControlApply: action('apply'),
    codexControlRecheck: action('recheck'),
    close: async () => {},
  };
  const app = await startServer({ project, userHome, root, port: 0, inventory });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }
  return { dir, userHome, calls, request };
}

test('Codex skill control HTTP routes dispatch fixed methods with no GET mutation', async (t) => {
  const f = await fixture(t);
  const state = await f.request('/api/inventory/codex-controls');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls, [{ name: 'state', input: {} }]);
  for (const name of ['preview', 'apply', 'recheck']) {
    const path = '/api/inventory/codex-control-' + name;
    assert.equal((await f.request(path)).status, 405);
    assert.equal((await f.request(path, 'POST', { fixture: name })).status, 200);
    assert.deepEqual(f.calls.at(-1), { name, input: { fixture: name } });
  }
  const before = f.calls.length;
  assert.equal((await f.request('/api/inventory/codex-controls', 'POST', {})).status, 405);
  assert.equal(
    (await f.request('/api/inventory/codex-control-apply/extra', 'POST', {})).status,
    404,
  );
  assert.equal(f.calls.length, before);
  await assert.rejects(access(join(f.userHome, '.codex')));
  await assert.rejects(access(join(f.userHome, '.stroq', 'codex-skill-controls')));
});

test('Codex skill control mutation routes reject unauthenticated, foreign and malformed requests before dispatch', async (t) => {
  const f = await fixture(t);
  for (const name of ['preview', 'apply', 'recheck']) {
    const path = '/api/inventory/codex-control-' + name;
    for (const [body, headers, expected] of [
      [{}, { Authorization: '' }, 401],
      [{}, { Origin: 'https://foreign.invalid' }, 403],
      [{}, { 'Content-Type': 'text/plain' }, 415],
      [{}, { 'Content-Encoding': 'gzip' }, 415],
      ['{', {}, 400],
      ['x'.repeat(4097), {}, 413],
    ])
      assert.equal((await f.request(path, 'POST', body, headers)).status, expected);
  }
  assert.equal(f.calls.length, 0);
});
