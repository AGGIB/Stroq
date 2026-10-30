import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  rename,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';
import { runtimeDigest } from './runtime-digest.mjs';
const root = join(import.meta.dirname, '../..'),
  output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-taint-worker-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    taint: join(import.meta.dirname, 'session-taint-worker.ts'),
    core: join(root, 'packages/core/src/index.ts'),
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
  esbuildOptions(o) {
    o.alias = { '@stroq/core': join(root, 'packages/core/src/index.ts') };
  },
  banner: {
    js: "import{createRequire as createFixtureRequire}from'node:module';const require=createFixtureRequire(import.meta.url);",
  },
});
const worker = await import(pathToFileURL(join(output, 'taint.mjs')).href),
  core = await import(pathToFileURL(join(output, 'core.mjs')).href);
const hash = (b) => createHash('sha256').update(b).digest('hex');
/** The person's two acknowledgements on a preview, as control hands them to the clear. */
const confirmationOf = (p) => ({
  weakensRestrictions: true,
  recoveryRetention: true,
  previewId: p.report.id,
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-taint-worker-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq'),
    cli = join(base, 'cli');
  for (const path of [project, userHome, home, cli]) await mkdir(path, { mode: 0o700 });
  const paths = { cli: join(cli, 'index.js'), package: join(base, 'package.json') };
  await writeFile(paths.cli, '/* inert runtime */\n');
  await writeFile(paths.package, '{"version":"0.28.0"}\n');
  const sessions = new core.FileSessionStore(join(home, 'sessions')),
    provenance = new core.FileProvenanceStore(join(home, 'sessions')),
    session = 'PRIVATE_NATIVE_SESSION_ID';
  await sessions.markSuspect(session, {
    tool: 'Read',
    source: 'PRIVATE_NATIVE_SOURCE',
    at: new Date().toISOString(),
    ruleIds: ['FIXTURE'],
  });
  await provenance.record(session, [
    {
      tool: 'Read',
      source: 'PRIVATE_PROV_SOURCE',
      kind: 'pkg',
      hash: 'a'.repeat(64),
      excerpt: 'PRIVATE_EXCERPT',
      suspect: true,
    },
  ]);
  const row = await new core.AuditLog(join(home, 'audit.jsonl')).append({
    sessionId: session,
    phase: 'post',
    tool: 'Read',
    summary: 'PRIVATE_SUMMARY',
    scan: { verdict: 'suspect', score: 0.8, ruleIds: ['FIXTURE'] },
  });
  const raw = (await readFile(join(home, 'audit.jsonl'), 'utf8')).trimEnd();
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
  async function run(operation, input = {}, extra = {}, fault) {
    return worker.runSessionTaintWorker(
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
  }
  async function preview() {
    const report = await run('taint-inspect', selected),
      at = Date.now(),
      expiresAt = at + 120000;
    return run(
      'taint-preview',
      {
        ...selected,
        expectedRevisionSha256: report.revisionSha256,
        recordId: randomUUID(),
        previewId: randomUUID(),
        expiresAt,
      },
      { now: new Date(at).toISOString(), expiresAt },
    );
  }
  return {
    base,
    project,
    userHome,
    home,
    session,
    sessions,
    provenance,
    selected,
    options,
    paths,
    run,
    preview,
  };
}
test('actual native clear retains exact provenance/audit and returns current source-bound durable evidence without raw identifiers', async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    beforeAudit = await readFile(join(f.home, 'audit.jsonl')),
    provPath = join(f.home, 'sessions', core.sessionKey(f.session) + '.prov.json'),
    beforeProv = await readFile(provPath);
  const receipt = await f.run(
    'taint-apply',
    { plan: p.plan, confirmation: confirmationOf(p) },
    { expiresAt: p.plan.expiresAt },
  );
  assert.equal(receipt.writeConfirmed, true);
  assert.equal(receipt.record.status, 'cleared');
  assert.equal(receipt.record.current.taint.status, 'clear');
  assert.equal(receipt.record.preservedProvenanceSha256, p.report.inspection.provenance.sha256);
  assert.deepEqual(await readFile(provPath), beforeProv);
  assert.deepEqual(await readFile(join(f.home, 'audit.jsonl')), beforeAudit);
  assert.equal((await f.sessions.get(f.session)).taint, null);
  const history = await f.run('taint-state');
  assert.equal(history.records[0].status, 'cleared');
  const publicText = JSON.stringify([p.report, receipt, history]);
  for (const secret of [
    f.session,
    f.home,
    'PRIVATE_NATIVE_SOURCE',
    'PRIVATE_EXCERPT',
    'PRIVATE_SUMMARY',
  ])
    assert(!publicText.includes(secret));
});
test('a newer native mark invalidates preview instead of clearing either source', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.sessions.markSuspect(f.session, {
    tool: 'new',
    ruleIds: ['NEW'],
    at: new Date().toISOString(),
  });
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
    ),
    /stale-state/,
  );
  assert.equal((await f.sessions.get(f.session)).taint.sources.length, 2);
  assert.equal((await f.run('taint-state')).history, 'missing');
});
for (const crash of ['after-intent', 'after-rename'])
  test(`explicit recheck resolves own ${crash} interruption without another native write`, async (t) => {
    const f = await fixture(t),
      p = await f.preview();
    await assert.rejects(
      f.run(
        'taint-apply',
        { plan: p.plan, confirmation: confirmationOf(p) },
        { expiresAt: p.plan.expiresAt },
        (stage) => {
          if (stage === crash) throw new Error('fixture-crash');
        },
      ),
    );
    const state = await f.run('taint-state');
    assert.equal(state.records[0].status, 'prepared');
    const path = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
      before = await readFile(path);
    const receipt = await f.run(
      'taint-recheck',
      { recordId: p.plan.recordId },
      { expiresAt: Date.now() + 120000 },
    );
    assert.equal(receipt.record.status, crash === 'after-intent' ? 'unchanged' : 'cleared');
    assert.equal(receipt.writeConfirmed, crash === 'after-rename');
    assert.deepEqual(await readFile(path), before);
  });
test('a same-byte foreign clean inode cannot be adopted as our interrupted publication', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
      (stage) => {
        if (stage === 'after-rename') throw new Error('fixture-crash');
      },
    ),
  );
  const path = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
    bytes = await readFile(path);
  await rename(path, path + '.old');
  await writeFile(path, bytes, { mode: 0o600 });
  const receipt = await f.run(
    'taint-recheck',
    { recordId: p.plan.recordId },
    { expiresAt: Date.now() + 120000 },
  );
  assert.equal(receipt.writeConfirmed, false);
  assert.equal(receipt.record.status, 'uncertain');
});
test('visible pending markers refuse preview while permanent loss notes are preserved by a clear', async (t) => {
  const f = await fixture(t);
  await f.provenance.setPending(f.session, true, 'owned-operation');
  assert.equal((await f.run('taint-inspect', f.selected)).provenance.pending, 1);
  await assert.rejects(f.preview(), /session-busy/);
  await f.provenance.setPending(f.session, false, 'owned-operation');
  await f.provenance.markIncomplete(f.session);
  await f.provenance.noteDigestsLost(f.session);
  const p = await f.preview(),
    receipt = await f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
    );
  assert.equal(receipt.record.current.provenance.incomplete, true);
  assert.equal(receipt.record.current.provenance.digestsLost, true);
  assert.equal(receipt.record.current.provenance.sha256, p.report.inspection.provenance.sha256);
});
test('runtime drift and an expired private preview refuse before any native publication', async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    path = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
    before = await readFile(path);
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: { ...p.plan, expiresAt: Date.now() - 1 }, confirmation: confirmationOf(p) },
      { expiresAt: Date.now() - 1 },
    ),
    /preview-expired/,
  );
  await writeFile(f.paths.cli, '/* changed inert runtime */');
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
    ),
    /runtime-unavailable/,
  );
  assert.deepEqual(await readFile(path), before);
});
test('a broken full journal and mismatched native session identity cannot authorize a clear', async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    path = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
    before = await readFile(path);
  const journal = join(f.home, 'audit.jsonl'),
    raw = await readFile(journal);
  await writeFile(journal, Buffer.concat([raw, Buffer.from('{broken}\n')]));
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
    ),
    /evidence-unavailable/,
  );
  assert.deepEqual(await readFile(path), before);
  await writeFile(journal, raw);
  await writeFile(
    path,
    JSON.stringify({ sessionId: 'foreign', taint: null, updatedAt: new Date().toISOString() }),
  );
  await assert.rejects(f.run('taint-inspect', f.selected), /session-unavailable/);
});
test('pending owner capacity is a refusal instead of silently truncating source inspection', async (t) => {
  const f = await fixture(t),
    dir = join(f.home, 'sessions', core.sessionKey(f.session) + '.prov.pending.d');
  await mkdir(dir, { mode: 0o700 });
  for (let i = 0; i < 257; i++)
    await writeFile(join(dir, i.toString(16).padStart(16, '0')), '{}', { mode: 0o600 });
  await assert.rejects(f.run('taint-inspect', f.selected), /provenance-unavailable/);
  assert.notEqual((await f.sessions.get(f.session)).taint, null);
});
test('32 retained records can finalize beside a passive late-publication residue without automatic cleanup', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.run(
    'taint-apply',
    { plan: p.plan, confirmation: confirmationOf(p) },
    { expiresAt: p.plan.expiresAt },
  );
  const dir = join(f.home, 'console', 'session-taint'),
    original = JSON.parse(await readFile(join(dir, p.plan.recordId + '.json'), 'utf8'));
  let last;
  for (let i = 1; i < 32; i++) {
    const entry = { ...original, id: randomUUID() };
    if (i === 31) {
      entry.status = 'prepared';
      entry.published = null;
      last = entry;
    }
    await writeFile(join(dir, entry.id + '.json'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  const residue = join(dir, `.stroq-${randomUUID()}.tmp`),
    residueBytes = Buffer.from(JSON.stringify(last) + '\n');
  await writeFile(residue, residueBytes, { mode: 0o600 });
  const before = await f.run('taint-state');
  assert.equal(before.records.length, 32);
  assert.equal(before.records.find((r) => r.id === last.id).status, 'prepared');
  const checked = await f.run(
    'taint-recheck',
    { recordId: last.id },
    { expiresAt: Date.now() + 120000 },
  );
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.status, 'cleared');
  assert.deepEqual(await readFile(residue), residueBytes);
  assert.equal((await f.run('taint-state')).records.length, 32);
});
test('full bounded staging stays readable and refuses another metadata write without deleting residues', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
      (stage) => {
        if (stage === 'after-intent') throw new Error('fixture-crash');
      },
    ),
  );
  const dir = join(f.home, 'console', 'session-taint'),
    native = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
    before = await readFile(native);
  const names = Array.from({ length: 32 }, () => `.stroq-${randomUUID()}.tmp`);
  for (const name of names) await writeFile(join(dir, name), Buffer.alloc(0), { mode: 0o600 });
  assert.equal((await f.run('taint-state')).records[0].status, 'prepared');
  await assert.rejects(
    f.run('taint-recheck', { recordId: p.plan.recordId }, { expiresAt: Date.now() + 120000 }),
    /recovery-full/,
  );
  assert.deepEqual(await readFile(native), before);
  for (const name of names) assert.equal((await readFile(join(dir, name))).length, 0);
  assert.equal((await f.run('taint-state')).records[0].status, 'prepared');
});
test('a clear without both of the person’s acknowledgements on its preview is refused before any write', async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    path = join(f.home, 'sessions', core.sessionKey(f.session) + '.json'),
    before = await readFile(path);
  for (const confirmation of [
    undefined,
    { ...confirmationOf(p), weakensRestrictions: false },
    { ...confirmationOf(p), recoveryRetention: 'true' },
    { ...confirmationOf(p), previewId: 'preview' },
    { weakensRestrictions: true, recoveryRetention: true },
    { ...confirmationOf(p), acknowledgedBy: 'agent' },
  ]) {
    const input = confirmation === undefined ? { plan: p.plan } : { plan: p.plan, confirmation };
    await assert.rejects(
      f.run('taint-apply', input, { expiresAt: p.plan.expiresAt }),
      /invalid-report/,
      JSON.stringify(confirmation),
    );
  }
  assert.deepEqual(await readFile(path), before);
  assert.equal((await f.run('taint-state')).history, 'missing');
});
test('the private record of a clear holds its audit: what it replaced, what it wrote, and the confirmation', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.run(
    'taint-apply',
    { plan: p.plan, confirmation: confirmationOf(p) },
    { expiresAt: p.plan.expiresAt },
  );
  const entry = JSON.parse(
    await readFile(join(f.home, 'console', 'session-taint', p.plan.recordId + '.json'), 'utf8'),
  );
  assert.equal(entry.status, 'cleared');
  assert.deepEqual(entry.audit, {
    sessionId: entry.binding.sessionId,
    beforeSha256: entry.binding.native.sha256,
    afterSha256: entry.staged.sha256,
    at: entry.createdAt,
    confirmation: confirmationOf(p),
  });
});
// Reported 2026-10-27: the clear held the session lock while its durable intent was written, so a hook's
// concurrent mark waited, timed out, and the clear went through. The mark is made here while the intent is
// written; it would wait out the lock's timeout if the lock were held.
test('a mark made while the recovery intent is written stands, the record says unchanged, and a new preview is not held back', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await assert.rejects(
    f.run(
      'taint-apply',
      { plan: p.plan, confirmation: confirmationOf(p) },
      { expiresAt: p.plan.expiresAt },
      async (stage) => {
        if (stage === 'after-intent')
          await f.sessions.markSuspect(f.session, {
            tool: 'concurrent',
            ruleIds: ['NEW'],
            at: new Date().toISOString(),
          });
      },
    ),
    /stale-state/,
  );
  assert.deepEqual(
    (await f.sessions.get(f.session)).taint.sources.map((s) => s.tool),
    ['Read', 'concurrent'],
  );
  assert.equal((await f.run('taint-state')).records[0].status, 'unchanged');
  assert.equal((await f.preview()).report.inspection.taint.status, 'suspect');
});
