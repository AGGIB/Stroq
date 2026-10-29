import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-incident-build-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'fixture.ts'),
  `export {generateKeyPair,signPermit,AuditLog,DEFAULT_POLICY,FilePermitStore} from '${repository}/packages/core/src/index.ts';export {policySha256} from '${repository}/packages/cli/src/policy/digest.ts';`,
);
await build({
  entry: {
    worker: join(repository, 'console/scripts/task-lock-worker.ts'),
    fixture: join(output, 'fixture.ts'),
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
    js: "import { createRequire as createIncidentTaskRequire } from 'node:module'; const require = createIncidentTaskRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const engine = await import(pathToFileURL(join(output, 'worker.mjs')).href);
const core = await import(pathToFileURL(join(output, 'fixture.mjs')).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const now = '2026-10-23T12:00:00.000Z',
  eventAt = '2026-10-23T11:55:00.000Z';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-incident-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(join(home, 'tasks'), { recursive: true, mode: 0o700 });
  await mkdir(join(home, 'keys'), { mode: 0o700 });
  const keys = core.generateKeyPair();
  await writeFile(
    join(home, 'keys/permit.pub'),
    keys.publicKey.export({ format: 'pem', type: 'spki' }),
    { mode: 0o644 },
  );
  const identity = async (path) => {
    const info = await lstat(path);
    return { path, dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
  };
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
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
  const body = {
    v: 1,
    taskId: 'recorded-task',
    nonce: 'PRIVATE_NONCE_0123456789',
    host: 'claude-code',
    profile: 'repo-edit-and-test',
    mode: 'srt',
    projectRoot: project,
    sessionId: 'PRIVATE_SESSION',
    issuedAt: '2026-10-23T11:50:00.000Z',
    expiresAt: '2026-10-23T12:30:00.000Z',
    policyDigest: core.policySha256(core.DEFAULT_POLICY),
    stateDigests: {},
    scope: {
      tools: ['Read', 'Write', 'Bash'],
      read: { allow: [project + '/**'], deny: [] },
      write: { allow: [project + '/src/**'], deny: [] },
      net: { mode: 'none' },
      mcp: [],
      shell: 'allowed',
    },
    screenDigest: 'b'.repeat(64),
  };
  async function permit(overrides = {}) {
    const selected = { ...body, ...overrides };
    const path = join(home, 'tasks', selected.taskId, 'permit.json');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const text = JSON.stringify(core.signPermit(selected, keys.privateKey));
    await writeFile(path, text, { mode: 0o600 });
    return { path, text, body: selected, sha256: hash(text) };
  }
  const journalFile = join(home, 'audit.jsonl');
  async function append(extra = {}, at = eventAt) {
    await new core.AuditLog(journalFile, () => new Date(at)).append({
      sessionId: body.sessionId,
      taskId: body.taskId,
      phase: 'pre',
      tool: 'Bash',
      summary: 'PRIVATE_COMMAND',
      classes: ['shell.network'],
      decision: { effect: 'deny', ruleId: 'PRIVATE_RULE', reason: 'PRIVATE_REASON' },
      scope: { kind: 'scope', ruleId: 'task-scope-network' },
      ...extra,
    });
    const raw = (await readFile(journalFile, 'utf8')).trimEnd().split('\n').at(-1),
      entry = JSON.parse(raw),
      sha = hash(raw);
    return {
      id: 'incident-' + sha,
      expectedEvidenceSha: sha,
      sequence: entry.seq,
      recordedAt: entry.ts,
    };
  }
  const call = (input, fault) =>
    engine.runTaskLockWorker({ operation: 'incident', input, options }, fault ? { fault } : {});
  async function thread(input) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: { operation: 'incident', input, options },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return new Promise((resolveRun, reject) => {
      worker.once('message', async (value) => {
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
    body,
    keys,
    permit,
    append,
    journalFile,
    call,
    thread,
  };
}

test('exact selected raw finding relates only to the fresh signed task and keeps historical revision unrecorded', async (t) => {
  const f = await fixture(t),
    permit = await f.permit(),
    input = await f.append();
  const message = await f.thread(input);
  assert.equal(message.type, 'result');
  const report = message.result;
  assert.equal(report.status, 'matched');
  assert.equal(report.relation, 'task-id-only');
  assert.equal(report.historicalPermitRelation, 'not-recorded');
  assert.equal(report.sessionRelation, 'matches');
  assert.equal(report.task.permitSha256, permit.sha256);
  assert.equal(report.journal.status, 'verified');
  assert.equal(report.task.evidence.journalSha256, report.journal.sha256);
  assert.deepEqual(report.incident, {
    id: input.id,
    evidenceSha256: input.expectedEvidenceSha,
    sequence: input.sequence,
    recordedAt: input.recordedAt,
  });
  const serialized = JSON.stringify(report);
  for (const privateValue of [
    f.body.taskId,
    f.body.nonce,
    f.body.sessionId,
    f.project,
    f.home,
    'PRIVATE_COMMAND',
    'PRIVATE_RULE',
    'PRIVATE_REASON',
  ])
    assert.ok(!serialized.includes(privateValue));
});

test('missing task IDs, malformed/sentinel references and missing current permits are distinct', async (t) => {
  for (const reference of ['absent', null, 42, 'invalid', '../escape', 'missing-task']) {
    const f = await fixture(t);
    await f.permit();
    const input = await f.append(
      reference === 'absent' ? { taskId: undefined } : { taskId: reference },
    );
    const report = await f.call(input);
    assert.equal(
      report.status,
      reference === 'absent'
        ? 'not-recorded'
        : reference === 'missing-task'
          ? 'permit-unavailable'
          : 'invalid-reference',
    );
    assert.equal(report.task, null);
    assert.equal(report.relation, 'none');
  }
});

test('foreign workspace, mismatched session and out-of-window evidence never return a linked task row', async (t) => {
  for (const variant of ['workspace', 'session', 'time']) {
    const f = await fixture(t);
    await f.permit(
      variant === 'workspace'
        ? { projectRoot: '/another/workspace' }
        : variant === 'session'
          ? { sessionId: 'different-session' }
          : { issuedAt: '2026-10-23T11:56:01.000Z' },
    );
    const report = await f.call(await f.append());
    assert.equal(
      report.status,
      { workspace: 'different-workspace', session: 'session-mismatch', time: 'time-mismatch' }[
        variant
      ],
    );
    assert.equal(report.task, null);
    assert.equal(report.relation, 'none');
  }
});

test('legacy sessions remain unavailable and expiry/terminal standing do not invent historical revision proof', async (t) => {
  const f = await fixture(t);
  await f.permit({ sessionId: undefined, expiresAt: '2026-10-23T11:59:00.000Z' });
  await writeFile(join(f.home, 'tasks/recorded-task/revoked'), '');
  const report = await f.call(await f.append());
  assert.equal(report.status, 'matched');
  assert.equal(report.sessionRelation, 'unavailable');
  assert.equal(report.task.eligibility, 'expired');
  assert.equal(report.task.standing, 'revoked');
  assert.equal(report.historicalPermitRelation, 'not-recorded');
});

test('replacement signed before lookup may relate by ID but never establishes the old nonce or scope revision', async (t) => {
  const f = await fixture(t);
  await f.permit();
  const input = await f.append();
  const replacement = await f.permit({
    nonce: 'NEW_NONCE_0123456789',
    scope: { ...f.body.scope, shell: 'denied' },
  });
  const report = await f.call(input);
  assert.equal(report.status, 'matched');
  assert.equal(report.task.permitSha256, replacement.sha256);
  assert.equal(report.task.scope.shell, 'denied');
  assert.equal(report.historicalPermitRelation, 'not-recorded');
});

test('post content flags are supported; outcome/allow/nonfinding and mismatched selection cannot become task relations', async (t) => {
  const f = await fixture(t);
  await f.permit();
  const post = await f.append({
    phase: 'post',
    decision: undefined,
    scan: { verdict: 'suspect', score: 0.9, ruleIds: [] },
  });
  assert.equal((await f.call(post)).status, 'matched');
  for (const extra of [
    { outcome: 'failed' },
    { decision: { effect: 'allow', ruleId: null, reason: 'ordinary' } },
    { phase: 'post', decision: undefined, scan: { verdict: 'clean', score: 0.1, ruleIds: [] } },
  ]) {
    const input = await f.append(extra);
    await assert.rejects(f.call(input), { message: 'stale-evidence' });
  }
  await assert.rejects(f.call({ ...post, sequence: post.sequence + 1 }), {
    message: 'stale-evidence',
  });
  await assert.rejects(f.call({ ...post, recordedAt: now }), { message: 'stale-evidence' });
});

test('valid appends retain exact selected identity and final report/evidence use the final full journal SHA', async (t) => {
  const f = await fixture(t);
  await f.permit();
  const input = await f.append();
  const first = hash(await readFile(f.journalFile));
  const report = await f.call(input, async (stage) => {
    if (stage === 'after-incident-capture')
      await f.append(
        { decision: { effect: 'allow', ruleId: null, reason: 'ordinary' } },
        '2026-10-23T11:56:00.000Z',
      );
  });
  assert.equal(report.status, 'matched');
  assert.notEqual(report.journal.sha256, first);
  assert.equal(report.journal.sha256, hash(await readFile(f.journalFile)));
  assert.equal(report.task.evidence.journalSha256, report.journal.sha256);
  assert.equal(report.task.evidence.counts.calls, 2);
});

test('same-byte replacement, truncation and prefix rewrite cannot be adopted as append-only continuity', async (t) => {
  for (const change of ['replacement', 'truncate', 'rewrite', 'metadata']) {
    const f = await fixture(t);
    await f.permit();
    await f.append({ decision: { effect: 'allow', ruleId: null, reason: 'earlier' } });
    const input = await f.append();
    await f.append({ decision: { effect: 'allow', ruleId: null, reason: 'later' } });
    await assert.rejects(
      f.call(input, async (stage) => {
        if (stage !== 'after-incident-capture') return;
        const bytes = await readFile(f.journalFile);
        if (change === 'replacement') {
          await rename(f.journalFile, join(f.base, 'old-journal'));
          await writeFile(f.journalFile, bytes, { mode: 0o600 });
        }
        if (change === 'truncate')
          await writeFile(
            f.journalFile,
            bytes.toString().split('\n').slice(0, 2).join('\n') + '\n',
          );
        if (change === 'rewrite')
          await writeFile(f.journalFile, bytes.toString().replace('{', '{ '));
        if (change === 'metadata')
          await utimes(
            f.journalFile,
            new Date('2026-10-23T01:00:00.000Z'),
            new Date('2026-10-23T01:00:00.000Z'),
          );
      }),
      { message: 'stale-evidence' },
      change,
    );
  }
});

test('a changed raw representation or partial selected line cannot retain the selected evidence SHA', async (t) => {
  for (const change of ['format', 'partial']) {
    const f = await fixture(t);
    await f.permit();
    const input = await f.append();
    const text = await readFile(f.journalFile, 'utf8');
    await writeFile(f.journalFile, change === 'format' ? text.replace('{', '{ ') : text.trimEnd());
    await assert.rejects(f.call(input), { message: 'stale-evidence' });
  }
});

test('broken, oversized and malformed task aggregate evidence are unavailable rather than matched', async (t) => {
  for (const variant of ['chain', 'limit', 'aggregate']) {
    const f = await fixture(t);
    await f.permit();
    const input = await f.append();
    if (variant === 'chain')
      await writeFile(
        f.journalFile,
        (await readFile(f.journalFile, 'utf8')).replace('PRIVATE_REASON', 'CHANGED_REASON'),
      );
    if (variant === 'limit')
      await writeFile(f.journalFile, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    if (variant === 'aggregate') await f.append({ decision: undefined });
    const report = await f.call(input);
    assert.equal(report.status, 'evidence-unavailable');
    assert.equal(report.task, null);
    assert.equal(report.journal.status, variant === 'limit' ? 'limit' : 'broken');
  }
});

test('permit/key/root drift after selection is refused without switching to a new current task', async (t) => {
  for (const drift of ['permit', 'key', 'root']) {
    const f = await fixture(t);
    const permit = await f.permit(),
      input = await f.append();
    await assert.rejects(
      f.call(input, async (stage) => {
        if (stage !== 'after-incident-capture') return;
        if (drift === 'permit') await writeFile(permit.path, permit.text + '\n');
        if (drift === 'key') await writeFile(join(f.home, 'keys/permit.pub'), 'not a key');
        if (drift === 'root') {
          await rename(f.project, join(f.base, 'old-project'));
          await mkdir(f.project, { mode: 0o700 });
        }
      }),
      { message: 'preview-stale' },
      drift,
    );
  }
});
