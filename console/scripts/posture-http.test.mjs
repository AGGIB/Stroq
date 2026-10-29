import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

const schemas = await import('../.local-engine/local-api-schema.js');

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-posture-http-')));
  await mkdir(join(dir, 'out'));
  const userHome = join(dir, 'home');
  const project = join(dir, 'project');
  await mkdir(join(userHome, '.claude'), { recursive: true });
  await mkdir(join(project, '.codex'), { recursive: true });
  await writeFile(join(dir, 'out', 'index.html'), 'x');
  await writeFile(
    join(userHome, '.claude', 'settings.json'),
    '{"permissions":{"allow":["Bash(*)"]}}',
  );
  await writeFile(join(project, '.codex', 'config.toml'), '[features]\nhooks = false\n');
  const app = await startServer({
    root: join(dir, 'out'),
    home: join(userHome, '.stroq'),
    userHome,
    project,
    port: 0,
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
  return { dir, userHome, project, origin, call };
}

test('the real server answers the settings check with the closed schema', async (t) => {
  const { call, dir } = await fixture(t);
  const reply = await call('/api/posture');
  assert.equal(reply.status, 200, reply.text);
  const body = JSON.parse(reply.text);
  assert.equal(schemas.validatePostureAudit(body), true);
  assert.deepEqual(
    body.findings.map((f) => `${f.id}/${f.scope}${f.count === null ? '' : `:${f.count}`}`).sort(),
    ['claude-allow-any-shell/user:1', 'claude-sandbox-off/user', 'codex-hooks-off/project'],
  );
  assert.equal(reply.text.includes(dir), false, 'no path of the person reaches the reply');
});

test('only a plain authenticated GET is answered', async (t) => {
  const { call, origin } = await fixture(t);
  assert.equal((await call('/api/posture?path=/etc/passwd')).status, 400);
  assert.equal(
    (
      await call('/api/posture', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    405,
  );
  assert.equal(
    (await call('/api/posture', { headers: { 'content-length': '2' }, body: '{}' })).status,
    400,
  );
  assert.equal((await call('/api/posture/other')).status, 404);
  assert.equal(
    (await call('/api/posture', { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal((await call('/api/posture', { headers: { authorization: '' } })).status, 401);
});

test('checking settings writes nothing, in the home folder or in the repository', async (t) => {
  const { call, userHome, project } = await fixture(t);
  const listing = async () =>
    [
      ...(await readdir(userHome, { recursive: true })),
      ...(await readdir(project, { recursive: true })),
    ].sort();
  const before = await listing();
  await call('/api/posture');
  await call('/api/posture');
  assert.deepEqual(await listing(), before);
});
