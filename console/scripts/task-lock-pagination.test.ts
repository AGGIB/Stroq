import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  DEFAULT_POLICY,
  FileKeyStore,
  FilePermitStore,
  FileSessionStore,
  StroqEngine,
  createScopeGate,
  generateKeyPair,
  signPermit,
  signTaskAccessRequest,
  stableStringify,
  type PermitBody,
} from '../../packages/core/src/index.ts';
import { runTaskLockWorker } from './task-lock-worker.ts';
import type { Options } from './task-lock-files.ts';
import { assertTaskCatalog, captureTaskCatalog } from './task-lock-catalog.ts';
const now = '2026-10-24T12:00:00.000Z';
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-pagination-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(join(home, 'tasks'), { recursive: true, mode: 0o700 });
  await mkdir(join(home, 'keys'), { mode: 0o700 });
  const pair = generateKeyPair();
  await writeFile(
    join(home, 'keys/permit.pub'),
    pair.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o644 },
  );
  const workspaceId = 'workspace-' + hash(project).slice(0, 24);
  const identity = async (path: string) => {
    const s = await lstat(path);
    return { path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
  };
  const options: Options = {
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
  async function permit(rawId: string, overrides: Partial<PermitBody> = {}, ended = false) {
    const body: PermitBody = {
      v: 1,
      taskId: rawId,
      nonce: 'private-fixture-nonce-0123456789',
      host: 'claude-code',
      profile: 'repo-edit-and-test',
      mode: 'hook-only',
      projectRoot: project,
      sessionId: 'private-session-' + rawId,
      issuedAt: '2026-10-24T11:50:00.000Z',
      expiresAt: '2026-10-24T12:30:00.000Z',
      policyDigest: hash(stableStringify(DEFAULT_POLICY)),
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
    const text = JSON.stringify(signPermit(body, pair.privateKey));
    new FilePermitStore({ home }).writePermit(rawId, text);
    if (ended) new FilePermitStore({ home }).end(rawId);
    return {
      body,
      text,
      id: 'task-' + hash(workspaceId + '\0' + rawId),
      expectedPermitSha256: hash(text),
    };
  }
  const run = (
    operation: Parameters<typeof runTaskLockWorker>[0]['operation'],
    input: Record<string, unknown> = {},
    extra: Partial<Options> = {},
  ) => runTaskLockWorker({ operation, input, options: { ...options, ...extra } });
  return { project, userHome, home, options, permit, run, pair };
}

test('65 archived permits cannot hide exact current permission, ledger or guarded revoke', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++)
    await f.permit(
      'archive-' + String(i).padStart(3, '0'),
      { issuedAt: '2026-10-23T11:50:00.000Z', expiresAt: '2026-10-23T12:30:00.000Z' },
      true,
    );
  const selected = await f.permit('zz-current-permission');
  const initial: any = await f.run('page' as never, { offset: 0, expectedListingSha256: null });
  assert.equal(initial.state.tasks.length, 64);
  assert.equal(initial.listing.total, 66);
  assert.equal(initial.listing.limited, false);
  assert.equal(initial.state.coverage.limited, true);
  const next: any = await f.run('page' as never, {
    offset: 64,
    expectedListingSha256: initial.listing.sha256,
  });
  assert.equal(
    next.state.tasks.some((row: any) => row.id === selected.id),
    true,
  );
  assert.equal(next.listing.offset, 64);
  const exact: any = await f.run('page' as never, {
    id: selected.id,
    expectedPermitSha256: selected.expectedPermitSha256,
  });
  assert.equal(exact.listing.offset, 64);
  assert.equal(
    exact.state.tasks.some((row: any) => row.id === selected.id),
    true,
  );
  const ledger: any = await f.run('access-state', {
    id: selected.id,
    expectedPermitSha256: selected.expectedPermitSha256,
  });
  assert.deepEqual(ledger.permissions, []);
  const preview: any = await f.run('preview', {
    id: selected.id,
    expectedPermitSha256: selected.expectedPermitSha256,
  });
  assert.equal(preview.canApply, true);
  const receipt: any = await f.run(
    'apply',
    {
      plan: preview.plan,
      bindingSha256: preview.bindingSha256,
      previewId: randomUUID(),
      receiptId: randomUUID(),
    },
    { configurationLockHeld: true },
  );
  assert.equal(receipt.gateDecision, 'deny');
  assert.deepEqual(new FilePermitStore({ home: f.home }).readPermit(selected.body.taskId), {
    kind: 'void',
    reason: 'revoked',
  });
  for (const privateValue of [
    selected.body.taskId,
    selected.body.nonce,
    selected.body.sessionId!,
    f.project,
    f.home,
  ])
    assert.equal(
      JSON.stringify([initial.state, next.state, exact.state, ledger, receipt]).includes(
        privateValue,
      ),
      false,
    );
});

test('verified journal resolves its exact native task beyond the first page without catalog authority', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) await f.permit('archive-' + String(i).padStart(3, '0'), {}, true);
  const selected = await f.permit('zz-incident-permission');
  const path = join(f.home, 'audit.jsonl');
  await new AuditLog(path, () => new Date(now)).append({
    sessionId: selected.body.sessionId!,
    taskId: selected.body.taskId,
    phase: 'pre',
    tool: 'Read',
    summary: 'fixture',
    classes: [],
    decision: { effect: 'deny', ruleId: 'task-scope-read', reason: 'fixture' },
    scope: { kind: 'scope', ruleId: 'task-scope-read' },
  });
  const raw = (await readFile(path, 'utf8')).trimEnd(),
    row = JSON.parse(raw),
    sha = hash(raw);
  const report: any = await f.run('incident', {
    id: 'incident-' + sha,
    expectedEvidenceSha: sha,
    sequence: row.seq,
    recordedAt: row.ts,
  });
  assert.equal(report.status, 'matched');
  assert.equal(report.task.id, selected.id);
  assert.equal(report.historicalPermitRelation, 'not-recorded');
});

test('page candidates stay sorted and count foreign/invalid rows without inventing workspace membership', async (t) => {
  const f = await fixture(t);
  await f.permit('a-selected');
  await f.permit('b-foreign', { projectRoot: join(f.project, 'other') });
  await mkdir(join(f.home, 'tasks', 'c-invalid'));
  await writeFile(join(f.home, 'tasks', 'c-invalid/permit.json'), '{}', { mode: 0o600 });
  const page: any = await f.run('page', { offset: 0, expectedListingSha256: null });
  assert.equal(page.listing.total, 3);
  assert.equal(page.state.tasks.length, 1);
  assert.deepEqual(page.state.coverage, {
    complete: false,
    limited: false,
    foreign: 1,
    unverified: 1,
  });
  assert.equal(JSON.stringify(page.state).includes('b-foreign'), false);
});

test('exact lookup distinguishes absent, source mismatch, legacy current selection and malformed offsets', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('selected');
  const page: any = await f.run('page', { id: selected.id, expectedPermitSha256: null });
  assert.equal(page.state.tasks[0].permitSha256, selected.expectedPermitSha256);
  await assert.rejects(f.run('page', { id: selected.id, expectedPermitSha256: '0'.repeat(64) }), {
    message: 'preview-stale',
  });
  await assert.rejects(
    f.run('page', { id: 'task-' + '0'.repeat(64), expectedPermitSha256: null }),
    { message: 'task-unavailable' },
  );
  for (const input of [
    { offset: -64, expectedListingSha256: null },
    { offset: 1, expectedListingSha256: null },
    { offset: 64, expectedListingSha256: null },
    { offset: 8192, expectedListingSha256: null },
    { offset: 0, expectedListingSha256: 'private' },
    { offset: 0, expectedListingSha256: null, path: f.home },
  ])
    await assert.rejects(f.run('page', input), /task-page-stale/);
});

test('cursor digest binds listing, runtime, key and roots while policy and terminal state are freshly read', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('selected');
  const initial: any = await f.run('page', { offset: 0, expectedListingSha256: null });
  new FilePermitStore({ home: f.home }).end(selected.body.taskId);
  await writeFile(
    join(f.home, 'policy.yaml'),
    JSON.stringify({ ...DEFAULT_POLICY, default: 'deny' }),
    { mode: 0o600 },
  );
  const fresh: any = await f.run('page', {
    offset: 0,
    expectedListingSha256: initial.listing.sha256,
  });
  assert.equal(fresh.listing.sha256, initial.listing.sha256);
  assert.equal(fresh.state.tasks[0].standing, 'ended');
  assert.equal(fresh.state.tasks[0].policyRelation, 'differs-current');
  await assert.rejects(
    f.run(
      'page',
      { offset: 0, expectedListingSha256: initial.listing.sha256 },
      { runtimeSha256: 'c'.repeat(64) },
    ),
    { message: 'task-page-stale' },
  );
  const pair = generateKeyPair();
  await writeFile(
    join(f.home, 'keys/permit.pub'),
    pair.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  await assert.rejects(
    f.run('page', { offset: 0, expectedListingSha256: initial.listing.sha256 }),
    { message: 'task-page-stale' },
  );
});

test('catalog rejects changed names, substituted directories and unsafe roots before accepting another page', async (t) => {
  const f = await fixture(t);
  await f.permit('selected');
  const initial = await captureTaskCatalog(f.options);
  await mkdir(join(f.home, 'tasks', 'new-task'));
  await assert.rejects(assertTaskCatalog(f.options, initial), { message: 'task-page-stale' });
  await assert.rejects(
    captureTaskCatalog(f.options, async () => {
      await mkdir(join(f.home, 'tasks', 'raced-task'));
    }),
    { message: 'task-page-stale' },
  );
  const stable = await captureTaskCatalog(f.options);
  await rename(join(f.home, 'tasks'), join(f.home, 'old-tasks'));
  await mkdir(join(f.home, 'tasks'), { mode: 0o700 });
  await assert.rejects(assertTaskCatalog(f.options, stable), /preview-stale|task-page-stale/);
  await chmod(join(f.home, 'tasks'), 0o777);
  await assert.rejects(captureTaskCatalog(f.options), /unsafe-source/);
});

test('exact inspection ignores unsafe unrelated candidates but preserves selected permit/key/root guards', async (t) => {
  const f = await fixture(t),
    selected = await f.permit('zz-selected');
  await symlink(f.userHome, join(f.home, 'tasks', 'a-unsafe'));
  const preview: any = await f.run('preview', {
    id: selected.id,
    expectedPermitSha256: selected.expectedPermitSha256,
  });
  assert.equal(preview.canApply, true);
  await writeFile(join(f.home, 'tasks', selected.body.taskId, 'permit.json'), selected.text + '\n');
  await assert.rejects(
    f.run('preview', { id: selected.id, expectedPermitSha256: selected.expectedPermitSha256 }),
    { message: 'preview-stale' },
  );
  await assert.rejects(
    f.run(
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
});

test('signed one-use refusal preview beyond first64 still uses its exact verified permit and private-key metadata', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) await f.permit('archive-' + String(i).padStart(3, '0'), {}, true);
  const selected = await f.permit('zz-access-permission'),
    body = selected.body;
  await writeFile(
    join(f.home, 'keys/permit.key'),
    f.pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 },
  );
  const store = new FilePermitStore({ home: f.home }),
    gate = createScopeGate({
      taskId: body.taskId,
      store,
      keys: new FileKeyStore({ home: f.home }),
      context: () => ({
        nonce: body.nonce,
        projectRoot: body.projectRoot,
        policyDigest: body.policyDigest,
        stateDigests: body.stateDigests,
      }),
      now: () => new Date(now),
      paths: { flavor: 'posix', foldCase: false },
    });
  const journalPath = join(f.home, 'audit.jsonl'),
    audit = new AuditLog(journalPath, () => new Date(now));
  const engine = new StroqEngine({
    rules: [],
    policy: DEFAULT_POLICY,
    scope: gate,
    audit,
    now: () => new Date(now),
    sessions: new FileSessionStore(join(f.home, 'sessions'), () => new Date(now)),
    taskAccessSigner: (request) => signTaskAccessRequest(request, f.pair.privateKey),
  });
  const denied = await engine.pre({
    sessionId: body.sessionId!,
    callId: 'selected-call',
    cwd: f.project,
    toolName: 'Read',
    toolInput: { file_path: join(f.userHome, 'outside.txt') },
  });
  assert.equal(denied.decision.effect, 'deny');
  const raw = (await readFile(journalPath, 'utf8')).trimEnd(),
    row = JSON.parse(raw),
    sha = hash(raw);
  assert.ok(row.approvalRequest);
  const made: any = await f.run('access-preview', {
    id: 'incident-' + sha,
    expectedEvidenceSha: sha,
    sequence: row.seq,
    recordedAt: row.ts,
  });
  assert.equal(made.task.id, selected.id);
  assert.equal(made.operation.kind, 'read-target');
});

test('hard catalog bound reports lookup limit rather than absence; verified journal still inspects its known native ID', async (t) => {
  const f = await fixture(t),
    names = Array.from({ length: 8193 }, (_, index) => 'bounded-' + String(index).padStart(5, '0'));
  for (let index = 0; index < names.length; index += 64)
    await Promise.all(
      names
        .slice(index, index + 64)
        .map((name) => mkdir(join(f.home, 'tasks', name), { mode: 0o700 })),
    );
  const catalog = await captureTaskCatalog(f.options);
  assert.equal(catalog.limited, true);
  assert.equal(catalog.names.length, 8192);
  const omitted = names.find((name) => !catalog.names.includes(name))!,
    selected = await f.permit(omitted);
  await assert.rejects(
    f.run('page', { id: selected.id, expectedPermitSha256: selected.expectedPermitSha256 }),
    { message: 'task-lookup-limit' },
  );
  await assert.rejects(
    f.run('preview', { id: selected.id, expectedPermitSha256: selected.expectedPermitSha256 }),
    { message: 'task-lookup-limit' },
  );
  const path = join(f.home, 'audit.jsonl');
  await new AuditLog(path, () => new Date(now)).append({
    sessionId: selected.body.sessionId!,
    taskId: selected.body.taskId,
    phase: 'pre',
    tool: 'Read',
    summary: 'fixture',
    classes: [],
    decision: { effect: 'deny', ruleId: 'task-scope-read', reason: 'fixture' },
    scope: { kind: 'scope', ruleId: 'task-scope-read' },
  });
  const raw = (await readFile(path, 'utf8')).trimEnd(),
    row = JSON.parse(raw),
    sha = hash(raw);
  const report: any = await f.run('incident', {
    id: 'incident-' + sha,
    expectedEvidenceSha: sha,
    sequence: row.seq,
    recordedAt: row.ts,
  });
  assert.equal(report.status, 'matched');
  assert.equal(report.task.id, selected.id);
});
