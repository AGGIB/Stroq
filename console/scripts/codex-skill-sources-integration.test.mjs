import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createInventory } from './inventory.mjs';
import { startServer } from './serve.mjs';

test('manual Codex source preview accepts no browser-selected source, path or configuration', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-manual-input-')));
  const project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const home = join(userHome, '.stroq');
  const inventory = createInventory({ project, userHome, home });
  t.after(async () => {
    await inventory.close();
    await rm(base, { recursive: true, force: true });
  });
  for (const input of [
    null,
    [],
    undefined,
    { path: project },
    { CODEX_HOME: userHome },
    { action: 'enable' },
    { watch: true },
  ]) {
    assert.deepEqual(await inventory.codexSources(input), {
      status: 400,
      body: { error: 'invalid-request' },
    });
  }
  await assert.rejects(access(home), { code: 'ENOENT' });
});

test('manual Codex source route is authenticated, same-origin POST with strict empty JSON', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-manual-http-')));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    root = join(base, 'static');
  for (const path of [project, userHome, root]) await mkdir(path);
  await writeFile(join(root, 'index.html'), 'fixture');
  let calls = 0;
  const app = await startServer({
    project,
    userHome,
    root,
    port: 0,
    inventory: {
      async codexSources(input) {
        assert.deepEqual(input, {});
        calls++;
        return { status: 200, body: { fixture: true } };
      },
      async close() {},
    },
  });
  t.after(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin,
    route = origin + '/api/inventory/codex-sources';
  const headers = {
    authorization: `Bearer ${app.token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  assert.equal(
    (
      await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal((await fetch(route, { headers })).status, 405);
  assert.equal(
    (
      await fetch(route, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(route, { method: 'POST', headers, body: '{"a":1,"a":2}' })).status,
    400,
  );
  assert.equal(
    (await fetch(route, { method: 'POST', headers, body: Buffer.from([0xff]) })).status,
    400,
  );
  assert.equal(calls, 0);
  const response = await fetch(route, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fixture: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 1);
});

test('the manual method refuses replaced project or user directories captured at console creation', async (t) => {
  for (const replaced of ['project', 'userHome']) {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-manual-incarnation-')));
    const project = join(base, 'project'),
      userHome = join(base, 'user');
    await mkdir(project);
    await mkdir(userHome);
    const inventory = createInventory({ project, userHome, home: join(userHome, '.stroq') });
    t.after(async () => {
      await inventory.close();
      await rm(base, { recursive: true, force: true });
    });
    await delay(20);
    const target = replaced === 'project' ? project : userHome;
    await rename(target, target + '-original');
    await mkdir(target);
    const skill = join(target, '.agents', 'skills', 'replacement-must-not-be-captured');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), 'PRIVATE_REPLACEMENT_SOURCE');
    const result = await inventory.codexSources({});
    assert.deepEqual(result, { status: 503, body: { error: 'inventory-unavailable' } });
    assert.equal(JSON.stringify(result).includes('replacement'), false);
  }
});
