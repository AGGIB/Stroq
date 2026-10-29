import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'tsup';
import { createTaskLockService } from './task-lock-service.mjs';
import { startServer } from './serve.mjs';
import { createIncidentService } from './incidents.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-journey-build-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'core.ts'),
  `export {AuditLog,generateKeyPair,signPermit,createScopeGate,FilePermitStore,keyIdOf,classifyTool,DEFAULT_POLICY} from '${repository}/packages/core/src/index.ts';export {policySha256} from '${repository}/packages/cli/src/policy/digest.ts';export {withManifestLock} from '${repository}/packages/cli/src/harden/manifest.ts';`,
);
await writeFile(
  join(output, 'schema.ts'),
  `export * from '${repository}/console/lib/task-locks.ts';export * from '${repository}/console/lib/incident-task.ts';`,
);
await build({
  entry: {
    worker: join(repository, 'console/scripts/task-lock-worker.ts'),
    core: join(output, 'core.ts'),
    schema: join(output, 'schema.ts'),
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
    js: "import {createRequire as createTaskFixtureRequire} from 'node:module';const require=createTaskFixtureRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const core = await import(pathToFileURL(join(output, 'core.mjs')).href),
  schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const hash = (v) => createHash('sha256').update(v).digest('hex'),
  clock = Date.parse('2026-10-23T12:00:00.000Z');
async function fixture(t, { permit = true, extra = {} } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-http-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq'),
    root = join(base, 'out');
  await Promise.all([
    mkdir(project, { mode: 0o700 }),
    mkdir(userHome, { mode: 0o700 }),
    mkdir(root),
  ]);
  await writeFile(join(root, 'index.html'), 'fixture');
  const keys = core.generateKeyPair(),
    rawId = 'private-task-fixture',
    policy = core.policySha256(core.DEFAULT_POLICY);
  const body = {
    v: 1,
    taskId: rawId,
    nonce: 'private-nonce-fixture-0123456789',
    host: 'claude-code',
    profile: 'repo-edit-and-test',
    mode: 'srt',
    projectRoot: project,
    sessionId: 'private-session-fixture',
    issuedAt: '2026-10-23T11:50:00.000Z',
    expiresAt: '2026-10-23T12:30:00.000Z',
    policyDigest: policy,
    stateDigests: {},
    scope: {
      tools: ['Read'],
      read: { allow: [`${project}/**`], deny: [] },
      write: { allow: [], deny: [] },
      net: { mode: 'none' },
      mcp: [],
      shell: 'denied',
    },
    screenDigest: 'b'.repeat(64),
  };
  const source = join(home, 'tasks', rawId, 'permit.json'),
    marker = join(dirname(source), 'revoked'),
    text = JSON.stringify(core.signPermit(body, keys.privateKey));
  if (permit) {
    await mkdir(join(home, 'keys'), { recursive: true, mode: 0o700 });
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'keys/permit.pub'),
      keys.publicKey.export({ format: 'pem', type: 'spki' }),
      { mode: 0o644 },
    );
    await writeFile(source, text, { mode: 0o600 });
  }
  let runtime = 'a'.repeat(64),
    locked = 0;
  const withLock = async (context, action, options) =>
    core.withManifestLock(
      { home: context.home, version: context.version, now: () => new Date(clock) },
      async () => {
        locked++;
        return action();
      },
      options,
    );
  const incidents = createIncidentService({ home, now: () => new Date(clock) });
  const service = await createTaskLockService({
    project,
    userHome,
    home,
    workerPath: join(output, 'worker.mjs'),
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => runtime,
    loadValidator: async () => schema,
    now: () => clock,
    withLock,
    selectEvidence: (request) => incidents.selectForComparison(request),
    ...extra,
  });
  const app = await startServer({
    project,
    userHome,
    home,
    root,
    taskLocks: service,
    incidents,
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await rm(base, { recursive: true, force: true });
  });
  const origin = app.url.split('/#')[0];
  async function request(path, body, headers = {}, method) {
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
          : Buffer.isBuffer(body) || typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const gate = core.createScopeGate({
    taskId: rawId,
    store: new core.FilePermitStore({ home }),
    keys: {
      readPublicKey: () => ({
        kind: 'ok',
        key: keys.publicKey,
        keyId: core.keyIdOf(keys.publicKey),
      }),
    },
    context: () => ({
      nonce: body.nonce,
      projectRoot: project,
      policyDigest: policy,
      stateDigests: {},
    }),
    now: () => new Date(clock),
  });
  const event = {
    sessionId: body.sessionId,
    toolName: 'Read',
    toolInput: { file_path: join(project, 'README.md') },
    cwd: project,
  };
  const gateInput = {
    event,
    classification: core.classifyTool(event.toolName, event.toolInput, event.cwd),
    classes: [],
    decision: { effect: 'allow', ruleId: null, reason: 'fixture' },
  };
  const read = () => request('/api/task-locks');
  const preview = async () => {
    const state = await read();
    assert.equal(state.status, 200);
    assert.equal(schema.validateTaskLockState(state.body), true);
    const row = state.body.tasks[0];
    return request('/api/task-locks/preview', {
      id: row.id,
      expectedPermitSha256: row.permitSha256,
    });
  };
  return {
    base,
    project,
    userHome,
    home,
    source,
    marker,
    incidents,
    async appendIncident(overrides = {}, at = clock - 60_000) {
      const journal = new core.AuditLog(join(home, 'audit.jsonl'), () => new Date(at));
      await journal.append({
        sessionId: body.sessionId,
        phase: 'pre',
        tool: 'Read',
        summary: 'PRIVATE_INPUT_SENTINEL ' + project,
        classes: ['fs.secrets'],
        decision: { effect: 'deny', ruleId: 'task-hard:fs.secrets', reason: 'PRIVATE_REASON' },
        taskId: body.taskId,
        scope: { kind: 'hard', ruleId: 'task-hard:fs.secrets' },
        ...overrides,
      });
      const queue = await request('/api/incidents');
      assert.equal(queue.status, 200);
      const row = queue.body.incidents[0];
      return { id: row.id, expectedEvidenceSha: row.evidenceSha };
    },
    async replacePermit(overrides = {}) {
      const next = JSON.stringify(core.signPermit({ ...body, ...overrides }, keys.privateKey));
      await writeFile(source, next, { mode: 0o600 });
      return hash(next);
    },
    text,
    body,
    service,
    request,
    read,
    preview,
    gate,
    gateInput,
    withLock,
    setRuntime(v) {
      runtime = v;
    },
    locked: () => locked,
  };
}

test('actual HTTP signed permit review and irreversible revoke deny the next real core gate without launching an agent', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.gate.evaluate(f.gateInput)).decision.effect, 'allow');
  const sourceBefore = await readFile(f.source),
    modeBefore = (await lstat(f.source)).mode;
  const preview = await f.preview();
  assert.equal(preview.status, 200);
  assert.equal(schema.validateTaskLockPreview(preview.body), true);
  assert.equal(f.locked(), 0);
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
  for (const bad of [
    { previewId: preview.body.id },
    { previewId: preview.body.id, acknowledgeTaskInterruption: false },
    { previewId: preview.body.id, acknowledgeTaskInterruption: true, path: f.source },
  ])
    assert.equal((await f.request('/api/task-locks/apply', bad)).status, 400);
  assert.equal(f.locked(), 0);
  assert.deepEqual(await readFile(f.source), sourceBefore);
  const receipt = await f.request('/api/task-locks/apply', {
    previewId: preview.body.id,
    acknowledgeTaskInterruption: true,
  });
  assert.equal(receipt.status, 200);
  assert.equal(schema.validateTaskLockReceipt(receipt.body), true);
  assert.equal(receipt.body.previewId, preview.body.id);
  assert.equal(receipt.body.hostTermination, 'unverified');
  assert.equal(f.locked(), 1);
  assert.equal((await lstat(f.marker)).size, 0);
  assert.equal((await lstat(f.marker)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(f.source), sourceBefore);
  assert.equal((await lstat(f.source)).mode, modeBefore);
  const denied = await f.gate.evaluate(f.gateInput);
  assert.equal(denied.decision.effect, 'deny');
  assert.equal(denied.decision.ruleId, 'task-void:revoked');
  const state = await f.read();
  assert.equal(state.body.tasks[0].standing, 'revoked');
  assert.equal(schema.validateTaskLockState(state.body), true);
  const blocked = await f.preview();
  assert.equal(blocked.body.canApply, false);
  assert.equal(blocked.body.reason, 'already-revoked');
  assert.equal(
    (
      await f.request('/api/task-locks/apply', {
        previewId: blocked.body.id,
        acknowledgeTaskInterruption: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request('/api/task-locks/apply', {
        previewId: preview.body.id,
        acknowledgeTaskInterruption: true,
      })
    ).status,
    409,
  );
  for (const publicValue of [state.body, preview.body, receipt.body])
    for (const privateValue of [
      f.project,
      f.userHome,
      f.body.taskId,
      f.body.nonce,
      f.body.sessionId,
      f.text,
      'PRIVATE_SIGNING_KEY',
    ])
      assert.equal(JSON.stringify(publicValue).includes(privateValue), false);
});

test('actual task-lock HTTP boundaries reject unauthenticated, foreign, malformed and browser-selected sources without consuming preview', async (t) => {
  const f = await fixture(t);
  const preview = await f.preview();
  const valid = { previewId: preview.body.id, acknowledgeTaskInterruption: true };
  for (const [input, headers, status] of [
    [valid, { Authorization: '' }, 401],
    [valid, { Origin: 'https://foreign.invalid' }, 403],
    [valid, { 'Content-Type': 'text/plain' }, 415],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(4097), {}, 413],
    [{ ...valid, taskId: 'PRIVATE_SENTINEL' }, {}, 400],
    [{ ...valid, acknowledgeTaskInterruption: 1 }, {}, 400],
  ])
    assert.equal((await f.request('/api/task-locks/apply', input, headers)).status, status);
  assert.equal((await f.request('/api/task-locks', undefined, {}, 'DELETE')).status, 405);
  for (const bad of [
    { id: '../private', expectedPermitSha256: 'a'.repeat(64) },
    { id: preview.body.task.id, expectedPermitSha256: 'a' },
    {
      id: preview.body.task.id,
      expectedPermitSha256: preview.body.task.permitSha256,
      scope: 'user',
    },
  ])
    assert.equal((await f.request('/api/task-locks/preview', bad)).status, 400);
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
  assert.equal((await f.request('/api/task-locks/apply', valid)).status, 200);
});

test('exact permit bytes, mode, key and runtime changes refuse stale apply without a marker', async (t) => {
  for (const drift of ['source', 'mode', 'key', 'runtime']) {
    const f = await fixture(t),
      preview = await f.preview();
    if (drift === 'source') await writeFile(f.source, f.text + '\n');
    if (drift === 'mode') await chmod(f.source, 0o400);
    if (drift === 'key') await writeFile(join(f.home, 'keys/permit.pub'), 'foreign');
    if (drift === 'runtime') f.setRuntime('f'.repeat(64));
    const result = await f.request('/api/task-locks/apply', {
      previewId: preview.body.id,
      acknowledgeTaskInterruption: true,
    });
    assert.equal(result.status, 409, drift);
    assert.equal(result.body.error, 'preview-stale', drift);
    await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
  }
});

test('read-only missing state creates no Stroq home; fresh service reads the durable core revocation marker', async (t) => {
  const empty = await fixture(t, { permit: false });
  const state = await empty.read();
  assert.equal(state.status, 200);
  assert.equal(schema.validateTaskLockState(state.body), true);
  assert.deepEqual(state.body.tasks, []);
  await assert.rejects(lstat(empty.home), { code: 'ENOENT' });
  const f = await fixture(t),
    preview = await f.preview();
  assert.equal(
    (
      await f.request('/api/task-locks/apply', {
        previewId: preview.body.id,
        acknowledgeTaskInterruption: true,
      })
    ).status,
    200,
  );
  await f.service.close();
  const restarted = await createTaskLockService({
    project: f.project,
    userHome: f.userHome,
    home: f.home,
    workerPath: join(output, 'worker.mjs'),
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => 'a'.repeat(64),
    loadValidator: async () => schema,
    now: () => clock,
  });
  t.after(() => restarted.close());
  assert.equal((await restarted.getState()).tasks[0].standing, 'revoked');
});

test('actual harden lock remains held until timed-out worker termination and can be acquired afterward', async (t) => {
  const f = await fixture(t, { extra: { timeoutMs: 1500 } }),
    preview = await f.preview(),
    worker = join(f.base, 'paused.mjs'),
    heartbeat = join(f.base, 'heartbeat');
  // A separate service uses a fixed inert worker solely to exercise parent termination/lock lifecycle.
  const original = await readFile(join(output, 'worker.mjs'), 'utf8');
  await writeFile(worker, original);
  const service = await createTaskLockService({
    project: f.project,
    userHome: f.userHome,
    home: f.home,
    workerPath: worker,
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => 'a'.repeat(64),
    loadValidator: async () => schema,
    now: () => clock,
    withLock: f.withLock,
    timeoutMs: 1500,
  });
  t.after(() => service.close());
  const prepared = await service.preview({
    id: preview.body.task.id,
    expectedPermitSha256: preview.body.task.permitSha256,
  });
  await writeFile(
    worker,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(heartbeat)},'ready');setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`,
  );
  const applying = service.apply({
    previewId: prepared.body.id,
    acknowledgeTaskInterruption: true,
  });
  for (let n = 0; n < 200; n++) {
    try {
      await readFile(heartbeat);
      break;
    } catch {
      await delay(10);
    }
  }
  await readFile(heartbeat);
  await assert.rejects(
    core.withManifestLock(
      { home: f.home, version: '0.28.0', now: () => new Date(clock) },
      async () => true,
      { timeoutMs: 30 },
    ),
    /lock timeout/,
  );
  const outcome = await applying;
  assert.equal(outcome.body.error, 'write-unconfirmed');
  const stopped = await readFile(heartbeat, 'utf8');
  await delay(80);
  assert.equal(await readFile(heartbeat, 'utf8'), stopped);
  assert.equal(
    await core.withManifestLock(
      { home: f.home, version: '0.28.0', now: () => new Date(clock) },
      async () => true,
      { timeoutMs: 100 },
    ),
    true,
  );
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
});

test('exact incident resolves current signed task metadata then ordinary guarded revoke denies core gate without resolving the incident', async (t) => {
  const f = await fixture(t),
    request = await f.appendIncident(),
    file = join(f.home, 'audit.jsonl');
  // Whitespace changes the exact line SHA but not core chain hashing. Selection must hash original bytes.
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('"seq":1', '"seq": 1').replace(/\n$/, '\r\n'));
  const incident = (await f.request('/api/incidents')).body.incidents[0];
  request.id = incident.id;
  request.expectedEvidenceSha = incident.evidenceSha;
  const captured = await readFile(file),
    permit = await readFile(f.source);
  const related = await f.request('/api/incidents/task', request);
  assert.equal(related.status, 200);
  assert.equal(schema.validateIncidentTaskReport(related.body), true);
  assert.equal(related.body.status, 'matched');
  assert.equal(related.body.relation, 'task-id-only');
  assert.equal(related.body.historicalPermitRelation, 'not-recorded');
  assert.equal(related.body.sessionRelation, 'matches');
  assert.equal(related.body.incident.evidenceSha256, request.expectedEvidenceSha);
  assert.equal(related.body.journal.sha256, hash(captured));
  assert.equal(related.body.task.permitSha256, hash(permit));
  assert.equal(f.locked(), 0);
  assert.deepEqual(await readFile(file), captured);
  assert.deepEqual(await readFile(f.source), permit);
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
  assert.equal((await f.gate.evaluate(f.gateInput)).decision.effect, 'allow');
  const preview = await f.request('/api/task-locks/preview', {
    id: related.body.task.id,
    expectedPermitSha256: related.body.task.permitSha256,
  });
  assert.equal(preview.status, 200);
  const applied = await f.request('/api/task-locks/apply', {
    previewId: preview.body.id,
    acknowledgeTaskInterruption: true,
  });
  assert.equal(applied.status, 200);
  assert.equal(schema.validateTaskLockReceipt(applied.body), true);
  assert.equal(Object.hasOwn(applied.body, 'incident'), false);
  assert.equal((await f.gate.evaluate(f.gateInput)).decision.ruleId, 'task-void:revoked');
  const after = (await f.request('/api/incidents')).body.incidents.find(
    (row) => row.id === request.id,
  );
  assert.deepEqual(after, incident);
  assert.equal(after.status, 'open');
  await assert.rejects(lstat(join(f.home, 'console/incident-reviews.json')), { code: 'ENOENT' });
  const reread = await f.request('/api/incidents/task', request);
  assert.equal(reread.body.task.standing, 'revoked');
  assert.equal(reread.body.historicalPermitRelation, 'not-recorded');
  for (const value of [related.body, reread.body, applied.body])
    for (const secret of [
      f.project,
      f.userHome,
      f.body.taskId,
      f.body.nonce,
      f.body.sessionId,
      'PRIVATE_INPUT_SENTINEL',
      'PRIVATE_REASON',
    ])
      assert.equal(JSON.stringify(value).includes(secret), false);
});

test('incident task HTTP selection is exact, bounded and cannot accept browser-supplied task, source or sequence metadata', async (t) => {
  const f = await fixture(t),
    request = await f.appendIncident();
  for (const [input, headers, status] of [
    [request, { Authorization: '' }, 401],
    [request, { Origin: 'https://foreign.invalid' }, 403],
    [request, { 'Content-Type': 'text/plain' }, 415],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(4097), {}, 413],
    [{ ...request, taskId: f.body.taskId }, {}, 400],
    [{ ...request, path: f.source }, {}, 400],
    [{ ...request, sequence: 1 }, {}, 400],
    [{ ...request, id: 'incident-' + '0'.repeat(64) }, {}, 400],
  ])
    assert.equal((await f.request('/api/incidents/task', input, headers)).status, status);
  assert.equal((await f.request('/api/incidents/task', undefined)).status, 405);
  const stale = { id: 'incident-' + '0'.repeat(64), expectedEvidenceSha: '0'.repeat(64) };
  assert.deepEqual(await f.request('/api/incidents/task', stale), {
    status: 409,
    body: { error: 'stale-evidence' },
  });
  const result = await f.request('/api/incidents/task', request);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'matched');
  assert.equal(f.locked(), 0);
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
});

test('missing, invalid, sentinel, foreign, session and time contradictions remain explicit task-relation gaps', async (t) => {
  for (const reason of [
    'not-recorded',
    'invalid-reference',
    'sentinel',
    'permit-unavailable',
    'different-workspace',
    'session-mismatch',
    'time-mismatch',
  ]) {
    const f = await fixture(t);
    let overrides = {},
      at = clock - 60_000;
    if (reason === 'not-recorded') overrides = { taskId: undefined, scope: undefined };
    if (reason === 'invalid-reference') overrides = { taskId: '../PRIVATE_OUTSIDE' };
    if (reason === 'sentinel') overrides = { taskId: 'invalid' };
    if (reason === 'session-mismatch') overrides = { sessionId: 'private-different-session' };
    if (reason === 'time-mismatch') at = Date.parse('2026-10-23T11:40:00.000Z');
    const request = await f.appendIncident(overrides, at);
    if (reason === 'permit-unavailable') await rm(f.source);
    if (reason === 'different-workspace')
      await f.replacePermit({ projectRoot: '/private/another-workspace' });
    const result = await f.request('/api/incidents/task', request);
    assert.equal(result.status, 200, reason);
    assert.equal(schema.validateIncidentTaskReport(result.body), true, reason);
    assert.equal(result.body.status, reason === 'sentinel' ? 'invalid-reference' : reason, reason);
    assert.equal(result.body.task, null, reason);
    assert.equal(result.body.relation, 'none', reason);
    assert.equal(f.locked(), 0);
    await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
  }
});

test('current permit replacement is explicitly current-ID metadata and old permission fingerprints cannot approve a new revision', async (t) => {
  const f = await fixture(t),
    request = await f.appendIncident();
  const first = await f.request('/api/incidents/task', request);
  assert.equal(first.status, 200);
  const firstTask = first.body.task;
  const next = await f.replacePermit({ mode: 'hook-only' });
  assert.deepEqual(
    await f.request('/api/task-locks/preview', {
      id: firstTask.id,
      expectedPermitSha256: firstTask.permitSha256,
    }),
    { status: 409, body: { error: 'preview-stale' } },
  );
  const current = await f.request('/api/incidents/task', request);
  assert.equal(current.status, 200);
  assert.equal(current.body.status, 'matched');
  assert.equal(current.body.task.permitSha256, next);
  assert.equal(current.body.task.declaredMode, 'hook-only');
  assert.equal(current.body.historicalPermitRelation, 'not-recorded');
  const preview = await f.request('/api/task-locks/preview', {
    id: current.body.task.id,
    expectedPermitSha256: next,
  });
  assert.equal(preview.status, 200);
  await f.replacePermit({ mode: 'srt', screenDigest: 'e'.repeat(64) });
  assert.deepEqual(
    await f.request('/api/task-locks/apply', {
      previewId: preview.body.id,
      acknowledgeTaskInterruption: true,
    }),
    { status: 409, body: { error: 'preview-stale' } },
  );
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
});

test('broken full journal cannot become a task relation even when the exact selected tail event is visible', async (t) => {
  const f = await fixture(t);
  await f.appendIncident();
  const request = await f.appendIncident(),
    file = join(f.home, 'audit.jsonl');
  const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.replace('PRIVATE_INPUT_SENTINEL', 'ALTERED_INPUT_SENTINEL'));
  const visible = (await f.request('/api/incidents')).body.incidents.find(
    (row) => row.id === request.id,
  );
  assert.ok(visible);
  const result = await f.request('/api/incidents/task', request);
  assert.equal(result.status, 200);
  assert.equal(schema.validateIncidentTaskReport(result.body), true);
  assert.equal(result.body.status, 'evidence-unavailable');
  assert.equal(result.body.journal.status, 'broken');
  assert.equal(result.body.task, null);
  assert.equal(f.locked(), 0);
  await assert.rejects(lstat(f.marker), { code: 'ENOENT' });
});
