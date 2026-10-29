import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'tsup';
import { createTaskLockService } from './task-lock-service.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-service-build-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'schema.ts'),
  `export * from '${repo}/console/lib/task-locks.ts'; export * from '${repo}/console/lib/incident-task.ts';`,
);
await build({
  entry: { schema: join(output, 'schema.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const sha = (v) => createHash('sha256').update(v).digest('hex');
const row = {
  id: `task-${'b'.repeat(64)}`,
  permitSha256: 'c'.repeat(64),
  profile: 'repo-edit-and-test',
  policySha256: 'd'.repeat(64),
  issuedAt: '2026-10-23T11:50:00.000Z',
  expiresAt: '2026-10-23T12:30:00.000Z',
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
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-service-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  let clock = Date.parse('2026-10-23T12:00:00.000Z'),
    runtime = 'a'.repeat(64),
    calls = [];
  const workerPath = join(base, 'worker.mjs');
  await writeFile(
    workerPath,
    `import {parentPort,workerData} from 'node:worker_threads';
const {operation,input,options}=workerData;
const row=${JSON.stringify(row)};
const checkedAt=options.now;
if(operation==='incident') {
 if(options.configurationLockHeld || Object.keys(input).sort().join(',')!=='expectedEvidenceSha,id,recordedAt,sequence')throw Error('PRIVATE_INPUT_LEAK');
 const task={...row,evidence:{status:'verified',journalSha256:'a'.repeat(64),counts:{calls:0,allowed:0,denied:0,asks:0,hostReported:0,hostFailure:0,unconfirmed:0},lastGate:null}};
 parentPort.postMessage({type:'result',result:{schema:'stroq-incident-task/1',workspaceId:options.workspaceId,incident:{id:input.id,evidenceSha256:input.expectedEvidenceSha,sequence:input.sequence,recordedAt:input.recordedAt},checkedAt,currentPolicySha256:row.policySha256,status:'matched',journal:{status:'verified',sha256:'a'.repeat(64)},relation:'task-id-only',historicalPermitRelation:'not-recorded',sessionRelation:'matches',task,limitations:${JSON.stringify(schema.INCIDENT_TASK_LIMITATIONS)}}});
}
if(operation==='state') parentPort.postMessage({type:'result',result:{schema:'stroq-task-locks/1',workspaceId:options.workspaceId,host:'claude-code',checkedAt,currentPolicySha256:row.policySha256,available:true,reason:null,coverage:{complete:true,limited:false,unverified:0,foreign:0},tasks:[row],limitations:${JSON.stringify(schema.TASK_LOCK_LIMITATIONS)}}});
if(operation==='preview') parentPort.postMessage({type:'result',result:{task:row,plan:{version:1,workspaceId:options.workspaceId,runtimeSha256:options.runtimeSha256,private:'PRIVATE-SENTINEL'},bindingSha256:'e'.repeat(64),canApply:true,reason:null}});
if(operation==='apply') {
 if(!options.configurationLockHeld) throw Error('missing-lock');
 parentPort.postMessage({type:'result',result:{schema:'stroq-task-lock-receipt/1',id:input.receiptId,previewId:input.previewId,workspaceId:options.workspaceId,taskId:row.id,permitSha256:row.permitSha256,status:'revoked',checkedAt,markerSha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',storeReadback:'revoked',gateDecision:'deny',gateRule:'task-void:revoked',evidence:'isolated-gate-evaluation',hostTermination:'unverified',irreversible:true}});
}
`,
  );
  const service = await createTaskLockService({
    project,
    userHome,
    home,
    workerPath,
    platform: 'darwin',
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => runtime,
    loadValidator: async () => schema,
    now: () => clock,
    withLock: async (context, action) => {
      calls.push(context);
      return action();
    },
    ...extra,
  });
  t.after(() => service.close());
  const preview = () => service.preview({ id: row.id, expectedPermitSha256: row.permitSha256 });
  return {
    service,
    project,
    userHome,
    home,
    workerPath,
    base,
    calls,
    preview,
    setRuntime(v) {
      runtime = v;
    },
    advance(ms) {
      clock += ms;
    },
  };
}

test('state and preview are read-only projections; missing consent never consumes an exact private plan', async (t) => {
  const f = await fixture(t);
  assert.equal(schema.validateTaskLockState(await f.service.getState()), true);
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(schema.validateTaskLockPreview(preview.body), true);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(preview).includes('PRIVATE-SENTINEL'), false);
  for (const input of [
    { previewId: preview.body.id },
    { previewId: preview.body.id, acknowledgeTaskInterruption: false },
    { previewId: preview.body.id, acknowledgeTaskInterruption: true, command: 'PRIVATE-SENTINEL' },
  ])
    assert.equal((await f.service.apply(input)).status, 400);
  const applied = await f.service.apply({
    previewId: preview.body.id,
    acknowledgeTaskInterruption: true,
  });
  assert.equal(applied.status, 200);
  assert.equal(schema.validateTaskLockReceipt(applied.body), true);
  assert.equal(applied.body.previewId, preview.body.id);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.service.apply({ previewId: preview.body.id, acknowledgeTaskInterruption: true }))
      .status,
    409,
  );
});

test('runtime and canonical root drift invalidate plans before the mutation worker runs', async (t) => {
  const f = await fixture(t);
  const preview = await f.preview();
  f.setRuntime('f'.repeat(64));
  assert.deepEqual(
    await f.service.apply({ previewId: preview.body.id, acknowledgeTaskInterruption: true }),
    { status: 409, body: { error: 'preview-stale' } },
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const second = await f.preview();
  await (await import('node:fs/promises')).chmod(f.project, 0o750);
  assert.equal(
    (await f.service.apply({ previewId: second.body.id, acknowledgeTaskInterruption: true })).body
      .error,
    'preview-stale',
  );
});

test('TTL, single-use and maximum retained preview count are bounded', async (t) => {
  const f = await fixture(t);
  const first = await f.preview();
  for (let i = 0; i < 8; i++) assert.equal((await f.preview()).status, 200);
  assert.equal(
    (await f.service.apply({ previewId: first.body.id, acknowledgeTaskInterruption: true })).body
      .error,
    'preview-stale',
  );
  const last = await f.preview();
  f.advance(120_001);
  assert.equal(
    (await f.service.apply({ previewId: last.body.id, acknowledgeTaskInterruption: true })).body
      .error,
    'preview-expired',
  );
});

test('unsupported and invalid worker projections fail closed without source or lock writes', async (t) => {
  const f = await fixture(t, { platform: 'win32' });
  const state = await f.service.getState();
  assert.equal(schema.validateTaskLockState(state), true);
  assert.equal(state.reason, 'platform-unsupported');
  assert.equal((await f.preview()).body.error, 'platform-unsupported');
  assert.equal(f.calls.length, 0);
  const invalid = await fixture(t);
  await writeFile(
    invalid.workerPath,
    "import {parentPort} from 'node:worker_threads'; parentPort.postMessage({type:'result',result:{private:'PRIVATE-SENTINEL'}});",
  );
  assert.equal((await invalid.preview()).body.error, 'invalid-report');
  await assert.rejects(invalid.service.getState(), { message: 'invalid-report' });
});

test('deadline and close terminate the worker before releasing the parent lock', async (t) => {
  let entered,
    released = false;
  const signal = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    timeoutMs: 1500,
    withLock: async (_context, action) => {
      try {
        entered();
        return await action();
      } finally {
        released = true;
      }
    },
  });
  const preview = await f.preview(),
    witness = join(f.base, 'late-write'),
    heartbeat = join(f.base, 'heartbeat');
  await writeFile(
    f.workerPath,
    `import {workerData} from 'node:worker_threads'; import {writeFileSync} from 'node:fs'; if(workerData.operation==='apply') {writeFileSync(${JSON.stringify(heartbeat)},'ready');setTimeout(()=>writeFileSync(${JSON.stringify(witness)},'late'),3500); setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);}`,
  );
  const applying = f.service.apply({
    previewId: preview.body.id,
    acknowledgeTaskInterruption: true,
  });
  await signal;
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(heartbeat);
      break;
    } catch {
      await delay(10);
    }
  }
  await readFile(heartbeat);
  assert.equal(released, false);
  assert.equal((await f.preview()).body.error, 'task-lock-busy');
  await f.service.close();
  const result = await applying;
  assert.equal(result.body.error, 'write-unconfirmed');
  assert.equal(released, true);
  await assert.rejects(lstat(witness), { code: 'ENOENT' });
  const stopped = await readFile(heartbeat, 'utf8');
  await delay(80);
  assert.equal(await readFile(heartbeat, 'utf8'), stopped);
});

test('aggregate private preview bytes evict older plans before eight entries, without publishing raw plan data', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.workerPath, 'utf8');
  await writeFile(
    f.workerPath,
    original.replace(
      "private:'PRIVATE-SENTINEL'",
      "private:'PRIVATE-SENTINEL',bytes:Buffer.alloc(1536*1024)",
    ),
  );
  const first = await f.preview();
  assert.equal(first.status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await f.preview()).status, 200);
  assert.equal(
    (await f.service.apply({ previewId: first.body.id, acknowledgeTaskInterruption: true })).body
      .error,
    'preview-stale',
  );
  const latest = await f.preview();
  assert.equal(JSON.stringify(latest).includes('PRIVATE-SENTINEL'), false);
  assert.equal(JSON.stringify(latest).includes('bytes'), false);
  assert.equal(
    (await f.service.apply({ previewId: latest.body.id, acknowledgeTaskInterruption: true }))
      .status,
    200,
  );
});

test('worker has an empty environment and no inherited Node loader options', async (t) => {
  const f = await fixture(t),
    witness = join(f.base, 'loader-witness'),
    poison = join(f.base, 'poison.cjs');
  await writeFile(poison, `require('node:fs').writeFileSync(${JSON.stringify(witness)},'loaded');`);
  const original = await readFile(f.workerPath, 'utf8');
  await writeFile(
    f.workerPath,
    "if(Object.keys(process.env).length!==0||process.execArgv.length!==0)throw Error('PRIVATE_ENVIRONMENT');\n" +
      original,
  );
  const prior = Object.fromEntries(
    ['NODE_OPTIONS', 'STROQ_HOME', 'PRIVATE_TASK_SECRET'].map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_OPTIONS = `--require=${poison}`;
    process.env.STROQ_HOME = join(f.base, 'foreign-profile');
    process.env.PRIVATE_TASK_SECRET = 'PRIVATE_SECRET_SENTINEL';
    assert.equal((await f.preview()).status, 200);
    await assert.rejects(lstat(witness), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('incident association rejects browser metadata, paths and mismatched IDs before selection or worker work', async (t) => {
  let selected = 0;
  const f = await fixture(t, {
    selectEvidence: async () => {
      selected++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  const evidence = 'f'.repeat(64),
    valid = { id: `incident-${evidence}`, expectedEvidenceSha: evidence };
  for (const input of [
    null,
    {},
    { ...valid, id: 'incident-' + 'e'.repeat(64) },
    { ...valid, taskId: row.id },
    { ...valid, sequence: 1 },
    { ...valid, path: '/PRIVATE_SENTINEL' },
    { ...valid, expectedEvidenceSha: 42 },
  ])
    assert.deepEqual(await f.service.relateIncident(input), {
      status: 400,
      body: { error: 'invalid-request' },
    });
  assert.equal(selected, 0);
  assert.equal(f.calls.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});

test('incident association passes only exact metadata to worker and reselects the visible source without changing plans', async (t) => {
  let selected = 0;
  const f = await fixture(t, {
    selectEvidence: async () => {
      selected++;
      return {
        seq: 1,
        ts: '2026-10-23T11:59:00.000Z',
        taskId: 'PRIVATE_ID',
        summary: 'PRIVATE_COMMAND',
        nonce: 'PRIVATE_NONCE',
      };
    },
  });
  const sha = 'f'.repeat(64),
    request = { id: `incident-${sha}`, expectedEvidenceSha: sha };
  const preview = await f.preview();
  const result = await f.service.relateIncident(request);
  assert.equal(result.status, 200);
  assert.equal(schema.validateIncidentTaskReport(result.body), true);
  assert.equal(selected, 2);
  assert.equal(f.calls.length, 0);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  for (const raw of ['PRIVATE_ID', 'PRIVATE_COMMAND', 'PRIVATE_NONCE'])
    assert.equal(JSON.stringify(result).includes(raw), false);
  assert.equal(
    (await f.service.apply({ previewId: preview.body.id, acknowledgeTaskInterruption: true }))
      .status,
    200,
  );
});

test('late selector changes, malformed report origin and fixed selector failures cannot publish a task relation', async (t) => {
  const sha = 'f'.repeat(64),
    request = { id: `incident-${sha}`, expectedEvidenceSha: sha };
  let count = 0;
  const changed = await fixture(t, {
    selectEvidence: async () => ({ seq: ++count, ts: '2026-10-23T11:59:00.000Z' }),
  });
  assert.deepEqual(await changed.service.relateIncident(request), {
    status: 409,
    body: { error: 'stale-evidence' },
  });
  const invalid = await fixture(t, {
    selectEvidence: async () => ({ seq: 1, ts: '2026-10-23T11:59:00.000Z' }),
  });
  const source = await readFile(invalid.workerPath, 'utf8');
  await writeFile(
    invalid.workerPath,
    source.replace('evidenceSha256:input.expectedEvidenceSha', "evidenceSha256:'0'.repeat(64)"),
  );
  assert.equal((await invalid.service.relateIncident(request)).body.error, 'invalid-report');
  const stale = await fixture(t, {
    selectEvidence: async () => {
      throw Error('stale-evidence');
    },
  });
  assert.deepEqual(await stale.service.relateIncident(request), {
    status: 409,
    body: { error: 'stale-evidence' },
  });
  const secret = await fixture(t, {
    selectEvidence: async () => {
      throw Error('PRIVATE_PATH/COMMAND');
    },
  });
  assert.deepEqual(await secret.service.relateIncident(request), {
    status: 503,
    body: { error: 'task-lock-failed' },
  });
  for (const f of [changed, invalid, stale, secret]) {
    assert.equal(f.calls.length, 0);
    await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  }
});
