import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  lstat,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskAccessService } from './task-access-service.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { accessFixture, buildAccessFixture } from './task-access-test-helpers.mjs';

const built = await buildAccessFixture();
after(() => rm(built.output, { recursive: true, force: true }));
const browser = (input) => ({ id: input.id, expectedEvidenceSha: input.expectedEvidenceSha });
const consent = (id) => ({
  previewId: id,
  acknowledgeOneUse: true,
  acknowledgeSigningKeyUse: true,
});

test('closed preview and consent boundaries never create a key store or consume a plan', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-access-service-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const home = join(userHome, '.stroq');
  const service = await createTaskAccessService({ project, userHome, home });
  t.after(() => service.close());
  for (const input of [
    null,
    {},
    { id: 'incident-' + 'a'.repeat(64) },
    {
      id: 'incident-' + 'a'.repeat(64),
      expectedEvidenceSha: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
    },
  ])
    assert.equal((await service.preview(input)).status, 400);
  for (const input of [
    {},
    { previewId: 'bad', acknowledgeOneUse: true, acknowledgeSigningKeyUse: true },
    { previewId: '11111111-1111-1111-1111-111111111111', acknowledgeOneUse: true },
    {
      previewId: '11111111-1111-1111-1111-111111111111',
      acknowledgeOneUse: true,
      acknowledgeSigningKeyUse: false,
    },
  ])
    assert.equal((await service.issue(input)).status, 400);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});

test('consent is nonconsuming, issue binds exact approved expiry, and refresh/restart read durable grant', async (t) => {
  const f = await accessFixture(t, built),
    refused = await f.refuse(),
    service = await f.service();
  const made = await service.preview(browser(refused.input));
  assert.equal(made.status, 200);
  assert.equal(built.schema.validateTaskAccessPreview(made.body), true);
  const keyBefore = await lstat(f.privatePath);
  for (const input of [
    { previewId: made.body.id },
    { ...consent(made.body.id), acknowledgeOneUse: false },
    { ...consent(made.body.id), acknowledgeSigningKeyUse: false },
    { ...consent(made.body.id), fingerprint: 'a'.repeat(64) },
  ])
    assert.equal((await service.issue(input)).status, 400);
  await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
    code: 'ENOENT',
  });
  assert.equal((await lstat(f.privatePath)).atimeMs, keyBefore.atimeMs);
  const result = await service.issue(consent(made.body.id));
  assert.equal(result.status, 200);
  assert.equal(result.body.previewId, made.body.id);
  assert.equal(result.body.issuedAt, made.body.createdAt);
  assert.equal(result.body.expiresAt, made.body.grantExpiresAt);
  assert.equal((await service.issue(consent(made.body.id))).status, 409);
  await service.close();
  const reopened = await f.service();
  const current = await reopened.getState({
    id: result.body.taskId,
    expectedPermitSha256: result.body.permitSha256,
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.permissions[0].extensionSha256, result.body.extensionSha256);
  assert.equal(current.body.permissions[0].state, 'unused');
});

test('current source, context and runtime drift consume the attempt but never publish a grant', async (t) => {
  for (const kind of ['runtime', 'root', 'source', 'selector'])
    await t.test(kind, async (sub) => {
      const f = await accessFixture(sub, built),
        refused = await f.refuse();
      let stale = false;
      const service = await f.service({
        selectEvidence: async (request) => {
          const row = await f.incidents.selectForComparison(request);
          return stale ? { ...row, seq: row.seq + 1 } : row;
        },
      });
      const made = await service.preview(browser(refused.input));
      assert.equal(made.status, 200);
      if (kind === 'runtime') f.setRuntime('b'.repeat(64));
      if (kind === 'root') await (await import('node:fs/promises')).chmod(f.project, 0o750);
      if (kind === 'source')
        await writeFile(f.sourcePath, (await readFile(f.sourcePath, 'utf8')) + '\n');
      if (kind === 'selector') stale = true;
      const result = await service.issue(consent(made.body.id));
      assert.equal(result.status, 409);
      assert.ok(['preview-stale', 'stale-evidence'].includes(result.body.error));
      await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
        code: 'ENOENT',
      });
      assert.equal((await service.issue(consent(made.body.id))).status, 409);
    });
});

test('maximum preview count, actual expiry and shorter remaining permit lifetime are bounded', async (t) => {
  const f = await accessFixture(t, built, { body: { expiresAt: '2026-10-24T12:00:30.000Z' } });
  const refused = await f.refuse(),
    service = await f.service();
  const first = await service.preview(browser(refused.input));
  assert.equal(first.body.expiresAt, first.body.grantExpiresAt);
  assert.equal(first.body.grantExpiresAt, f.body.expiresAt);
  for (let index = 0; index < 8; index++)
    assert.equal((await service.preview(browser(refused.input))).status, 200);
  assert.equal((await service.issue(consent(first.body.id))).body.error, 'preview-stale');
  const final = await service.preview(browser(refused.input));
  f.advance(30001);
  assert.equal((await service.issue(consent(final.body.id))).body.error, 'preview-expired');
  await assert.rejects(lstat(join(f.home, 'tasks', f.body.taskId, 'extensions')), {
    code: 'ENOENT',
  });
});

test('worker cancellation settles only after termination and releases the real shared lock', async (t) => {
  const f = await accessFixture(t, built),
    refused = await f.refuse(),
    made = await f.run('access-preview', refused.input);
  const workerPath = join(f.base, 'paused-worker.mjs'),
    started = join(f.base, 'started'),
    late = join(f.base, 'late');
  await writeFile(
    workerPath,
    `import{parentPort,workerData}from'node:worker_threads';import{writeFileSync}from'node:fs';
if(workerData.operation==='access-preview')parentPort.postMessage({type:'result',result:${JSON.stringify(made)}});
if(workerData.operation==='access-issue'){writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>writeFileSync(${JSON.stringify(late)},'late'),1000);setInterval(()=>{},1000);}`,
  );
  const service = await f.service({ workerPath });
  const prepared = await service.preview(browser(refused.input));
  const pending = service.issue(consent(prepared.body.id));
  for (let index = 0; index < 100; index++) {
    try {
      await lstat(started);
      break;
    } catch {
      await delay(10);
    }
  }
  assert.ok((await lstat(started)).isFile());
  let acquired = false;
  const waiter = built.core.withManifestLock(
    { home: f.home, version: '0.28.0', now: () => new Date(f.time()) },
    async () => {
      acquired = true;
    },
    { timeoutMs: 3000 },
  );
  await delay(50);
  assert.equal(acquired, false);
  await service.close();
  const result = await pending;
  assert.equal(result.body.error, 'write-unconfirmed');
  await waiter;
  assert.equal(acquired, true);
  await delay(1050);
  await assert.rejects(lstat(late), { code: 'ENOENT' });
  assert.equal((await service.issue(consent(prepared.body.id))).body.error, 'server-stopped');
});

test('a large complete redacted operation remains selectable and preview never starts or writes it', async (t) => {
  const f = await accessFixture(t, built, {
    event: {
      toolName: 'Write',
      toolInput: { file_path: '/outside/never-created.txt', content: 'x'.repeat(40000) },
    },
  });
  const refused = await f.refuse(),
    service = await f.service();
  assert.ok(Buffer.byteLength(refused.raw) > 65536);
  const before = await readdir(join(f.home, 'tasks', f.body.taskId));
  const result = await service.preview(browser(refused.input));
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body.operation.review).input.content.length, 40000);
  assert.deepEqual(await readdir(join(f.home, 'tasks', f.body.taskId)), before);
});
