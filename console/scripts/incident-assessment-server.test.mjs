import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from './serve.mjs';

test('outer authenticated server dispatches only exact local assessment routes and closes its service', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-assessment-server-')));
  const userHome = join(root, 'user'),
    home = join(userHome, '.stroq'),
    project = join(root, 'project'),
    out = join(root, 'out');
  await Promise.all([
    mkdir(userHome, { mode: 0o700 }),
    mkdir(project, { mode: 0o700 }),
    mkdir(out, { mode: 0o700 }),
  ]);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(out, 'index.html'), 'owned fixture');
  const calls = [];
  let closed = 0;
  const service = {
    getState: async () => {
      calls.push('read');
      return { status: 200, body: { fixture: 'state' } };
    },
    preview: async (input) => {
      calls.push(['preview', input]);
      return { status: 200, body: { fixture: 'preview' } };
    },
    apply: async (input) => {
      calls.push(['apply', input]);
      return { status: 200, body: { fixture: 'apply' } };
    },
    recheck: async (input) => {
      calls.push(['recheck', input]);
      return { status: 200, body: { fixture: 'recheck' } };
    },
    close: async () => {
      closed++;
    },
  };
  const app = await startServer({
    root: out,
    home,
    userHome,
    project,
    port: 0,
    incidentAssessments: service,
  });
  t.after(async () => {
    await app.close();
    assert.equal(closed, 1);
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin,
    base = '/api/incident-assessments';
  async function request(path, body, extra = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + app.token,
        origin,
        'content-type': 'application/json',
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  assert.equal((await request(base, undefined, { authorization: 'Bearer invalid' })).status, 401);
  assert.equal(
    (await request(base + '/apply', { previewId: 'x' }, { origin: 'https://foreign.invalid' }))
      .status,
    403,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await request(base), { status: 200, body: { fixture: 'state' } });
  assert.equal((await request(base + '/preview', { id: 'fixture' })).status, 200);
  assert.equal((await request(base + '/apply', { previewId: 'fixture' })).status, 200);
  assert.equal(
    (await request(base + '/recheck', { recordId: 'fixture', expectedEvidenceSha: 'a'.repeat(64) }))
      .status,
    200,
  );
  const before = calls.length;
  for (const path of [
    base + '?file=private',
    base + '#private',
    base + '/apply/extra',
    base + '/delete',
  ]) {
    if (path.includes('#')) continue; // URL fragments do not reach HTTP; the local operation allowlist rejects them.
    assert([400, 404].includes((await request(path)).status));
  }
  assert.equal((await request(base, {})).status, 405);
  assert.equal((await request(base + '/apply')).status, 405);
  const duplicate = await fetch(origin + base + '/apply', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, origin, 'content-type': 'application/json' },
    body: '{"previewId":"a","preview\\u0049d":"b"}',
  });
  assert.equal(duplicate.status, 400);
  assert.equal(calls.length, before);
});
