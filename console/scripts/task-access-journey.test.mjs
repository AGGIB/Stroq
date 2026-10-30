import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessFixture, buildAccessFixture } from './task-access-test-helpers.mjs';
import { startServer } from './serve.mjs';

const built = await buildAccessFixture();
after(() => rm(built.output, { recursive: true, force: true }));
const consent = (id) => ({
  previewId: id,
  acknowledgeOneUse: true,
  acknowledgeSigningKeyUse: true,
});
async function fixture(t, extra = {}) {
  const f = await accessFixture(t, built, extra),
    refused = await f.refuse(),
    access = await f.service();
  const root = join(f.base, 'static');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), 'inert fixture');
  const app = await startServer({
    root,
    project: f.project,
    userHome: f.userHome,
    home: f.home,
    incidents: f.incidents,
    taskAccess: access,
    port: 0,
  });
  t.after(() => app.close());
  const origin = app.url.split('/#')[0];
  async function request(path, body, headers = {}, method) {
    const result = await fetch(origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string' || Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body),
    });
    return { status: result.status, body: await result.json().catch(() => null) };
  }
  const preview = () =>
    request('/api/task-locks/access/preview', {
      id: refused.input.id,
      expectedEvidenceSha: refused.input.expectedEvidenceSha,
    });
  return { ...f, refused, request, preview, access, origin };
}

test('authenticated HTTP exact refusal approval enables one isolated core call, ledger readback and no incident resolution', async (t) => {
  const f = await fixture(t),
    sourceBefore = await readFile(f.sourcePath),
    privateBefore = await readFile(f.privatePath);
  const made = await f.preview();
  assert.equal(made.status, 200);
  assert.equal(built.schema.validateTaskAccessPreview(made.body), true);
  await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
    code: 'ENOENT',
  });
  assert.equal(
    (
      await f.request('/api/task-locks/access/issue', {
        previewId: made.body.id,
        acknowledgeOneUse: true,
      })
    ).status,
    400,
  );
  const issued = await f.request('/api/task-locks/access/issue', consent(made.body.id));
  assert.equal(issued.status, 200);
  assert.equal(built.schema.validateTaskAccessReceipt(issued.body), true);
  assert.equal(issued.body.execution, 'unverified');
  const path = `/api/task-locks/access/${issued.body.taskId}/${issued.body.permitSha256}`;
  const current = await f.request(path);
  assert.equal(current.status, 200);
  assert.equal(built.schema.validateTaskAccessState(current.body), true);
  assert.equal(current.body.permissions[0].state, 'unused');
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'manually-retried' })).decision.effect,
    'allow',
  );
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'manually-retried-again' })).decision.effect,
    'deny',
  );
  assert.equal((await f.request(path)).body.permissions[0].state, 'consumed');
  assert.equal(
    (await f.request('/api/task-locks/access/issue', consent(made.body.id))).status,
    409,
  );
  const incidents = await f.request('/api/incidents');
  assert.equal(incidents.status, 200);
  const original = incidents.body.incidents.find((row) => row.id === f.refused.input.id);
  assert.ok(original);
  assert.equal(original.status, 'open');
  assert.equal(original.reviewedAt, null);
  assert.deepEqual(await readFile(f.sourcePath), sourceBefore);
  assert.deepEqual(await readFile(f.privatePath), privateBefore);
  for (const value of [issued.body, current.body])
    for (const raw of [
      f.body.taskId,
      f.body.nonce,
      f.body.sessionId,
      privateBefore.toString(),
      f.home,
    ])
      assert.equal(JSON.stringify(value).includes(raw), false);
});

test('HTTP auth, origin, UTF-8, duplicate keys, closed fields and body caps reject without consuming preview', async (t) => {
  const f = await fixture(t),
    made = await f.preview(),
    valid = consent(made.body.id);
  for (const [body, headers, status] of [
    [valid, { Authorization: '' }, 401],
    [valid, { Origin: 'https://foreign.invalid' }, 403],
    [valid, { 'Content-Type': 'text/plain' }, 415],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(4097), {}, 413],
    [{ ...valid, taskId: f.body.taskId }, {}, 400],
    [{ ...valid, privateKey: 'injected' }, {}, 400],
    [{ ...valid, acknowledgeSigningKeyUse: false }, {}, 400],
    [
      `{"previewId":"${made.body.id}","acknowledgeOneUse":true,"acknowledgeOneUse":true,"acknowledgeSigningKeyUse":true}`,
      {},
      400,
    ],
    [{ ...valid, acknowledgeOneUse: [true] }, {}, 400],
  ])
    assert.equal((await f.request('/api/task-locks/access/issue', body, headers)).status, status);
  for (const input of [
    {
      id: f.refused.input.id,
      expectedEvidenceSha: f.refused.input.expectedEvidenceSha,
      fingerprint: 'a'.repeat(64),
    },
    { id: '../private', expectedEvidenceSha: 'a'.repeat(64) },
    {
      id: f.refused.input.id,
      expectedEvidenceSha: f.refused.input.expectedEvidenceSha,
      command: 'injected',
    },
  ])
    assert.equal((await f.request('/api/task-locks/access/preview', input)).status, 400);
  assert.equal((await f.request('/api/task-locks/access/issue', undefined, {}, 'GET')).status, 405);
  assert.equal(
    (await f.request('/api/task-locks/access/task-invalid/' + 'a'.repeat(64))).status,
    404,
  );
  await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
    code: 'ENOENT',
  });
  assert.equal((await f.request('/api/task-locks/access/issue', valid)).status, 200);
});

test('fresh exact source and runtime are rechecked at HTTP issue; refusal remains available after failure', async (t) => {
  for (const kind of ['source', 'runtime', 'journal'])
    await t.test(kind, async (sub) => {
      const f = await fixture(sub),
        made = await f.preview();
      if (kind === 'source')
        await writeFile(f.sourcePath, (await readFile(f.sourcePath, 'utf8')) + '\n');
      if (kind === 'runtime') f.setRuntime('c'.repeat(64));
      if (kind === 'journal') {
        const raw = await readFile(f.journalPath);
        await rm(f.journalPath);
        await writeFile(f.journalPath, raw, { mode: 0o600 });
      }
      const result = await f.request('/api/task-locks/access/issue', consent(made.body.id));
      assert.equal(result.status, 409);
      assert.ok(['preview-stale', 'stale-evidence'].includes(result.body.error));
      await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
        code: 'ENOENT',
      });
      assert.deepEqual(await readdir(join(f.home, 'tasks', f.body.taskId)), ['permit.json']);
    });
});

test('ledger consumption state does not imply task eligibility; expired and terminal task records remain separate', async (t) => {
  const f = await fixture(t),
    made = await f.preview();
  const issued = await f.request('/api/task-locks/access/issue', consent(made.body.id));
  const path = `/api/task-locks/access/${issued.body.taskId}/${issued.body.permitSha256}`;
  f.store.revoke(f.body.taskId);
  const current = await f.request(path);
  assert.equal(current.status, 200);
  assert.equal(current.body.permissions[0].state, 'unused');
  assert.equal(
    (await f.stroq.pre({ ...f.event, callId: 'terminal-retry' })).decision.effect,
    'deny',
  );
  f.advance(360000);
  assert.equal((await f.request(path)).body.permissions[0].state, 'expired');
  assert.equal((await f.preview()).body.error, 'task-unavailable');
});
