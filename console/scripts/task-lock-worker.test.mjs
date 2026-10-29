import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-lock-worker-build-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'fixture.ts'),
  `export {generateKeyPair,signPermit,AuditLog,DEFAULT_POLICY,FilePermitStore} from '${repository}/packages/core/src/index.ts';export {policySha256} from '${repository}/packages/cli/src/policy/digest.ts';`,
);
await build({
  entry: {
    worker: join(repository, 'console/scripts/task-lock-worker.ts'),
    fixture: join(output, 'fixture.ts'),
    schema: join(repository, 'console/lib/task-locks.ts'),
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
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import { createRequire as createTaskLockRequire } from 'node:module'; const require = createTaskLockRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const workerModule = await import(pathToFileURL(join(output, 'worker.mjs')).href);
const core = await import(pathToFileURL(join(output, 'fixture.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const now = '2026-10-23T12:00:00.000Z';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-lock-fixture-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const workspaceId = `workspace-${sha(project).slice(0, 24)}`;
  const identity = async (path) => {
    const info = await lstat(path);
    return { path, dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
  };
  const options = {
    project,
    userHome,
    home,
    workspaceId,
    runtimeSha256: 'a'.repeat(64),
    engineVersion: '0.28.0',
    platform: 'darwin',
    now,
    deadline: Date.now() + 25_000,
    rootBindings: { project: await identity(project), user: await identity(userHome) },
  };
  const keys = core.generateKeyPair();
  async function permit(taskId, overrides = {}) {
    await mkdir(join(home, 'keys'), { recursive: true, mode: 0o700 });
    await mkdir(join(home, 'tasks', taskId), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'keys', 'permit.pub'),
      keys.publicKey.export({ format: 'pem', type: 'spki' }),
      { mode: 0o644 },
    );
    const body = {
      v: 1,
      taskId,
      nonce: 'fixture-nonce-0123456789',
      host: 'claude-code',
      profile: 'repo-edit-and-test',
      mode: 'srt',
      projectRoot: project,
      sessionId: `session-${taskId}`,
      issuedAt: '2026-10-23T11:50:00.000Z',
      expiresAt: '2026-10-23T12:30:00.000Z',
      policyDigest: core.policySha256(core.DEFAULT_POLICY),
      stateDigests: {},
      scope: {
        tools: ['Read', 'Write', 'Bash'],
        read: {
          allow: [`${project}/src/**`, `${userHome}/docs/**`, '/external/private/**'],
          deny: [],
        },
        write: { allow: [`${project}/src/**`], deny: [] },
        net: { mode: 'hosts', hosts: ['example.com', '*.example.net'] },
        mcp: [{ server: 'local-test', tools: ['read'] }],
        shell: 'allowed',
      },
      screenDigest: 'b'.repeat(64),
      ...overrides,
    };
    const text = JSON.stringify(core.signPermit(body, keys.privateKey));
    const path = join(home, 'tasks', taskId, 'permit.json');
    await writeFile(path, text, { mode: 0o600 });
    return {
      body,
      path,
      text,
      id: `task-${sha(workspaceId + '\0' + taskId)}`,
      permitSha256: sha(text),
    };
  }
  const call = (operation, input = {}, extra = {}, fault) =>
    workerModule.runTaskLockWorker(
      { operation, input, options: { ...options, ...extra } },
      fault ? { fault } : {},
    );
  async function thread(operation, input = {}, extra = {}) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: { operation, input, options: { ...options, ...extra } },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return new Promise((resolveRun, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('test-deadline'));
      }, 20_000);
      worker.once('message', async (value) => {
        clearTimeout(timer);
        await worker.terminate();
        resolveRun(value);
      });
      worker.once('error', reject);
    });
  }
  return {
    base,
    project,
    userHome,
    home,
    workspaceId,
    options,
    keys,
    permit,
    call,
    thread,
    identity,
  };
}

test('missing state is read-only and actual worker protocol returns the closed public schema', async (t) => {
  const f = await fixture(t);
  const value = await f.thread('state');
  assert.equal(value.type, 'result');
  assert.ok(schema.validateTaskLockState(value.result));
  assert.deepEqual(value.result.tasks, []);
  assert.deepEqual(value.result.coverage, {
    complete: true,
    limited: false,
    unverified: 0,
    foreign: 0,
  });
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
});

test('authentic permits expose safe real grants, clock eligibility and marker standing without private fields', async (t) => {
  const f = await fixture(t);
  const selected = await f.permit('selected');
  await f.permit('expired', {
    issuedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-23T11:00:00.000Z',
  });
  await f.permit('future', {
    issuedAt: '2026-10-23T12:02:00.000Z',
    expiresAt: '2026-10-23T12:32:00.000Z',
  });
  await f.permit('revoked');
  await writeFile(join(f.home, 'tasks/revoked/revoked'), '', { mode: 0o600 });
  await f.permit('ended', { mode: undefined });
  await writeFile(join(f.home, 'tasks/ended/ended'), '', { mode: 0o600 });
  await f.permit('foreign', { projectRoot: '/another/workspace' });
  const rawPrivate = join(f.home, 'keys', 'permit.key');
  await writeFile(rawPrivate, 'PRIVATE_SIGNING_KEY');
  await chmod(rawPrivate, 0);
  const state = await f.call('state');
  assert.ok(schema.validateTaskLockState(state));
  assert.equal(state.tasks.length, 5);
  assert.equal(state.coverage.foreign, 1);
  assert.equal(state.coverage.complete, true);
  const row = state.tasks.find((row) => row.id === selected.id);
  assert.equal(row.eligibility, 'eligible');
  assert.equal(row.policyRelation, 'matches-current');
  assert.deepEqual(row.scope.tools, ['Read', 'Write', 'Bash']);
  assert.deepEqual(
    row.scope.read.allow.map(({ root, pattern }) => ({ root, pattern })),
    [
      { root: 'workspace', pattern: 'src/**' },
      { root: 'home', pattern: 'docs/**' },
      { root: 'external', pattern: null },
    ],
  );
  assert.deepEqual(row.scope.net, { mode: 'hosts', hosts: ['example.com', '*.example.net'] });
  assert.ok(state.tasks.some((row) => row.eligibility === 'expired'));
  assert.ok(state.tasks.some((row) => row.eligibility === 'not-yet-valid'));
  assert.ok(state.tasks.some((row) => row.standing === 'revoked'));
  assert.ok(state.tasks.some((row) => row.standing === 'ended' && row.declaredMode === 'unknown'));
  const serialized = JSON.stringify(state);
  for (const privateValue of [
    f.project,
    f.userHome,
    selected.body.nonce,
    selected.body.sessionId,
    'PRIVATE_SIGNING_KEY',
    selected.text,
    '"taskId"',
    '"sig"',
  ])
    assert.ok(!serialized.includes(privateValue));
});

test('bad signatures, strict duplicate JSON, invalid UTF-8, linked permits and unsafe key sources remain coverage gaps', async (t) => {
  const f = await fixture(t);
  const bad = await f.permit('bad-signature');
  const changed = JSON.parse(bad.text);
  changed.body.scope.shell = 'denied';
  await writeFile(bad.path, JSON.stringify(changed));
  const duplicate = await f.permit('duplicate');
  await writeFile(duplicate.path, duplicate.text.replace('"v":1', '"v":1,"v":1'));
  const linked = await f.permit('linked');
  await rename(linked.path, join(f.base, 'outside-permit'));
  await symlink(join(f.base, 'outside-permit'), linked.path);
  const invalidUtf8 = await f.permit('invalid-utf8');
  await writeFile(invalidUtf8.path, Buffer.from([0xff]));
  const state = await f.call('state');
  assert.equal(state.tasks.length, 0);
  assert.equal(state.coverage.unverified, 4);
  assert.equal(state.coverage.complete, false);
  assert.ok(schema.validateTaskLockState(state));
  await rm(join(f.home, 'keys', 'permit.pub'));
  await symlink(join(f.base, 'outside-permit'), join(f.home, 'keys', 'permit.pub'));
  const refused = await f.call('state');
  assert.equal(refused.coverage.complete, false);
  assert.equal(refused.tasks.length, 0);
});

test('selected policy is read without creating keys and drift is distinct from signed eligibility', async (t) => {
  const f = await fixture(t);
  await f.permit('policy');
  await writeFile(join(f.home, 'policy.yaml'), 'version: 1\ndefault: deny\nrules: []\n', {
    mode: 0o600,
  });
  const state = await f.call('state');
  assert.equal(state.tasks[0].eligibility, 'eligible');
  assert.equal(state.tasks[0].policyRelation, 'differs-current');
  await writeFile(join(f.home, 'policy.yaml'), 'invalid: policy');
  const bad = await f.call('state');
  assert.equal(bad.currentPolicySha256, null);
  assert.equal(bad.tasks[0].policyRelation, 'unavailable');
  await assert.rejects(lstat(join(f.home, 'keys', 'permit.key')), { code: 'ENOENT' });
});

test('full journal evidence uses real chain verification and exact receipt pairing, never command text', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('evidence');
  const audit = new core.AuditLog(join(f.home, 'audit.jsonl'), () => new Date(now));
  const base = {
    taskId: 'evidence',
    sessionId: 'session-evidence',
    tool: 'Bash',
    summary: 'PRIVATE_COMMAND',
    scope: { kind: 'in-scope', ruleId: 'task-in-scope' },
  };
  await audit.append({
    ...base,
    phase: 'pre',
    callId: 'one',
    decision: { effect: 'allow', ruleId: null, reason: 'PRIVATE_REASON' },
  });
  await audit.append({ ...base, phase: 'post', callId: 'one' });
  await audit.append({
    ...base,
    phase: 'pre',
    callId: 'two',
    decision: { effect: 'allow', ruleId: null, reason: 'okay' },
  });
  await audit.append({ ...base, phase: 'post', callId: 'two', outcome: 'failed' });
  await audit.append({
    ...base,
    phase: 'pre',
    callId: 'three',
    decision: { effect: 'deny', ruleId: 'task-scope', reason: 'no' },
    scope: { kind: 'scope', ruleId: 'task-scope', fingerprint: 'c'.repeat(64) },
  });
  assert.equal((await audit.verify()).ok, true);
  const state = await f.call('state'),
    row = state.tasks.find((row) => row.id === selected.id);
  assert.equal(row.evidence.status, 'verified');
  assert.deepEqual(row.evidence.counts, {
    calls: 3,
    allowed: 2,
    denied: 1,
    asks: 0,
    hostReported: 1,
    hostFailure: 1,
    unconfirmed: 1,
  });
  assert.deepEqual(row.evidence.lastGate, { at: now, effect: 'deny', kind: 'scope' });
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  const file = join(f.home, 'audit.jsonl');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('PRIVATE_COMMAND', 'CHANGED_COMMAND'),
  );
  assert.equal((await audit.verify()).ok, false);
  const broken = await f.call('state');
  assert.equal(broken.tasks[0].evidence.status, 'broken');
  assert.equal(broken.tasks[0].evidence.counts, null);
});

test('preview performs zero writes; guarded apply creates only the exact marker and proves core gate refusal', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('revoke');
  const before = await readdir(join(f.home, 'tasks', 'revoke'));
  const preview = await f.call('preview', {
    id: selected.id,
    expectedPermitSha256: selected.permitSha256,
  });
  assert.equal(preview.canApply, true);
  assert.equal(preview.task.id, selected.id);
  assert.deepEqual(await readdir(join(f.home, 'tasks', 'revoke')), before);
  const input = {
    plan: preview.plan,
    bindingSha256: preview.bindingSha256,
    previewId: randomUUID(),
    receiptId: randomUUID(),
  };
  await assert.rejects(f.call('apply', input), { message: 'task-lock-failed' });
  const receipt = await f.call('apply', input, { configurationLockHeld: true });
  assert.ok(schema.validateTaskLockReceipt(receipt));
  assert.equal(receipt.taskId, selected.id);
  assert.equal(receipt.gateRule, 'task-void:revoked');
  assert.equal(receipt.hostTermination, 'unverified');
  assert.equal(await readFile(selected.path, 'utf8'), selected.text);
  const marker = join(f.home, 'tasks/revoke/revoked');
  assert.equal((await lstat(marker)).mode & 0o777, 0o600);
  assert.equal((await readFile(marker)).length, 0);
  assert.deepEqual((await readdir(join(f.home, 'tasks/revoke'))).sort(), [
    'permit.json',
    'revoked',
  ]);
  const state = await f.call('state');
  assert.equal(state.tasks[0].standing, 'revoked');
  await assert.rejects(f.call('apply', input, { configurationLockHeld: true }), {
    message: 'preview-stale',
  });
});

test('permit, key, runtime, directory, expiry and foreign marker drift refuse before creating a marker', async (t) => {
  for (const drift of ['permit', 'key', 'runtime', 'directory', 'expiry', 'marker']) {
    const f = await fixture(t),
      selected = await f.permit(`stale-${drift}`);
    const preview = await f.call('preview', {
      id: selected.id,
      expectedPermitSha256: selected.permitSha256,
    });
    const extra = { configurationLockHeld: true };
    if (drift === 'permit') await writeFile(selected.path, selected.text + '\n');
    if (drift === 'key') await writeFile(join(f.home, 'keys/permit.pub'), 'changed');
    if (drift === 'runtime') extra.runtimeSha256 = 'd'.repeat(64);
    if (drift === 'directory') {
      await rename(join(f.home, 'tasks', `stale-${drift}`), join(f.base, 'original'));
      await mkdir(join(f.home, 'tasks', `stale-${drift}`), { mode: 0o700 });
      await writeFile(selected.path, selected.text, { mode: 0o600 });
    }
    if (drift === 'expiry') extra.now = '2026-10-23T13:00:00.000Z';
    if (drift === 'marker') await writeFile(join(f.home, 'tasks', `stale-${drift}`, 'ended'), '');
    await assert.rejects(
      f.call(
        'apply',
        {
          plan: preview.plan,
          bindingSha256: preview.bindingSha256,
          previewId: randomUUID(),
          receiptId: randomUUID(),
        },
        extra,
      ),
      { message: 'preview-stale' },
      drift,
    );
    await assert.rejects(lstat(join(f.home, 'tasks', `stale-${drift}`, 'revoked')), {
      code: 'ENOENT',
    });
  }
});

test('parent context pins and before-commit root substitution prevent writes outside the captured task', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('root-race');
  const preview = await f.call('preview', {
    id: selected.id,
    expectedPermitSha256: selected.permitSha256,
  });
  const original = join(f.base, 'original-tasks');
  await assert.rejects(
    f.call(
      'apply',
      {
        plan: preview.plan,
        bindingSha256: preview.bindingSha256,
        previewId: randomUUID(),
        receiptId: randomUUID(),
      },
      { configurationLockHeld: true },
      async (stage) => {
        if (stage !== 'before-commit') return;
        await rename(join(f.home, 'tasks'), original);
        await mkdir(join(f.home, 'tasks'), { mode: 0o700 });
        await mkdir(join(f.home, 'tasks/root-race'), { mode: 0o700 });
        await writeFile(join(f.home, 'tasks/root-race/permit.json'), selected.text, {
          mode: 0o600,
        });
      },
    ),
    { message: 'preview-stale' },
  );
  await assert.rejects(lstat(join(original, 'root-race/revoked')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.home, 'tasks/root-race/revoked')), { code: 'ENOENT' });
  const bad = { ...f.options.rootBindings, project: { ...f.options.rootBindings.project, ino: 0 } };
  const state = await f.call('state', {}, { rootBindings: bad });
  assert.equal(state.available, false);
  assert.equal(state.reason, 'context-unavailable');
});

test("post-write foreign changes return unconfirmed and never roll back someone else's marker", async (t) => {
  const f = await fixture(t),
    selected = await f.permit('post-race');
  const preview = await f.call('preview', {
    id: selected.id,
    expectedPermitSha256: selected.permitSha256,
  });
  const marker = join(f.home, 'tasks/post-race/revoked');
  await assert.rejects(
    f.call(
      'apply',
      {
        plan: preview.plan,
        bindingSha256: preview.bindingSha256,
        previewId: randomUUID(),
        receiptId: randomUUID(),
      },
      { configurationLockHeld: true },
      async (stage) => {
        if (stage === 'after-commit') await writeFile(marker, 'FOREIGN');
      },
    ),
    { message: 'write-unconfirmed' },
  );
  assert.equal(await readFile(marker, 'utf8'), 'FOREIGN');
});

test('launcher ending a task after observing revocation preserves a confirmed revoked receipt', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('completed-after-revoke');
  const preview = await f.call('preview', {
    id: selected.id,
    expectedPermitSha256: selected.permitSha256,
  });
  const receipt = await f.call(
    'apply',
    {
      plan: preview.plan,
      bindingSha256: preview.bindingSha256,
      previewId: randomUUID(),
      receiptId: randomUUID(),
    },
    { configurationLockHeld: true },
    async (stage) => {
      if (stage === 'after-commit')
        new core.FilePermitStore({ home: f.home }).end('completed-after-revoke');
    },
  );
  assert.ok(schema.validateTaskLockReceipt(receipt));
  assert.equal(receipt.storeReadback, 'revoked');
  assert.deepEqual((await readdir(join(f.home, 'tasks/completed-after-revoke'))).sort(), [
    'ended',
    'permit.json',
    'revoked',
  ]);
});

test('task and journal bounds remain explicit coverage/evidence gaps', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 65; index++) await f.permit(`task-${index}`);
  const state = await f.call('state');
  assert.equal(state.tasks.length, 64);
  assert.equal(state.coverage.limited, true);
  assert.equal(state.coverage.complete, false);
  await writeFile(join(f.home, 'audit.jsonl'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  const limited = await f.call('state');
  assert.ok(
    limited.tasks.every((row) => row.evidence.status === 'limit' && row.evidence.counts === null),
  );
});

test('control-bearing paths are withheld and boundary prefixes cannot masquerade as workspace grants', async (t) => {
  const f = await fixture(t),
    first = await f.permit('display');
  await f.permit('display', {
    scope: {
      ...first.body.scope,
      read: {
        allow: [
          `${f.project}/src/\u202Ename/**`,
          `${f.project}-other/private/**`,
          `${f.project}/**`,
          f.project,
        ],
        deny: [],
      },
    },
  });
  const state = await f.call('state');
  assert.ok(schema.validateTaskLockState(state));
  assert.deepEqual(
    state.tasks[0].scope.read.allow.map(({ root, pattern }) => ({ root, pattern })),
    [
      { root: 'workspace', pattern: null },
      { root: 'external', pattern: null },
      { root: 'workspace', pattern: '**' },
      { root: 'workspace', pattern: '.' },
    ],
  );
  assert.ok(!JSON.stringify(state).includes('\u202E'));
});

test('expired, ended and revoked previews retain exact reasons without writing or deleting markers', async (t) => {
  for (const standing of ['expired', 'ended', 'revoked']) {
    const f = await fixture(t),
      selected = await f.permit(
        standing,
        standing === 'expired'
          ? { issuedAt: '2026-10-23T10:00:00.000Z', expiresAt: '2026-10-23T11:00:00.000Z' }
          : {},
      );
    if (standing !== 'expired')
      await writeFile(join(f.home, 'tasks', standing, standing), '', { mode: 0o600 });
    const before = await readdir(join(f.home, 'tasks', standing));
    const preview = await f.call('preview', {
      id: selected.id,
      expectedPermitSha256: selected.permitSha256,
    });
    assert.equal(preview.canApply, false);
    assert.equal(
      preview.reason,
      { expired: 'permit-expired', ended: 'task-ended', revoked: 'already-revoked' }[standing],
    );
    assert.deepEqual(await readdir(join(f.home, 'tasks', standing)), before);
  }
});

test('hardlinks and writable task directories are refused before a revoke marker can be created', async (t) => {
  for (const unsafe of ['permit-hardlink', 'key-hardlink', 'writable-task']) {
    const f = await fixture(t),
      selected = await f.permit(unsafe),
      preview = await f.call('preview', {
        id: selected.id,
        expectedPermitSha256: selected.permitSha256,
      });
    if (unsafe === 'permit-hardlink') await link(selected.path, join(f.base, 'other-permit'));
    if (unsafe === 'key-hardlink')
      await link(join(f.home, 'keys/permit.pub'), join(f.base, 'other-public'));
    if (unsafe === 'writable-task') await chmod(join(f.home, 'tasks', unsafe), 0o777);
    await assert.rejects(
      f.call(
        'apply',
        {
          plan: preview.plan,
          bindingSha256: preview.bindingSha256,
          previewId: randomUUID(),
          receiptId: randomUUID(),
        },
        { configurationLockHeld: true },
      ),
      { message: 'preview-stale' },
    );
    await assert.rejects(lstat(join(f.home, 'tasks', unsafe, 'revoked')), { code: 'ENOENT' });
  }
});

test('an unsafe new ended marker does not satisfy the legitimate launcher-end exception', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('unsafe-ended'),
    preview = await f.call('preview', {
      id: selected.id,
      expectedPermitSha256: selected.permitSha256,
    });
  await assert.rejects(
    f.call(
      'apply',
      {
        plan: preview.plan,
        bindingSha256: preview.bindingSha256,
        previewId: randomUUID(),
        receiptId: randomUUID(),
      },
      { configurationLockHeld: true },
      async (stage) => {
        if (stage === 'after-commit')
          await writeFile(join(f.home, 'tasks/unsafe-ended/ended'), 'FOREIGN', { mode: 0o600 });
      },
    ),
    { message: 'write-unconfirmed' },
  );
  assert.equal((await readFile(join(f.home, 'tasks/unsafe-ended/revoked'))).length, 0);
  assert.equal(await readFile(join(f.home, 'tasks/unsafe-ended/ended'), 'utf8'), 'FOREIGN');
});

test('the derived public budget omits whole rows explicitly rather than truncating actual grant lists', async (t) => {
  const f = await fixture(t),
    sample = await f.permit('budget-0');
  const grants = Array.from({ length: 128 }, (_, index) => `${f.project}/folder-${index}/**`);
  for (let index = 0; index < 10; index++)
    await f.permit(`budget-${index}`, {
      scope: {
        ...sample.body.scope,
        read: { allow: grants, deny: grants },
        write: { allow: grants, deny: grants },
      },
    });
  const state = await f.call('state');
  assert.ok(state.tasks.length > 0 && state.tasks.length < 10);
  assert.equal(state.coverage.limited, true);
  assert.equal(state.coverage.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 512 * 1024);
  assert.ok(
    state.tasks.every(
      (row) =>
        row.scope.read.allow.length === 128 &&
        row.scope.read.deny.length === 128 &&
        row.scope.write.allow.length === 128 &&
        row.scope.write.deny.length === 128,
    ),
  );
});
