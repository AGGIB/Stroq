import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { createTaskLockService } from './task-lock-service.mjs';
import { startServer } from './serve.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const core = await tsImport('../../packages/core/src/index.ts', import.meta.url);
const schema = {
  ...(await tsImport('../lib/task-locks.ts', import.meta.url)),
  ...(await tsImport('../lib/task-lock-page.ts', import.meta.url)),
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clock = Date.parse('2026-10-24T12:00:00.000Z');

test('authenticated HTTP reaches a signed current permission after 65 archives and revokes the real native gate', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-page-real-http-')));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq'),
    root = join(base, 'out');
  await mkdir(project, { mode: 0o700 });
  await mkdir(join(home, 'keys'), { recursive: true, mode: 0o700 });
  await mkdir(root);
  await writeFile(join(root, 'index.html'), 'fixture');
  const tsconfig = join(base, 'tsconfig.json'),
    workerPath = join(base, 'worker.mjs');
  await writeFile(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        baseUrl: repo,
        paths: { '@stroq/core': ['packages/core/src/index.ts'] },
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }),
  );
  await writeFile(
    workerPath,
    `import {tsImport} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; await tsImport(${JSON.stringify(join(repo, 'console/scripts/task-lock-worker.ts'))}, {parentURL:import.meta.url,tsconfig:${JSON.stringify(tsconfig)}});`,
  );
  const pair = core.generateKeyPair(),
    policy = hash(core.stableStringify(core.DEFAULT_POLICY));
  await writeFile(
    join(home, 'keys/permit.pub'),
    pair.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o644 },
  );
  const store = new core.FilePermitStore({ home });
  function permit(rawId, overrides = {}, ended = false) {
    const body = {
      v: 1,
      taskId: rawId,
      nonce: 'PRIVATE_FIXTURE_NONCE_0123456789',
      host: 'claude-code',
      profile: 'repo-edit-and-test',
      mode: 'hook-only',
      projectRoot: project,
      sessionId: 'PRIVATE_FIXTURE_SESSION',
      issuedAt: '2026-10-24T11:50:00.000Z',
      expiresAt: '2026-10-24T12:30:00.000Z',
      policyDigest: policy,
      stateDigests: {},
      screenDigest: 'b'.repeat(64),
      scope: {
        tools: ['Read'],
        shell: 'denied',
        read: { allow: [project + '/**'], deny: [] },
        write: { allow: [], deny: [] },
        net: { mode: 'none' },
        mcp: [],
      },
      ...overrides,
    };
    const text = JSON.stringify(core.signPermit(body, pair.privateKey));
    store.writePermit(rawId, text);
    if (ended) store.end(rawId);
    return { body, text };
  }
  permit('000-foreign', { projectRoot: join(base, 'foreign') });
  await mkdir(join(home, 'tasks/001-invalid'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'tasks/001-invalid/permit.json'), 'PRIVATE_INVALID_FIXTURE', {
    mode: 0o600,
  });
  for (let index = 0; index < 65; index++)
    permit(
      `archive-${String(index).padStart(3, '0')}`,
      { issuedAt: '2026-10-23T11:50:00.000Z', expiresAt: '2026-10-23T12:30:00.000Z' },
      true,
    );
  const selected = permit('zz-private-current-task');
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`,
    taskId = `task-${hash(workspaceId + '\0' + selected.body.taskId)}`,
    permitSha256 = hash(selected.text);
  let service, app;
  const make = () =>
    createTaskLockService({
      project,
      userHome,
      home,
      workerPath,
      available: async () => ({ available: true, version: '0.28.0' }),
      runtimeDigest: async () => 'a'.repeat(64),
      loadValidator: async () => schema,
      now: () => clock,
    });
  const start = async () => {
    service = await make();
    app = await startServer({ root, project, userHome, home, taskLocks: service, port: 0 });
  };
  t.after(async () => {
    await app?.close();
    await service?.close();
    await rm(base, { recursive: true, force: true });
  });
  await start();
  const request = async (path, body) => {
    const origin = app.url.split('/#')[0];
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const first = await request('/api/task-locks/page');
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(schema.validateTaskLockPage(first.body), true);
  assert.equal(first.body.page.index, 1);
  assert.equal(
    first.body.state.tasks.some((row) => row.id === taskId),
    false,
  );
  assert.equal(first.body.state.coverage.foreign, 1);
  assert.equal(first.body.state.coverage.unverified, 1);
  const next = await request('/api/task-locks/page', { cursor: first.body.page.nextCursor });
  assert.equal(next.status, 200, JSON.stringify(next));
  assert.equal(next.body.page.index, 2);
  assert.equal(
    next.body.state.tasks.some((row) => row.id === taskId),
    true,
  );
  assert.equal(next.body.page.nextCursor, null);
  for (const expectedPermit of [null, permitSha256]) {
    const exact = await request('/api/task-locks/page', {
      id: taskId,
      expectedPermitSha256: expectedPermit,
    });
    assert.equal(exact.status, 200, JSON.stringify(exact));
    assert.equal(exact.body.page.index, 2);
    assert.equal(
      exact.body.state.tasks.some((row) => row.id === taskId),
      true,
    );
  }
  assert.equal(
    (await request('/api/task-locks/page', { id: taskId, expectedPermitSha256: 'f'.repeat(64) }))
      .status,
    409,
  );
  const gate = core.createScopeGate({
    taskId: selected.body.taskId,
    store,
    keys: {
      readPublicKey: () => ({
        kind: 'ok',
        key: pair.publicKey,
        keyId: core.keyIdOf(pair.publicKey),
      }),
    },
    context: () => ({
      nonce: selected.body.nonce,
      projectRoot: project,
      policyDigest: policy,
      stateDigests: {},
    }),
    now: () => new Date(clock),
  });
  const event = {
    sessionId: selected.body.sessionId,
    toolName: 'Read',
    toolInput: { file_path: join(project, 'README.md') },
    cwd: project,
  };
  const input = {
    event,
    classification: core.classifyTool(event.toolName, event.toolInput, event.cwd),
    classes: [],
    decision: { effect: 'allow', ruleId: null, reason: 'fixture' },
  };
  assert.equal((await gate.evaluate(input)).decision.effect, 'allow');
  const preview = await request('/api/task-locks/preview', {
    id: taskId,
    expectedPermitSha256: permitSha256,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.body.canApply, true);
  const refused = await request('/api/task-locks/apply', { previewId: preview.body.id });
  assert.equal(refused.status, 400);
  const applied = await request('/api/task-locks/apply', {
    previewId: preview.body.id,
    acknowledgeTaskInterruption: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(schema.validateTaskLockReceipt(applied.body), true);
  const after = await gate.evaluate(input);
  assert.equal(after.decision.effect, 'deny');
  assert.equal(after.decision.ruleId, 'task-void:revoked');
  assert.equal((await readFile(join(home, 'tasks', selected.body.taskId, 'revoked'))).length, 0);
  const rechecked = await request('/api/task-locks/page', { cursor: first.body.page.nextCursor });
  assert.equal(rechecked.status, 200, JSON.stringify(rechecked));
  assert.equal(rechecked.body.state.tasks.find((row) => row.id === taskId).standing, 'revoked');
  for (const privateValue of [
    selected.body.taskId,
    selected.body.nonce,
    selected.body.sessionId,
    project,
    home,
    'PRIVATE_INVALID_FIXTURE',
  ])
    assert.equal(
      JSON.stringify([first, next, preview, applied, rechecked]).includes(privateValue),
      false,
    );
  await app.close();
  await start();
  assert.equal(
    (await request('/api/task-locks/page', { cursor: first.body.page.nextCursor })).body.error,
    'task-page-stale',
  );
  const resumed = await request('/api/task-locks/page', {
    id: taskId,
    expectedPermitSha256: permitSha256,
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed));
  assert.equal(resumed.body.state.tasks.find((row) => row.id === taskId).standing, 'revoked');
});
