import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { prepareCodexSkillApplyLock } from './mcp-containment-files.mjs';

const repository = join(import.meta.dirname, '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-control-main-')));
after(() => rm(output, { recursive: true, force: true }));
const hash = 'a'.repeat(64),
  context = 'codex-context-' + 'b'.repeat(64);
await writeFile(
  join(output, 'schema.ts'),
  `export * from ${JSON.stringify(join(repository, 'console/lib/codex-skill-controls.ts'))}; export * from ${JSON.stringify(join(repository, 'console/lib/codex-skill-controls-private.ts'))};`,
);
await build({
  entry: {
    'inventory-schema': join(output, 'schema.ts'),
    core: join(repository, 'packages/core/src/util/lock.ts'),
  },
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
const schema = await import(pathToFileURL(join(output, 'inventory-schema.mjs')).href);
await writeFile(join(output, 'runtime-hash'), hash);
await writeFile(
  join(output, 'runtime.mjs'),
  `import {readFile} from 'node:fs/promises'; export const runtimeDigest=async()=>readFile(${JSON.stringify(join(output, 'runtime-hash'))},'utf8');`,
);
await writeFile(
  join(output, 'layout.mjs'),
  `export const runtimeLayout=()=>({repository:${JSON.stringify(output)},core:${JSON.stringify(join(output, 'core.mjs'))},adapter:n=>${JSON.stringify(output)}+'/'+n.replace(/\.js$/,'.mjs')});`,
);
const source = await readFile(join(import.meta.dirname, 'inventory.mjs'), 'utf8');
await writeFile(
  join(output, 'inventory.mjs'),
  'const bridgeNow=()=>globalThis.__stroqCodexControlTestNow??Date.now();\n' +
    source
      .replaceAll('Date.now()', 'bridgeNow()')
      .replaceAll(
        "'./runtime-layout.mjs'",
        JSON.stringify(pathToFileURL(join(output, 'layout.mjs')).href),
      )
      .replaceAll(
        "'./agent-setup-cli.mjs'",
        JSON.stringify(pathToFileURL(join(output, 'runtime.mjs')).href),
      )
      .replaceAll(
        "'./inventory-safe.mjs'",
        JSON.stringify(pathToFileURL(join(import.meta.dirname, 'inventory-safe.mjs')).href),
      )
      .replaceAll(
        "'./mcp-containment-files.mjs'",
        JSON.stringify(pathToFileURL(join(import.meta.dirname, 'mcp-containment-files.mjs')).href),
      ),
);
const { createInventory } = await import(pathToFileURL(join(output, 'inventory.mjs')).href);
const selection = {
  operation: 'disable',
  controlContextId: context,
  sourceId: 'source-' + 'c'.repeat(24),
  candidateId: 'candidate-' + 'd'.repeat(24),
  expectedEntrypointSha256: hash,
  expectedConfigSha256: null,
  expectedRuntimeSha256: hash,
};

function workerPlan(data, config, id) {
  const now = Date.now(),
    root = data.codexExpectedRoots.user,
    projectRoot = data.codexExpectedRoots.project;
  const request = data.request,
    restore = request.operation === 'restore';
  const preview = {
    schema: 'stroq-codex-skill-control-preview/1',
    id,
    operationId: id,
    binding: restore
      ? null
      : {
          controlContextId: request.controlContextId,
          sourceId: request.sourceId,
          candidateId: request.candidateId,
          entrypointSha256: request.expectedEntrypointSha256,
          runtimeSha256: request.expectedRuntimeSha256,
        },
    controlContextId: request.controlContextId,
    operation: request.operation,
    recordId: restore ? request.recordId : id,
    recordRevision: restore ? request.recordRevision : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (config.expired ? -1 : 120000)).toISOString(),
    name: 'fixture',
    location: { label: '.', redacted: false },
    beforeSha256: null,
    afterSha256: hash,
    sameNameCopies: 2,
    sharedUserConfig: true,
    retainsConfigurationCopies: true,
    formattingPreserved: true,
    hostEnforcement: false,
  };
  const pin = {
    dev: 1,
    ino: 2,
    uid: root.uid,
    mode: 0o100600,
    nlink: 1,
    size: 1,
    mtimeMs: 1,
    ctimeMs: 1,
  };
  const snapshot = { bytes: null, sha256: 'absent', mode: 0o600, file: null, directories: [root] };
  const bytes = new Uint8Array(config.big ? 256 * 1024 : 1);
  const plan = {
    schema: 'stroq-codex-skill-control-private-plan/1',
    preview,
    request,
    context: {
      id: request.controlContextId,
      user: root,
      target: root.path + '/.codex/config.toml',
      rootBinding: hash,
    },
    before: snapshot,
    candidate: bytes,
    owned: {
      schema: 'stroq-codex-skill-disable-transform/1',
      operationId: preview.recordId,
      documentPath: projectRoot.path + '/SKILL.md',
      before: config.big ? bytes : null,
      candidate: bytes,
    },
    candidatePin: restore
      ? null
      : {
          root: projectRoot,
          path: projectRoot.path + '/SKILL.md',
          snapshot: {
            bytes,
            sha256: hash,
            mode: 0o600,
            file: { ...pin, size: bytes.length },
            directories: [projectRoot],
          },
        },
  };
  if (config.big) {
    plan.before = { ...snapshot, bytes, sha256: hash, file: { ...pin, size: bytes.length } };
    preview.beforeSha256 = hash;
    request.expectedConfigSha256 = hash;
  }
  return { preview, privatePlan: plan };
}
function workerReceipt(data) {
  const p = data.privatePlan?.preview,
    request = data.request,
    at = new Date().toISOString(),
    id = p?.recordId ?? request.recordId,
    operationId = p?.id ?? request.operationId;
  const operation = p?.operation ?? 'recheck';
  return {
    schema: 'stroq-codex-skill-control-receipt/1',
    operationId,
    controlContextId: p?.controlContextId ?? request.controlContextId,
    operation,
    checkedAt: at,
    writeConfirmed: operation !== 'recheck',
    record: {
      id,
      operationId,
      revision: hash,
      controlContextId: p?.controlContextId ?? request.controlContextId,
      createdAt: at,
      updatedAt: at,
      name: 'fixture',
      location: { label: '.', redacted: false },
      operationStatus: operation === 'restore' ? 'restored' : 'disabled',
      standing: 'disabled',
      originalSha256: null,
      candidateSha256: hash,
      canRestore: operation !== 'restore',
      sharedUserConfig: true,
      hostEnforcement: false,
    },
  };
}
async function fixture(t, config = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-codex-control-bridge-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(base, 'arbitrary-stroq-home');
  await mkdir(project);
  await mkdir(userHome);
  const workerPath = join(base, 'worker.mjs');
  await writeFile(join(project, 'config.json'), JSON.stringify(config));
  await writeFile(
    workerPath,
    `import {parentPort,workerData} from 'node:worker_threads';import {randomUUID} from 'node:crypto';import {readFile,writeFile,appendFile,mkdir,rename} from 'node:fs/promises';const data={...workerData,...workerData.controlData};const hash=${JSON.stringify(hash)};const workerPlan=${workerPlan.toString()};const workerReceipt=${workerReceipt.toString()};const config=JSON.parse(await readFile(data.project+'/config.json','utf8'));await appendFile(data.project+'/operations',data.operation+'\\n');if(config.error)parentPort.postMessage({error:config.error,secret:'PRIVATE_SENTINEL'});else if(config.invalid)parentPort.postMessage({secret:'PRIVATE_SENTINEL'});else if(data.operation==='codex-control-state')parentPort.postMessage({schema:'stroq-codex-skill-controls/1',controlContextId:${JSON.stringify(context)},generatedAt:new Date().toISOString(),available:true,history:'missing',records:[],error:null});else if(data.operation==='codex-control-preview'){const p=workerPlan(data,config,randomUUID());if(config.mismatch)p.preview={...p.preview,name:'different'};if(config.leak)p.preview.path='PRIVATE_SENTINEL';parentPort.postMessage(p);}else{await writeFile(data.project+'/entered',JSON.stringify({operation:data.operation,lock:data.writerLockHeld,shared:data.acknowledgeSharedUserConfig,retention:data.acknowledgeRetention,weakening:data.acknowledgeWeakening,private:data.privatePlan?.owned?.documentPath}));if(config.slow){setTimeout(()=>writeFile(data.project+'/escaped','bad'),350);await new Promise(()=>setInterval(()=>{},1000));}else parentPort.postMessage(workerReceipt(data));}`,
  );
  const inventory = createInventory({
    project,
    userHome,
    home,
    workerPath,
    timeoutMs: config.timeoutMs ?? 3000,
  });
  t.after(async () => {
    await inventory.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    project,
    userHome,
    home,
    inventory,
    workerPath,
    async configure(value) {
      await writeFile(join(project, 'config.json'), JSON.stringify(value));
    },
  };
}
const applyBody = (p) => ({
  previewId: p.id,
  controlContextId: p.controlContextId,
  acknowledgeSharedUserConfig: true,
  acknowledgeRetention: true,
  ...(p.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
});

test('fixed Codex state is read-only, strict, and public preview omits private data', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.inventory.codexControlState, 'function');
  for (const v of [null, [], { path: '/' }, { operation: 'codex-control-apply' }])
    assert.equal((await f.inventory.codexControlState(v)).status, 400);
  const state = await f.inventory.codexControlState({});
  assert.equal(state.status, 200);
  assert.equal(schema.validateCodexSkillControlState(state.body), true);
  await assert.rejects(access(join(f.userHome, '.stroq')));
  const p = await f.inventory.codexControlPreview(selection);
  assert.equal(p.status, 200);
  assert.equal(schema.validateCodexSkillControlPreview(p.body), true);
  const text = JSON.stringify(p);
  assert.ok(!text.includes(f.base));
  assert.ok(!text.includes('privatePlan'));
  assert.ok(!text.includes('owned'));
  await assert.rejects(access(join(f.userHome, '.stroq')));
  const applied = await f.inventory.codexControlApply(applyBody(p.body));
  assert.equal(applied.status, 200);
  assert.equal(schema.validateCodexSkillControlReceipt(applied.body), true);
  const entered = JSON.parse(await readFile(join(f.project, 'entered'), 'utf8'));
  assert.equal(entered.lock, true);
  assert.equal(entered.shared, true);
  assert.equal(entered.retention, true);
  await assert.rejects(access(f.home));
  await assert.rejects(access(join(f.userHome, '.stroq', '.codex-skill-controls.apply.lock')));
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p.body))).body.error,
    'codex-control-stale',
  );
});
test('recognized previews burn before consent, context, shape, busy, expiration or runtime checks', async (t) => {
  const f = await fixture(t);
  for (const change of [
    (p) => ({ ...applyBody(p), extra: 1 }),
    (p) => ({ ...applyBody(p), acknowledgeRetention: false }),
    (p) => ({ ...applyBody(p), controlContextId: 'codex-context-' + 'e'.repeat(64) }),
    (p) => ({ ...applyBody(p), acknowledgeWeakening: true }),
  ]) {
    const p = (await f.inventory.codexControlPreview(selection)).body;
    assert.equal((await f.inventory.codexControlApply(change(p))).status, 400);
    assert.equal(
      (await f.inventory.codexControlApply(applyBody(p))).body.error,
      'codex-control-stale',
    );
  }
  const p = (await f.inventory.codexControlPreview(selection)).body;
  await writeFile(join(output, 'runtime-hash'), 'f'.repeat(64));
  try {
    assert.equal(
      (await f.inventory.codexControlApply(applyBody(p))).body.error,
      'codex-control-runtime-changed',
    );
  } finally {
    await writeFile(join(output, 'runtime-hash'), hash);
  }
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-stale',
  );
});
test('restore requires weakening consent and recheck is explicit metadata-only fixed operation', async (t) => {
  const f = await fixture(t),
    request = {
      operation: 'restore',
      controlContextId: context,
      recordId: '00000000-0000-4000-8000-000000000001',
      recordRevision: hash,
    };
  let p = (await f.inventory.codexControlPreview(request)).body;
  const wrong = applyBody(p);
  delete wrong.acknowledgeWeakening;
  assert.equal((await f.inventory.codexControlApply(wrong)).status, 400);
  p = (await f.inventory.codexControlPreview(request)).body;
  assert.equal((await f.inventory.codexControlApply(applyBody(p))).body.operation, 'restore');
  const recheck = {
    controlContextId: context,
    recordId: request.recordId,
    recordRevision: hash,
    operationId: p.id,
  };
  assert.equal((await f.inventory.codexControlRecheck({ ...recheck, path: '/' })).status, 400);
  assert.equal((await f.inventory.codexControlRecheck(recheck)).body.operation, 'recheck');
  const operations = await readFile(join(f.project, 'operations'), 'utf8');
  assert.equal(operations.includes('codex-sources'), false);
});
test('worker output is closed-schema, bound and error text is finite', async (t) => {
  const f = await fixture(t);
  for (const config of [
    { invalid: true },
    { leak: true },
    { mismatch: true },
    { error: 'PRIVATE_SENTINEL' },
    { expired: true },
  ]) {
    await f.configure(config);
    const r = await f.inventory.codexControlPreview(selection);
    assert.notEqual(r.status, 200);
    assert.equal(JSON.stringify(r).includes('PRIVATE_SENTINEL'), false);
  }
  await f.configure({ error: 'codex-control-conflict' });
  assert.deepEqual(await f.inventory.codexControlPreview(selection), {
    status: 409,
    body: { error: 'codex-control-conflict' },
  });
});
test('private previews have eight-entry and aggregate byte bounds without disk persistence', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++)
    assert.equal((await f.inventory.codexControlPreview(selection)).status, 200);
  assert.equal(
    (await f.inventory.codexControlPreview(selection)).body.error,
    'codex-control-store-full',
  );
  await assert.rejects(access(join(f.userHome, '.stroq')));
  const large = await fixture(t, { big: true });
  const request = { ...selection, expectedConfigSha256: hash };
  let accepted = 0,
    last;
  while (accepted < 8) {
    last = await large.inventory.codexControlPreview(request);
    if (last.status !== 200) break;
    accepted++;
  }
  assert.ok(accepted > 0 && accepted < 8);
  assert.equal(last.body.error, 'codex-control-store-full');
});
test('deadline and close terminate worker before shared USERHOME lock release', async (t) => {
  for (const close of [false, true]) {
    const f = await fixture(t, { slow: true, timeoutMs: close ? 3000 : 180 });
    const p = (await f.inventory.codexControlPreview(selection)).body,
      applying = f.inventory.codexControlApply(applyBody(p));
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      try {
        await access(join(f.project, 'entered'));
        break;
      } catch {
        await delay(5);
      }
    }
    await access(join(f.userHome, '.stroq', '.codex-skill-controls.apply.lock'));
    if (close) await f.inventory.close();
    assert.notEqual((await applying).status, 200);
    await assert.rejects(access(join(f.userHome, '.stroq', '.codex-skill-controls.apply.lock')));
    await delay(400);
    await assert.rejects(access(join(f.project, 'escaped')));
    assert.equal(
      (await f.inventory.codexControlApply(applyBody(p))).body.error,
      'codex-control-stale',
    );
  }
});
test('root replacement after creation refuses fixed state and burns apply', async (t) => {
  const f = await fixture(t);
  const p = (await f.inventory.codexControlPreview(selection)).body;
  await rename(f.userHome, f.userHome + '-original');
  await mkdir(f.userHome);
  assert.equal((await f.inventory.codexControlState({})).body.error, 'codex-control-stale');
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-stale',
  );
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-stale',
  );
  await assert.rejects(access(join(f.userHome, '.stroq')));
});
test('expired and busy recognized previews cannot replay', async (t) => {
  const f = await fixture(t);
  let p = (await f.inventory.codexControlPreview(selection)).body;
  globalThis.__stroqCodexControlTestNow = Date.now() + 121000;
  try {
    assert.equal(
      (await f.inventory.codexControlApply(applyBody(p))).body.error,
      'codex-control-stale',
    );
  } finally {
    delete globalThis.__stroqCodexControlTestNow;
  }
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-stale',
  );
  const first = (await f.inventory.codexControlPreview(selection)).body;
  p = (await f.inventory.codexControlPreview(selection)).body;
  await f.configure({ slow: true });
  const running = f.inventory.codexControlApply(applyBody(first));
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-busy',
  );
  await f.inventory.close();
  await running;
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-stale',
  );
});
test('the same USERHOME lock serializes writers across independent STROQ_HOME values', async (t) => {
  const first = await fixture(t, { slow: true, timeoutMs: 220 }),
    second = await fixture(t);
  const other = createInventory({
    project: second.project,
    userHome: first.userHome,
    home: second.home,
    workerPath: second.workerPath,
    timeoutMs: 3000,
  });
  t.after(() => other.close());
  const p1 = (await first.inventory.codexControlPreview(selection)).body,
    p2 = (await other.codexControlPreview(selection)).body;
  const applying = first.inventory.codexControlApply(applyBody(p1));
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    try {
      await access(join(first.project, 'entered'));
      break;
    } catch {
      await delay(5);
    }
  }
  const waiting = other.codexControlApply(applyBody(p2));
  await delay(40);
  await assert.rejects(access(join(second.project, 'entered')));
  assert.notEqual((await applying).status, 200);
  assert.equal((await waiting).status, 200);
  await assert.rejects(access(join(first.userHome, '.stroq', '.codex-skill-controls.apply.lock')));
});
test('preview selection is bound to the runtime that actually runs', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.inventory.codexControlPreview({ ...selection, expectedRuntimeSha256: 'f'.repeat(64) }))
      .body.error,
    'codex-control-runtime-changed',
  );
});
test('returned receipts are bound to the exact operation', async (t) => {
  const f = await fixture(t);
  const p = (await f.inventory.codexControlPreview(selection)).body;
  const original = await readFile(f.workerPath, 'utf8');
  await writeFile(
    f.workerPath,
    original.replace(
      'else parentPort.postMessage(workerReceipt(data));',
      'else { const receipt=workerReceipt(data);receipt.controlContextId="codex-context-"+"e".repeat(64);receipt.record.controlContextId=receipt.controlContextId;parentPort.postMessage(receipt); }',
    ),
  );
  assert.equal(
    (await f.inventory.codexControlApply(applyBody(p))).body.error,
    'codex-control-unavailable',
  );
});
test('a runtime change while waiting for the shared lock refuses before worker dispatch', async (t) => {
  const f = await fixture(t),
    restore = {
      operation: 'restore',
      controlContextId: context,
      recordId: '00000000-0000-4000-8000-000000000001',
      recordRevision: hash,
    };
  const p = (await f.inventory.codexControlPreview(restore)).body,
    lock = await prepareCodexSkillApplyLock(f.userHome);
  const { withLock } = await import(pathToFileURL(join(output, 'core.mjs')).href);
  let release, entered;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const holding = withLock(
    lock.path,
    async () => {
      entered();
      await gate;
    },
    { fs: lock.fs },
  );
  await ready;
  const applying = f.inventory.codexControlApply(applyBody(p));
  await delay(30);
  await writeFile(join(output, 'runtime-hash'), 'f'.repeat(64));
  release();
  await holding;
  try {
    assert.equal((await applying).body.error, 'codex-control-runtime-changed');
    await assert.rejects(access(join(f.project, 'entered')));
  } finally {
    await writeFile(join(output, 'runtime-hash'), hash);
  }
});
test('post-worker checks reject replaced roots and changed runtime without returning capture', async (t) => {
  for (const target of ['project', 'userHome']) {
    const f = await fixture(t),
      original = await readFile(f.workerPath, 'utf8');
    await writeFile(
      f.workerPath,
      original.replace(
        'if(config.error)',
        `await rename(data.${target},data.${target}+'-original');await mkdir(data.${target});if(config.error)`,
      ),
    );
    assert.equal((await f.inventory.codexControlState({})).body.error, 'codex-control-stale');
  }
  const f = await fixture(t),
    original = await readFile(f.workerPath, 'utf8');
  await writeFile(
    f.workerPath,
    original.replace(
      'if(config.error)',
      `await writeFile(${JSON.stringify(join(output, 'runtime-hash'))},'f'.repeat(64));if(config.error)`,
    ),
  );
  try {
    assert.equal(
      (await f.inventory.codexControlState({})).body.error,
      'codex-control-runtime-changed',
    );
  } finally {
    await writeFile(join(output, 'runtime-hash'), hash);
  }
});
test('runtime I/O failure during preview resolves a finite error', async (t) => {
  const f = await fixture(t);
  await rm(join(output, 'runtime-hash'));
  try {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await f.inventory.codexControlPreview(selection), {
        status: 503,
        body: { error: 'codex-control-unavailable' },
      });
    });
  } finally {
    await writeFile(join(output, 'runtime-hash'), hash);
  }
});
