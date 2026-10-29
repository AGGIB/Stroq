import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import { createTaskLockService } from './task-lock-service.mjs';
import { startServer } from './serve.mjs';
const schema = {
  ...(await tsImport('../lib/task-locks.ts', import.meta.url)),
  ...(await tsImport('../lib/task-lock-page.ts', import.meta.url)),
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = `task-${'b'.repeat(64)}`,
  permitSha256 = 'c'.repeat(64);
const at = Date.parse('2026-10-24T12:00:00.000Z');
const row = {
  id,
  permitSha256,
  profile: 'repo-edit-and-test',
  policySha256: 'd'.repeat(64),
  issuedAt: '2026-10-24T11:50:00.000Z',
  expiresAt: '2026-10-24T12:30:00.000Z',
  declaredMode: 'srt',
  eligibility: 'eligible',
  standing: 'present',
  policyRelation: 'matches-current',
  scope: {
    tools: ['Read'],
    shell: 'denied',
    read: { allow: [], deny: [] },
    write: { allow: [], deny: [] },
    net: { mode: 'none' },
    mcp: [],
  },
  evidence: { status: 'missing', journalSha256: null, counts: null, lastGate: null },
};
async function fixture(t, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-page-service-')));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  let clock = at,
    runtime = 'a'.repeat(64);
  const workerPath = join(base, 'worker.mjs'),
    control = join(base, 'control.json');
  const settings = { sha256: 'e'.repeat(64), total: 130, limited: false, hold: false };
  const save = () => writeFile(control, JSON.stringify(settings));
  await save();
  await writeFile(
    workerPath,
    `import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync,writeFileSync} from 'node:fs';
const {operation,input,options}=workerData, control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const row=${JSON.stringify(row)};
if(options.configurationLockHeld)throw Error('PAGE_MUST_NOT_LOCK');
if(control.hold){setTimeout(()=>writeFileSync(${JSON.stringify(join(base, 'late'))},'BAD'),500);setInterval(()=>{},1000);}
else if(operation==='page'||operation==='state'){
 let offset=input.offset??64;
 if(input.id&&input.id!==row.id){parentPort.postMessage({type:'error',error:control.limited?'task-lookup-limit':'task-unavailable'});}
 else if(input.id&&input.expectedPermitSha256!==null&&input.expectedPermitSha256!==row.permitSha256){parentPort.postMessage({type:'error',error:'preview-stale'});}
 else if(input.expectedListingSha256&&input.expectedListingSha256!==control.sha256){parentPort.postMessage({type:'error',error:'task-page-stale'});}
 else{
 const state={schema:'stroq-task-locks/1',workspaceId:options.workspaceId,host:'claude-code',checkedAt:options.now,currentPolicySha256:row.policySha256,available:true,reason:null,coverage:{complete:false,limited:true,unverified:0,foreign:64},tasks:offset===64?[row]:[],limitations:${JSON.stringify(schema.TASK_LOCK_LIMITATIONS)}};
 parentPort.postMessage({type:'result',result:operation==='state'?state:{state,listing:{sha256:control.sha256,offset,total:control.total,limited:control.limited}}});}}
`,
  );
  const make = () =>
    createTaskLockService({
      project,
      userHome,
      home,
      workerPath,
      available: async () => ({ available: true, version: '0.28.0' }),
      runtimeDigest: async () => runtime,
      now: () => clock,
      loadValidator: async () => schema,
      ...extra,
    });
  const service = await make();
  const services = [service],
    apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const value of services) await value.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    project,
    userHome,
    home,
    service,
    settings,
    save,
    advance(ms) {
      clock += ms;
    },
    setRuntime(value) {
      runtime = value;
    },
    async restart() {
      await service.close();
      const value = await make();
      services.push(value);
      return value;
    },
    async http() {
      const root = join(base, 'out');
      await mkdir(root);
      await writeFile(join(root, 'index.html'), 'fixture');
      const app = await startServer({ project, userHome, home, root, taskLocks: service, port: 0 });
      apps.push(app);
      const origin = app.url.split('/#')[0];
      const request = async (path, body, headers = {}, method) => {
        const response = await fetch(origin + path, {
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
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      return { request, origin };
    },
  };
}

test('real worker service first/next/exact reads are schema-valid and never create the private home', async (t) => {
  const f = await fixture(t);
  const first = await f.service.getPage();
  assert.equal(schema.validateTaskLockPage(first), true);
  assert.deepEqual(first.state.tasks, []);
  const next = await f.service.page({ cursor: first.page.nextCursor });
  assert.equal(next.status, 200);
  assert.equal(next.body.page.index, 2);
  assert.equal(next.body.state.tasks[0].id, id);
  for (const expectedPermit of [null, permitSha256]) {
    const exact = await f.service.page({ id, expectedPermitSha256: expectedPermit });
    assert.equal(exact.status, 200);
    assert.equal(exact.body.page.index, 2);
    assert.equal(schema.validateTaskLockPage(exact.body), true);
  }
  assert.equal((await f.service.page({ id, expectedPermitSha256: 'f'.repeat(64) })).status, 409);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  assert.equal(JSON.stringify(next).includes('listing'), false);
  assert.equal(JSON.stringify(next).includes(f.base), false);
  assert.equal((await f.service.getState()).schema, 'stroq-task-locks/1');
});

test('stale listing/runtime/root, expired cursors and restart retain distinct refusal semantics', async (t) => {
  const f = await fixture(t);
  const cursor = (await f.service.getPage()).page.nextCursor;
  f.settings.sha256 = 'f'.repeat(64);
  await f.save();
  assert.deepEqual(await f.service.page({ cursor }), {
    status: 409,
    body: { error: 'task-page-stale' },
  });
  const fresh = (await f.service.getPage()).page.nextCursor;
  f.advance(300_000);
  assert.deepEqual(await f.service.page({ cursor: fresh }), {
    status: 409,
    body: { error: 'task-page-expired' },
  });
  const runtimeCursor = (await f.service.getPage()).page.nextCursor;
  f.setRuntime('b'.repeat(64));
  assert.equal((await f.service.page({ cursor: runtimeCursor })).body.error, 'task-page-stale');
  const rootCursor = (await f.service.getPage()).page.nextCursor;
  await chmod(f.project, 0o750);
  assert.equal((await f.service.page({ cursor: rootCursor })).body.error, 'task-page-stale');
  await chmod(f.project, 0o700);
  const restarted = await f.restart();
  assert.equal((await restarted.page({ cursor: runtimeCursor })).body.error, 'task-page-stale');
  assert.equal((await restarted.page({ id, expectedPermitSha256: null })).status, 200);
});

test('bounded catalog omission is never reported as proven exact absence', async (t) => {
  const f = await fixture(t),
    missing = `task-${'f'.repeat(64)}`;
  assert.deepEqual(await f.service.page({ id: missing, expectedPermitSha256: null }), {
    status: 404,
    body: { error: 'task-unavailable' },
  });
  f.settings.limited = true;
  await f.save();
  assert.deepEqual(await f.service.page({ id: missing, expectedPermitSha256: null }), {
    status: 422,
    body: { error: 'task-lookup-limit' },
  });
});

test('deadline and close terminate readonly page workers; no late activity or write is accepted', async (t) => {
  const f = await fixture(t, { timeoutMs: 100 });
  f.settings.hold = true;
  await f.save();
  await assert.rejects(f.service.getPage(), { message: 'deadline-exceeded' });
  const pending = f.service.getPage();
  await delay(25);
  await f.service.close();
  await assert.rejects(pending, { message: 'server-stopped' });
  await delay(550);
  await assert.rejects(lstat(join(f.base, 'late')), { code: 'ENOENT' });
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});

test('actual authenticated page HTTP refuses browser selectors, duplicate keys, unsupported methods and foreign origins', async (t) => {
  const f = await fixture(t),
    { request } = await f.http();
  const first = await request('/api/task-locks/page');
  assert.equal(first.status, 200);
  assert.equal(schema.validateTaskLockPage(first.body), true);
  assert.equal(
    (await request('/api/task-locks/page', { cursor: first.body.page.nextCursor })).body.page.index,
    2,
  );
  assert.equal(
    (await request('/api/task-locks/page', { id, expectedPermitSha256: null })).body.state.tasks[0]
      .id,
    id,
  );
  assert.equal(
    (await request('/api/task-locks/page', undefined, { Authorization: '' })).status,
    401,
  );
  assert.equal(
    (
      await request(
        '/api/task-locks/page',
        { id, expectedPermitSha256: null },
        { Origin: 'https://foreign.invalid' },
      )
    ).status,
    403,
  );
  assert.equal((await request('/api/task-locks/page?offset=64')).status, 400);
  assert.equal((await request('/api/task-locks/page', undefined, {}, 'DELETE')).status, 405);
  for (const input of [
    {},
    { offset: 64 },
    { id },
    { id, expectedPermitSha256: null, nativeTaskId: 'PRIVATE-NATIVE' },
    `{"id":"${id}","i\\u0064":"${id}","expectedPermitSha256":null}`,
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  ])
    assert.equal((await request('/api/task-locks/page', input)).status, 400);
  assert.equal(
    (await request('/api/task-locks/page', { cursor: '11111111-1111-4111-8111-111111111111' })).body
      .error,
    'task-page-stale',
  );
  assert.equal((await request('/api/task-locks/page', 'x'.repeat(4097))).status, 413);
  assert.equal(
    (
      await request(
        '/api/task-locks/page',
        { id, expectedPermitSha256: null },
        { 'Content-Type': 'text/plain' },
      )
    ).status,
    415,
  );
});
