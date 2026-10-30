import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rename,
  readdir,
  rm,
  symlink,
  chmod,
  realpath,
  link,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';

const source = import.meta.dirname,
  output = await mkdtemp(join(tmpdir(), 'stroq-assessment-build-'));
test.after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    control: join(source, 'incident-assessment-control.ts'),
    lock: join(source, '../../packages/core/src/util/lock.ts'),
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
await copyFile(join(source, 'workspace-monitor-lease.mjs'), join(output, 'lease.mjs'));
await copyFile(join(source, 'agent-setup-files.mjs'), join(output, 'agent-setup-files.mjs'));
await writeFile(
  join(output, 'runtime-layout.mjs'),
  `export const runtimeLayout=()=>({core:${JSON.stringify(join(output, 'lock.mjs'))}});\n`,
);
const { acquireWorkspaceMonitorLease } = await import(
  pathToFileURL(join(output, 'lease.mjs')).href
);
const { createIncidentAssessmentService } = await import(
  pathToFileURL(join(output, 'control.mjs')).href
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-24T12:00:00.000Z';
async function fixture(t, extra = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-assessment-home-')));
  await chmod(home, 0o700);
  t.after(() => rm(home, { recursive: true, force: true }));
  const row = {
    sessionId: 'PRIVATE_SESSION',
    phase: 'pre',
    tool: 'Bash',
    summary: 'PRIVATE_COMMAND',
    classes: ['shell.network'],
    decision: { effect: 'deny', reason: 'PRIVATE_REASON' },
    seq: 1,
    ts: at,
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
  };
  const raw = JSON.stringify(row),
    path = join(home, 'audit.jsonl');
  await writeFile(path, raw + '\n', { mode: 0o600 });
  const evidenceSha = sha(raw),
    selection = { id: 'incident-' + evidenceSha, expectedEvidenceSha: evidenceSha };
  let clock = Date.parse(at);
  const options = { home, now: () => clock, acquireLease: acquireWorkspaceMonitorLease, ...extra };
  const service = await createIncidentAssessmentService(options);
  t.after(() => service.close());
  const preview = (
    assessment = 'false-positive',
    reason = 'incorrect-match',
    expectedAssessmentId = null,
  ) => service.preview({ ...selection, assessment, reason, expectedAssessmentId });
  return {
    home,
    path,
    row,
    raw,
    selection,
    options,
    service,
    preview,
    advance: (ms) => {
      clock += ms;
    },
  };
}
const ledger = (f) => join(f.home, 'console', 'incident-assessments', 'history.json');
test('actual assessment preserves source and native files, survives restart and appends reopening history', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.path);
  for (const name of ['policy.yaml', 'trust.json', 'sessions.json', 'permits.json'])
    await writeFile(join(f.home, name), 'PRIVATE_UNCHANGED_' + name, { mode: 0o600 });
  assert.deepEqual(await readdir(f.home), [
    'audit.jsonl',
    'permits.json',
    'policy.yaml',
    'sessions.json',
    'trust.json',
  ]);
  const state = await f.service.getState();
  assert.equal(state.body.history, 'missing');
  assert(!(await readdir(f.home)).includes('console'));
  const p = await f.preview();
  assert.equal(p.status, 200);
  assert(!(await readdir(f.home)).includes('console'));
  const result = await f.service.apply({ previewId: p.body.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'recorded');
  assert.equal(result.body.record.id, p.body.recordId);
  assert.equal(result.body.record.previousAssessmentId, null);
  assert.deepEqual(await readFile(f.path), before);
  for (const name of ['policy.yaml', 'trust.json', 'sessions.json', 'permits.json'])
    assert.equal(await readFile(join(f.home, name), 'utf8'), 'PRIVATE_UNCHANGED_' + name);
  const text = await readFile(ledger(f), 'utf8');
  for (const secret of ['PRIVATE_SESSION', 'PRIVATE_COMMAND', 'PRIVATE_REASON', f.home])
    assert(!text.includes(secret));
  await f.service.close();
  const next = await createIncidentAssessmentService(f.options);
  t.after(() => next.close());
  assert.equal((await next.getState()).body.records[0].id, p.body.recordId);
  f.advance(1);
  const reopen = await next.preview({
    ...f.selection,
    assessment: 'reopened',
    reason: 'reassess',
    expectedAssessmentId: p.body.recordId,
  });
  assert.equal(reopen.status, 200);
  assert.equal((await next.apply({ previewId: reopen.body.id })).status, 200);
  const history = (await next.getState()).body;
  assert.equal(history.records.length, 2);
  assert.equal(history.records[1].previousAssessmentId, p.body.recordId);
  assert.equal(history.records[0].assessment, 'false-positive');
});
test('two consoles use exact ledger CAS and cannot lose or silently overwrite assessments', async (t) => {
  const f = await fixture(t),
    other = await createIncidentAssessmentService(f.options);
  t.after(() => other.close());
  const a = await f.preview(),
    b = await other.preview({
      ...f.selection,
      assessment: 'accepted-risk',
      reason: 'controlled-test',
      expectedAssessmentId: null,
    });
  assert.equal((await f.service.apply({ previewId: a.body.id })).status, 200);
  const stale = await other.apply({ previewId: b.body.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale-assessment');
  assert.equal((await other.getState()).body.records.length, 1);
  assert.equal((await other.apply({ previewId: b.body.id })).body.error, 'preview-unavailable');
});
test('strict exact selection rejects duplicate JSON and invalid outcome while normal source append is allowed', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await writeFile(f.path, f.raw + '\n' + JSON.stringify({ ...f.row, seq: 2 }) + '\n');
  assert.equal((await f.service.apply({ previewId: p.body.id })).status, 200);
  for (const raw of [
    f.raw.replace('"effect":"deny"', '"effect":"allow","effect":"deny"'),
    JSON.stringify({ ...f.row, outcome: null }),
  ]) {
    await writeFile(f.path, raw + '\n');
    const evidence = sha(raw),
      r = await f.service.preview({
        id: 'incident-' + evidence,
        expectedEvidenceSha: evidence,
        assessment: 'false-positive',
        reason: 'incorrect-match',
        expectedAssessmentId: null,
      });
    assert.equal(r.body.error, 'stale-evidence');
  }
  assert.equal((await f.service.getState()).body.records.length, 1);
});
test('source replacement and same-byte ledger replacement refuse instead of adopting foreign physical evidence', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await rename(f.path, f.path + '.old');
  await writeFile(f.path, f.raw + '\n', { mode: 0o600 });
  assert.equal((await f.service.apply({ previewId: p.body.id })).body.error, 'stale-evidence');
  const good = await f.preview();
  assert.equal((await f.service.apply({ previewId: good.body.id })).status, 200);
  const next = await f.preview('accepted-risk', 'controlled-test', good.body.recordId),
    bytes = await readFile(ledger(f));
  await rename(ledger(f), ledger(f) + '.old');
  await writeFile(ledger(f), bytes, { mode: 0o600 });
  await rm(ledger(f) + '.old');
  assert.equal((await f.service.apply({ previewId: next.body.id })).body.error, 'stale-assessment');
});
for (const stage of ['before-publish', 'after-publish', 'before-readback'])
  test(`fault ${stage} retains an honest exact recheck without replay`, async (t) => {
    let armed = false;
    const f = await fixture(t, {
        fault: async (at) => {
          if (armed && at === stage) throw Error('PRIVATE_FAULT');
        },
      }),
      p = await f.preview();
    armed = true;
    const written = await f.service.apply({ previewId: p.body.id });
    assert.notEqual(written.status, 200);
    if (stage !== 'before-publish') assert.equal(written.body.error, 'write-unconfirmed');
    armed = false;
    const checked = await f.service.recheck({
      recordId: p.body.recordId,
      expectedEvidenceSha: f.selection.expectedEvidenceSha,
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.status, stage === 'before-publish' ? 'not-present' : 'recorded');
    assert.equal(
      (await f.service.getState()).body.records.length,
      stage === 'before-publish' ? 0 : 1,
    );
    assert.equal(
      (await f.service.apply({ previewId: p.body.id })).body.error,
      'preview-unavailable',
    );
  });
test('expired and consumed previews, unchanged decisions, premature reopen and backward clocks refuse', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.preview('reopened', 'reassess')).body.error, 'stale-assessment');
  const expired = await f.preview();
  f.advance(120000);
  assert.equal(
    (await f.service.apply({ previewId: expired.body.id })).body.error,
    'preview-expired',
  );
  const p = await f.preview();
  assert.equal((await f.service.apply({ previewId: p.body.id })).status, 200);
  assert.equal(
    (await f.preview('false-positive', 'incorrect-match', p.body.recordId)).body.error,
    'assessment-unchanged',
  );
  f.advance(-1);
  assert.equal(
    (await f.preview('accepted-risk', 'controlled-test', p.body.recordId)).body.error,
    'clock-unavailable',
  );
});
test('malformed private storage and unsafe paths refuse read-only without destroying history', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.service.apply({ previewId: p.body.id });
  const bytes = await readFile(ledger(f));
  await writeFile(ledger(f), '{broken');
  const state = await f.service.getState();
  assert.equal(state.body.history, 'unavailable');
  assert.deepEqual(state.body.records, []);
  assert.equal((await f.preview()).body.error, 'history-unavailable');
  await writeFile(ledger(f), bytes);
  await chmod(ledger(f), 0o644);
  assert.equal((await f.service.getState()).body.history, 'unavailable');
  await chmod(ledger(f), 0o600);
  await rename(ledger(f), ledger(f) + '.safe');
  await symlink(ledger(f) + '.safe', ledger(f));
  assert.equal((await f.service.getState()).body.history, 'unavailable');
  assert.deepEqual(await readFile(ledger(f) + '.safe'), bytes);
});
test('recheck refuses absence while the same-service candidate is actively publishing', async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r)),
    barrier = new Promise((r) => (release = r));
  const f = await fixture(t, {
      fault: async (stage) => {
        if (stage === 'before-publish') {
          entered();
          await barrier;
        }
      },
    }),
    p = await f.preview(),
    operation = f.service.apply({ previewId: p.body.id });
  await ready;
  assert.equal(
    (
      await f.service.recheck({
        recordId: p.body.recordId,
        expectedEvidenceSha: f.selection.expectedEvidenceSha,
      })
    ).body.error,
    'busy',
  );
  release();
  assert.equal((await operation).status, 200);
});
test('a real foreign lease blocks apply and absence recheck while GET stays passive', async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r)),
    barrier = new Promise((r) => (release = r));
  const f = await fixture(t, {
    fault: async (stage) => {
      if (stage === 'before-publish') {
        entered();
        await barrier;
      }
    },
  });
  const other = await createIncidentAssessmentService({ ...f.options, fault: undefined });
  t.after(() => other.close());
  const a = await f.preview(),
    b = await other.preview({
      ...f.selection,
      assessment: 'accepted-risk',
      reason: 'controlled-test',
      expectedAssessmentId: null,
    }),
    operation = f.service.apply({ previewId: a.body.id });
  await ready;
  const names = await readdir(join(f.home, 'console', 'incident-assessments'));
  assert.equal((await other.getState()).body.records.length, 0);
  assert.deepEqual(await readdir(join(f.home, 'console', 'incident-assessments')), names);
  assert.equal((await other.apply({ previewId: b.body.id })).body.error, 'busy');
  assert.equal(
    (
      await other.recheck({
        recordId: a.body.recordId,
        expectedEvidenceSha: f.selection.expectedEvidenceSha,
      })
    ).body.error,
    'busy',
  );
  release();
  assert.equal((await operation).status, 200);
  assert.equal((await other.getState()).body.records[0].id, a.body.recordId);
});
test('512 valid append events remain readable at capacity without eviction or another write', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.service.apply({ previewId: p.body.id });
  const body = JSON.parse(await readFile(ledger(f), 'utf8')),
    first = body.records[0];
  for (let i = 1; i < 512; i++)
    body.records.push({
      ...first,
      id: randomUUID(),
      assessment: i % 2 ? 'accepted-risk' : 'false-positive',
      reason: i % 2 ? 'controlled-test' : 'incorrect-match',
      previousAssessmentId: body.records.at(-1).id,
    });
  const bytes = Buffer.from(JSON.stringify(body) + '\n');
  await writeFile(ledger(f), bytes);
  const state = await f.service.getState();
  assert.equal(state.body.history, 'ready');
  assert.equal(state.body.records.length, 512);
  assert.equal(state.body.canRecord, false);
  assert.equal(state.body.error, 'store-full');
  assert.equal(
    (await f.preview('confirmed-issue', 'suspicious-content', body.records.at(-1).id)).body.error,
    'store-full',
  );
  assert.deepEqual(await readFile(ledger(f)), bytes);
});
test('32 bounded orphan stages consume capacity but never gain authority or disappear on reads', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.service.apply({ previewId: p.body.id });
  const dir = join(f.home, 'console', 'incident-assessments');
  const names = Array.from({ length: 32 }, () => `.stroq-${randomUUID()}.tmp`);
  for (const name of names) await writeFile(join(dir, name), '', { mode: 0o600 });
  const before = await readdir(dir),
    state = await f.service.getState();
  assert.equal(state.body.history, 'ready');
  assert.equal(state.body.records.length, 1);
  assert.equal(state.body.canRecord, false);
  assert.equal(state.body.error, 'store-full');
  assert.equal(
    (await f.preview('accepted-risk', 'controlled-test', p.body.recordId)).body.error,
    'store-full',
  );
  assert.deepEqual(await readdir(dir), before);
  assert.equal(
    (
      await f.service.recheck({
        recordId: p.body.recordId,
        expectedEvidenceSha: f.selection.expectedEvidenceSha,
      })
    ).body.status,
    'recorded',
  );
});
test('actual retained byte capacity refuses publication while complete earlier history remains usable', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  await f.service.apply({ previewId: p.body.id });
  const dir = join(f.home, 'console', 'incident-assessments'),
    bytes = await readFile(ledger(f));
  for (const length of [512 * 1024, 1024 * 1024 - 512 * 1024 - bytes.length - 1])
    await writeFile(join(dir, `.stroq-${randomUUID()}.tmp`), Buffer.alloc(length), { mode: 0o600 });
  const state = await f.service.getState();
  assert.equal(state.body.history, 'ready');
  assert.equal(state.body.canRecord, false);
  assert.equal(state.body.records.length, 1);
  assert.equal(
    (await f.preview('accepted-risk', 'controlled-test', p.body.recordId)).body.error,
    'store-full',
  );
  assert.deepEqual(await readFile(ledger(f)), bytes);
});
test('a successful atomic writer cannot fabricate success when independent readback no longer contains its record', async (t) => {
  let f;
  f = await fixture(t, {
    fault: async (stage) => {
      if (stage === 'before-readback') {
        const body = JSON.parse(await readFile(ledger(f), 'utf8'));
        await writeFile(ledger(f), JSON.stringify({ ...body, records: [] }) + '\n');
      }
    },
  });
  const p = await f.preview(),
    result = await f.service.apply({ previewId: p.body.id });
  assert.equal(result.body.error, 'write-unconfirmed');
  const checked = await f.service.recheck({
    recordId: p.body.recordId,
    expectedEvidenceSha: f.selection.expectedEvidenceSha,
  });
  assert.equal(checked.body.status, 'not-present');
  assert.equal((await f.service.getState()).body.records.length, 0);
});
test('previews stay bounded and close fences all retained mutation callbacks', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.preview()).status, 200);
  assert.equal((await f.preview()).body.error, 'busy');
  const another = await fixture(t),
    p = await another.preview();
  await another.service.close();
  assert.equal(
    (await another.service.apply({ previewId: p.body.id })).body.error,
    'server-stopped',
  );
  assert(!(await readdir(another.home)).includes('console'));
});
test('a malformed recognized apply consumes its preview instead of allowing a repaired retry', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  assert.equal((await f.service.apply({ previewId: p.body.id, extra: true })).status, 400);
  assert.equal((await f.service.apply({ previewId: p.body.id })).body.error, 'preview-unavailable');
  assert(!(await readdir(f.home)).includes('console'));
});
test('a backwards clock after preview or while staging refuses before publication', async (t) => {
  for (const stage of ['after-preview', 'before-publish']) {
    let f;
    f = await fixture(t, {
      fault: async (point) => {
        if (stage === point) f.advance(-1);
      },
    });
    const p = await f.preview();
    if (stage === 'after-preview') f.advance(-1);
    const result = await f.service.apply({ previewId: p.body.id });
    assert.equal(result.body.error, 'clock-unavailable');
    assert.equal((await f.service.getState()).body.records.length, 0);
  }
});

test('exact selection accepts scalar Unicode session text but refuses unpaired surrogate evidence', async (t) => {
  for (const sessionId of ['PRIVATE_\u{1f512}', 'PRIVATE_\ud800', 'PRIVATE_\udfff']) {
    const f = await fixture(t),
      raw = JSON.stringify({ ...f.row, sessionId }),
      expectedEvidenceSha = sha(raw);
    await writeFile(f.path, raw + '\n');
    const result = await f.service.preview({
      id: `incident-${expectedEvidenceSha}`,
      expectedEvidenceSha,
      expectedAssessmentId: null,
      assessment: 'accepted-risk',
      reason: 'controlled-test',
    });
    if (sessionId === 'PRIVATE_\u{1f512}') {
      assert.equal(result.status, 200);
      const saved = await f.service.apply({ previewId: result.body.id });
      assert.equal(saved.status, 200);
      assert.equal(JSON.stringify(saved.body).includes(sessionId), false);
    } else {
      assert.equal(result.body.error, 'stale-evidence');
      assert.equal((await readdir(f.home)).includes('console'), false);
    }
  }
});

test('hard-linked audit evidence or assessment history never gains write authority', async (t) => {
  const source = await fixture(t);
  await link(source.path, join(source.home, 'source-second-link'));
  assert.equal((await source.preview()).body.error, 'stale-evidence');
  assert.equal((await readdir(source.home)).includes('console'), false);
  const stored = await fixture(t),
    first = await stored.preview(),
    saved = await stored.service.apply({ previewId: first.body.id }),
    original = await readFile(ledger(stored));
  assert.equal(saved.status, 200);
  await link(ledger(stored), join(stored.home, 'history-second-link'));
  const state = await stored.service.getState();
  assert.equal(state.body.history, 'unavailable');
  assert.equal(state.body.canRecord, false);
  assert.equal(
    (await stored.preview('reopened', 'reassess', saved.body.record.id)).body.error,
    'history-unavailable',
  );
  assert.deepEqual(await readFile(ledger(stored)), original);
});
