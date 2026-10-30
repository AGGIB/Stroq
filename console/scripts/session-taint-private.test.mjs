import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';
import { runtimeDigest } from './runtime-digest.mjs';

const repository = join(import.meta.dirname, '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-taint-private-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    worker: join(import.meta.dirname, 'session-taint-worker.ts'),
    store: join(import.meta.dirname, 'session-taint-store.ts'),
    core: join(repository, 'packages/core/src/index.ts'),
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
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
  banner: {
    js: "import{createRequire as createFixtureRequire}from'node:module';const require=createFixtureRequire(import.meta.url);",
  },
});
const worker = await import(pathToFileURL(join(output, 'worker.mjs')).href);
const store = await import(pathToFileURL(join(output, 'store.mjs')).href);
const core = await import(pathToFileURL(join(output, 'core.mjs')).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-taint-private-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq'),
    runtime = join(root, 'runtime');
  for (const path of [project, userHome, home, runtime]) await mkdir(path, { mode: 0o700 });
  const paths = { cli: join(runtime, 'inert.js'), package: join(runtime, 'package.json') };
  await writeFile(paths.cli, '/* inert digest fixture; never executed */\n');
  await writeFile(paths.package, '{"version":"0.28.0"}\n');
  const session = 'PRIVATE_REVIEW_SESSION',
    sessions = new core.FileSessionStore(join(home, 'sessions'));
  await sessions.markSuspect(session, {
    tool: 'Read',
    source: 'PRIVATE_REVIEW_SOURCE',
    at: new Date().toISOString(),
    ruleIds: ['INERT'],
  });
  const provenance = new core.FileProvenanceStore(join(home, 'sessions'));
  await provenance.record(session, [
    {
      tool: 'Read',
      source: 'PRIVATE_PROVENANCE',
      kind: 'pkg',
      hash: 'a'.repeat(64),
      excerpt: 'PRIVATE_EXCERPT',
      suspect: true,
    },
  ]);
  const journal = join(home, 'audit.jsonl');
  const row = await new core.AuditLog(journal).append({
    sessionId: session,
    phase: 'post',
    tool: 'Read',
    summary: 'PRIVATE_SUMMARY',
    scan: { verdict: 'suspect', score: 0.8, ruleIds: ['INERT'] },
  });
  const raw = (await readFile(journal, 'utf8')).trimEnd();
  const selected = {
    id: `incident-${hash(raw)}`,
    expectedEvidenceSha: hash(raw),
    sequence: row.seq,
    recordedAt: row.ts,
  };
  const roots = { project: await rootIdentity(project), user: await rootIdentity(userHome) };
  const options = {
    project,
    userHome,
    home,
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    roots,
    rootBindings: roots,
    engineVersion: '0.28.0',
    runtimeSha256: await runtimeDigest(paths),
    deadline: Date.now() + 25000,
  };
  const run = (operation, input = {}, extra = {}, fault) =>
    worker.runSessionTaintWorker(
      operation,
      input,
      {
        ...options,
        now: new Date().toISOString(),
        configurationLockHeld: ['taint-apply', 'taint-recheck'].includes(operation),
        commitGuard: { runtimePaths: paths, expiresAt: extra.expiresAt ?? null },
        ...extra,
      },
      fault,
    );
  const measured = await run('taint-inspect', selected),
    at = Date.now(),
    expiresAt = at + 120000;
  const preview = await run(
    'taint-preview',
    {
      ...selected,
      expectedRevisionSha256: measured.revisionSha256,
      recordId: randomUUID(),
      previewId: randomUUID(),
      expiresAt,
    },
    { now: new Date(at).toISOString(), expiresAt },
  );
  let reached = false;
  await assert.rejects(
    run(
      'taint-apply',
      {
        plan: preview.plan,
        confirmation: {
          weakensRestrictions: true,
          recoveryRetention: true,
          previewId: preview.report.id,
        },
      },
      { expiresAt },
      (stage) => {
        if (stage === 'after-intent') {
          reached = true;
          throw Error('fixture-before-publication');
        }
      },
    ),
  );
  assert(reached, 'Actual guarded writer reached durable prepared intent');
  const path = join(home, 'console/session-taint', preview.plan.recordId + '.json');
  const native = join(home, 'sessions', core.sessionKey(session) + '.json');
  assert.equal((await store.readTaintHistory(options)).records[0].entry.status, 'prepared');
  return { root, home, native, path, options, run, preview, sessions, provenance, session };
}

for (const contradiction of [
  'native-directory-path',
  'binding-root',
  'binding-selection',
  'missing-provenance',
  'staged-pin',
  'unpublished-cleared',
  'audit-of-another-clear',
  'audit-unconfirmed',
]) {
  test(`private recovery refuses ${contradiction} before granting any history or recheck authority`, async (t) => {
    const f = await fixture(t),
      original = await readFile(f.native),
      record = JSON.parse(await readFile(f.path, 'utf8'));
    if (contradiction === 'native-directory-path')
      record.binding.native.directory.path = join(f.root, 'outside');
    if (contradiction === 'binding-root')
      record.binding.root.projectPin.ino = String(BigInt(record.binding.root.projectPin.ino) + 1n);
    if (contradiction === 'binding-selection')
      record.binding.selection.expectedEvidenceSha = 'f'.repeat(64);
    if (contradiction === 'missing-provenance') delete record.binding.provenance;
    if (contradiction === 'staged-pin') record.staged.pin.unrecognized = 'must refuse';
    if (contradiction === 'unpublished-cleared') record.status = 'cleared';
    const audit = {
      sessionId: record.binding.sessionId,
      beforeSha256: record.binding.native.sha256,
      afterSha256: record.staged.sha256,
      at: record.createdAt,
      confirmation: { weakensRestrictions: true, recoveryRetention: true, previewId: randomUUID() },
    };
    if (contradiction === 'audit-of-another-clear')
      record.audit = { ...audit, afterSha256: 'f'.repeat(64) };
    if (contradiction === 'audit-unconfirmed')
      record.audit = {
        ...audit,
        confirmation: { ...audit.confirmation, recoveryRetention: false },
      };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    await writeFile(f.path, bytes, { mode: 0o600 });
    await assert.rejects(store.readTaintHistory(f.options), /history-unavailable/);
    await assert.rejects(
      f.run(
        'taint-recheck',
        { recordId: f.preview.plan.recordId },
        { expiresAt: Date.now() + 120000 },
      ),
      /history-unavailable/,
    );
    assert.deepEqual(
      await readFile(f.native),
      original,
      'No native change or adoption from malformed recovery',
    );
    assert.deepEqual(
      await readFile(f.path),
      bytes,
      'Passive history never repairs malformed authority',
    );
  });
}

test('a historical unchanged result survives later normal taint input without invalidating the whole history', async (t) => {
  const f = await fixture(t);
  const receipt = await f.run(
    'taint-recheck',
    { recordId: f.preview.plan.recordId },
    { expiresAt: Date.now() + 120000 },
  );
  assert.equal(receipt.record.status, 'unchanged');
  assert.equal(receipt.writeConfirmed, false);
  await f.sessions.markSuspect(f.session, {
    tool: 'Read',
    source: 'NEW_INPUT',
    at: new Date().toISOString(),
    ruleIds: ['NEW'],
  });
  const before = await readFile(f.native),
    state = await f.run('taint-state');
  assert.equal(state.records[0].status, 'unchanged', 'Original observation remains historical');
  assert.equal(state.records[0].current.taint.sources, 2, 'Fresh state reports the later input');
  assert.notEqual(state.records[0].current.taint.sha256, state.records[0].before.taint.sha256);
  assert.deepEqual(await readFile(f.native), before);
});
