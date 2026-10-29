import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, rename, mkdir, chmod, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  fixture,
  context,
  schemaURL,
  runningJob,
} from './codex-network-check-ownership-fixtures.mjs';

const state = async (service) => {
  const response = await service.read();
  assert.equal(response.status, 200);
  assert.equal(response.body.schema, 'stroq-codex-network-checks/2');
  return response.body;
};
async function cannotAcquire(f) {
  const lease = await f.acquire();
  if (lease) await lease.release();
  assert.equal(lease, null);
}
test(
  'two real-store controllers preserve foreign running jobs and lease ownership through cleanup/persist',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.controller({ wait: true, terminalGate: true }),
      pa = await a.preview();
    const started = await a.start(pa);
    assert.equal(started.status, 200);
    await a.ready.promise;
    const before = await readFile(f.history),
      b = await f.controller();
    assert.deepEqual(await readFile(f.history), before);
    assert.equal((await state(a.service)).ownedJobId, pa.jobId);
    let observed = await state(b.service);
    assert.equal(observed.activeJobId, pa.jobId);
    assert.equal(observed.ownedJobId, null);
    assert.equal(observed.jobs[0].status, 'running');
    assert.deepEqual(await readFile(f.history), before);
    const pb = await b.preview(),
      busy = await b.start(pb);
    assert.equal(busy.body.error, 'codex-network-check-busy');
    assert.equal((await b.start(pb)).body.error, 'codex-network-check-stale');
    assert.equal(b.starts(), 0);
    assert.deepEqual(await readFile(f.history), before);
    const cancel = await b.service.cancel({
      jobId: pa.jobId,
      operationId: pa.operationId,
      controlContextId: context,
    });
    assert.equal(cancel.body.error, 'codex-network-check-busy');
    assert.equal(a.signal().aborted, false);
    a.beginCleanup.resolve();
    await a.cleaning.promise;
    await cannotAcquire(f);
    observed = await state(b.service);
    assert.equal(observed.jobs[0].status, 'running');
    assert.equal(observed.ownedJobId, null);
    a.finishCleanup.resolve();
    await a.publishing.promise;
    await cannotAcquire(f);
    assert.deepEqual(await readFile(f.history), before);
    a.finishPublish.resolve();
    await a.service.wait();
    observed = await state(b.service);
    assert.equal(observed.jobs.length, 1);
    assert.equal(observed.jobs[0].status, 'completed');
    assert.equal(observed.jobs[0].result.outcome, 'passed');
    assert.equal(observed.activeJobId, null);
    assert.equal(observed.ownedJobId, null);
    const completed = await readFile(f.history);
    assert.deepEqual(await readFile(f.history), completed);
    const free = await f.acquire();
    assert.ok(free);
    await free.assertCurrent();
    await free.release();
    assert.deepEqual(await readFile(f.history), completed);
  },
);

test(
  'only explicit admission recovers a dead real lease and retained running attempt',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      observer = await f.controller(),
      old = runningJob(),
      jobFile = join(f.base, 'owned-dead-job.json');
    await writeFile(jobFile, JSON.stringify(old), { mode: 0o600 });
    const leaseURL = pathToFileURL(join(import.meta.dirname, 'workspace-monitor-lease.mjs')).href,
      storeURL = pathToFileURL(join(import.meta.dirname, 'run-store.mjs')).href;
    const program = `const [home,storeId,leaseId,schemaURL,jobFile,leaseURL,storeURL]=process.argv.slice(1);const {readFile}=await import('node:fs/promises');const {createRunStore}=await import(storeURL);const {acquireWorkspaceMonitorLease}=await import(leaseURL);const schema=await import(schemaURL);const job=JSON.parse(await readFile(jobFile,'utf8'));const store=await createRunStore({home,workspaceId:storeId,namespace:'codex-network-checks',loadValidator:async()=>({validateRun:j=>schema.validateCodexNetworkCheckJob(j)&&j.binding.workspaceId===job.binding.workspaceId})});if(!await store.prepare())throw Error('prepare');const lease=await acquireWorkspaceMonitorLease({home,storeId:leaseId});if(!lease||!await store.write([job]))throw Error('admission');process.send({ready:true,pid:process.pid});setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        program,
        f.home,
        f.storeId,
        f.leaseId,
        schemaURL,
        jobFile,
        leaseURL,
        storeURL,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/bin:/bin' } },
    );
    f.children.push(child);
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'error').then(([error]) => {
        throw error;
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('child-admission-timeout')), 5000).unref(),
      ),
    ]);
    assert.deepEqual(ready, { ready: true, pid: child.pid });
    const bytes = await readFile(f.history);
    assert.equal((await state(observer.service)).jobs[0].status, 'running');
    assert.deepEqual(await readFile(f.history), bytes);
    const blocked = await observer.preview();
    assert.equal((await observer.start(blocked)).body.error, 'codex-network-check-busy');
    assert.equal((await observer.start(blocked)).body.error, 'codex-network-check-stale');
    assert.equal(observer.starts(), 0);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const stale = new Date(Date.now() - 11000);
    await utimes(f.leasePath, stale, stale);
    assert.equal((await state(observer.service)).jobs[0].status, 'running');
    assert.deepEqual(await readFile(f.history), bytes);
    const deadOwner = JSON.parse(await readFile(join(f.leasePath, 'owner.json'), 'utf8'));
    assert.equal(deadOwner.pid, child.pid);
    const next = await observer.preview(),
      admitted = await observer.start(next);
    assert.equal(admitted.status, 200);
    await observer.service.wait();
    const after = await state(observer.service),
      prior = after.jobs.find((job) => job.id === old.id),
      current = after.jobs.find((job) => job.id === next.jobId);
    assert.equal(after.jobs.length, 2);
    assert.equal(prior.status, 'failed');
    assert.equal(prior.error, 'codex-network-check-server-stopped');
    assert.equal(prior.result, null);
    assert.equal(current.status, 'completed');
    assert.equal(current.result.outcome, 'passed');
    assert.equal(observer.starts(), 1);
    assert.equal(after.ownedJobId, null);
  },
);

test(
  'valid foreign history change during ownership is preserved and cannot become a terminal proof',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.controller({ wait: true }),
      p = await a.preview();
    await a.start(p);
    await a.ready.promise;
    const changed = JSON.parse(await readFile(f.history, 'utf8'));
    changed.runs[0].progress = 'native';
    const foreign = Buffer.from(JSON.stringify(changed) + '\n');
    await writeFile(f.history, foreign, { mode: 0o600 });
    const unavailable = await state(a.service);
    assert.equal(unavailable.history, 'unavailable');
    assert.equal(unavailable.ownedJobId, null);
    assert.equal(a.signal().aborted, true);
    a.beginCleanup.resolve();
    a.finishCleanup.resolve();
    await a.service.wait();
    assert.deepEqual(await readFile(f.history), foreign);
    const after = await state(a.service);
    assert.equal(after.history, 'unavailable');
    assert.equal(after.jobs[0].result, null);
    assert.equal(after.jobs[0].status, 'failed');
  },
);

test(
  'replacement history parent cannot be adopted by a live owner or overwritten during cleanup',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.controller({ wait: true }),
      p = await a.preview();
    await a.start(p);
    await a.ready.promise;
    const consolePath = join(f.home, 'console'),
      before = await readFile(f.history);
    await rename(consolePath, consolePath + '-original');
    await mkdir(consolePath, { mode: 0o700 });
    await writeFile(f.history, before, { mode: 0o600 });
    const unavailable = await state(a.service);
    assert.equal(unavailable.history, 'unavailable');
    assert.equal(a.signal().aborted, true);
    a.beginCleanup.resolve();
    a.finishCleanup.resolve();
    await a.service.wait();
    assert.deepEqual(await readFile(f.history), before);
    assert.deepEqual(
      await readFile(join(consolePath + '-original', `codex-network-checks-${f.storeId}.json`)),
      before,
    );
  },
);

test(
  'replaced lease owner and unsafe parent refuse publication without deleting foreign evidence',
  { timeout: 15000 },
  async (t) => {
    await t.test('lease owner', async (t) => {
      const f = await fixture(t),
        a = await f.controller({ wait: true }),
        p = await a.preview();
      await a.start(p);
      await a.ready.promise;
      const ownerPath = join(f.leasePath, 'owner.json'),
        before = await readFile(f.history),
        owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      owner.token = '11111111-1111-4111-8111-111111111111';
      const foreign = Buffer.from(JSON.stringify(owner));
      await writeFile(ownerPath, foreign, { mode: 0o600 });
      assert.equal((await state(a.service)).history, 'unavailable');
      a.beginCleanup.resolve();
      a.finishCleanup.resolve();
      await a.service.wait();
      assert.deepEqual(await readFile(f.history), before);
      assert.deepEqual(await readFile(ownerPath), foreign);
    });
    await t.test('unsafe parent', async (t) => {
      const f = await fixture(t),
        a = await f.controller({ wait: true }),
        p = await a.preview();
      await a.start(p);
      await a.ready.promise;
      const before = await readFile(f.history);
      await chmod(join(f.home, 'console'), 0o777);
      assert.equal((await state(a.service)).history, 'unavailable');
      a.beginCleanup.resolve();
      a.finishCleanup.resolve();
      await a.service.wait();
      assert.deepEqual(await readFile(f.history), before);
      await chmod(join(f.home, 'console'), 0o700);
    });
  },
);
