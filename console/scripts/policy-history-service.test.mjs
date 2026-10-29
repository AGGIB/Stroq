import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  chmod,
  stat,
  readdir,
  rm,
  lstat,
  rename,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createPolicyHistoryService } from './policy-history-service.mjs';
import { createPolicyCasesStore, policyCaseId } from './policy-cases-store.mjs';
import { setTimeout } from 'node:timers/promises';
import {
  buildPolicyHistoryFixture,
  policyHistoryFixture,
  restoreInput,
  restorePreview,
  hash,
} from './policy-history-test-helpers.mjs';
const built = await buildPolicyHistoryFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));

test('real candidate replay restores exact retained BOM/CRLF bytes, keeps current mode and backs up the replaced revision', async (t) => {
  const f = await policyHistoryFixture(t, built),
    beforeNames = await readdir(f.store);
  const state = await f.service.inspect();
  assert.equal(state.status, 200, JSON.stringify(state));
  assert(built.schema.validatePolicyHistoryState(state.body));
  const preview = await restorePreview(f);
  assert(built.schema.validatePolicyRestorePreview(preview));
  assert.deepEqual(preview.blockers, []);
  assert(!JSON.stringify({ state, preview }).includes('private-policy-comment'));
  assert(!JSON.stringify({ state, preview }).includes(f.home));
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
  assert.deepEqual(await readdir(f.store), beforeNames);
  for (const ack of [
    'acknowledgeSharedScope',
    'acknowledgeReducedProtection',
    'acknowledgeBackup',
  ]) {
    const input = restoreInput(preview);
    delete input[ack];
    assert.equal((await f.service.apply(input)).status, 422);
  }
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
  const result = await f.service.apply(restoreInput(preview));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert(built.schema.validatePolicyRestoreReceipt(result.body));
  assert.equal(result.body.backupId, result.body.receiptId);
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.old);
  assert.equal((await stat(join(f.home, 'policy.yaml'))).mode & 0o777, 0o640);
  assert.deepEqual(await readFile(join(f.store, `${result.body.backupId}.yaml`)), f.current);
  assert.equal((await f.service.apply(restoreInput(preview))).body.error, 'preview-expired');
  await f.service.close();
  const restarted = createPolicyHistoryService(f.options);
  t.after(() => restarted.close());
  const after = await restarted.inspect();
  assert.equal(after.status, 200);
  assert.equal(after.body.currentRawSha, hash(f.old));
  assert.equal(after.body.entries.length, 2);
});

test('explicit current-default removes only the pinned active file and a retained backup can restore from absence', async (t) => {
  const f = await policyHistoryFixture(t, built);
  const record = { ...f.record, beforeRawSha: null, backupId: null };
  await writeFile(join(f.store, `${f.id}.json`), JSON.stringify(record), { mode: 0o600 });
  await rm(join(f.store, `${f.id}.yaml`));
  const preview = await restorePreview(f);
  assert.equal(preview.target, 'current-default');
  assert.equal(preview.candidateRawSha, null);
  const applied = await f.service.apply(restoreInput(preview));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(applied.body.rawSha, null);
  assert.equal(applied.body.backupId, applied.body.receiptId);
  await assert.rejects(lstat(join(f.home, 'policy.yaml')), { code: 'ENOENT' });
  const state = await f.service.inspect(),
    entry = state.body.entries.find((r) => r.id === applied.body.receiptId);
  assert.equal(entry.afterRawSha, null);
  assert.equal(entry.recovery, 'backup');
  const next = await f.service.preview({
    entryId: entry.id,
    recordSha256: entry.recordSha256,
    expectedRawSha: null,
  });
  assert.equal(next.status, 200, JSON.stringify(next));
  const restore = await f.service.apply(restoreInput(next.body));
  assert.equal(restore.status, 200, JSON.stringify(restore));
  assert.equal(restore.body.backupId, null);
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
});

for (const kind of [
  'current-bytes',
  'current-mode',
  'same-byte-replacement',
  'backup',
  'intent',
  'runtime',
]) {
  test(`bound ${kind} drift refuses restore with no replacement or recovery write`, async (t) => {
    const f = await policyHistoryFixture(t, built),
      p = await restorePreview(f),
      file = join(f.home, 'policy.yaml');
    if (kind === 'current-bytes')
      await writeFile(file, Buffer.concat([f.current, Buffer.from('# owner edit\n')]));
    if (kind === 'current-mode') await chmod(file, 0o600);
    if (kind === 'same-byte-replacement') {
      await writeFile(join(f.home, 'owner-policy'), f.current, { mode: 0o640 });
      await rename(join(f.home, 'owner-policy'), file);
    }
    if (kind === 'backup')
      await writeFile(
        join(f.store, `${f.id}.yaml`),
        Buffer.concat([f.old, Buffer.from('# owner edit\n')]),
      );
    if (kind === 'intent')
      await writeFile(
        join(f.store, `${f.id}.json`),
        JSON.stringify({ ...f.record, appliedAt: '2026-10-24T00:00:01.000Z' }),
      );
    if (kind === 'runtime') f.setRuntime('c'.repeat(64));
    const expected = await readFile(file),
      names = await readdir(f.store),
      reply = await f.service.apply(restoreInput(p));
    assert.equal(reply.status, 409, JSON.stringify(reply));
    assert.deepEqual(await readFile(file), expected);
    assert.deepEqual(await readdir(f.store), names);
  });
}

test('unknown request fields and client candidate/path are refused without executing a replay or creating history', async (t) => {
  const f = await policyHistoryFixture(t, built),
    before = await readdir(f.store);
  for (const input of [
    { path: join(f.home, 'policy.yaml') },
    {
      entryId: f.id,
      recordSha256: 'a'.repeat(64),
      expectedRawSha: hash(f.current),
      candidateText: 'private-policy',
    },
  ])
    assert.equal((await f.service.preview(input)).status, 400);
  assert.equal((await f.service.apply({})).status, 400);
  assert.deepEqual(await readdir(f.store), before);
});

test('post-publish foreign edit is unknown, is preserved and is never retried or rolled back', async (t) => {
  let changed = false;
  const f = await policyHistoryFixture(t, built, {
    fault: async (stage) => {
      if (stage === 'after-rename' && !changed) {
        changed = true;
        await writeFile(
          join(f.home, 'policy.yaml'),
          '# newer foreign policy\n' + JSON.stringify(built.schema.DEFAULT_POLICY),
        );
      }
    },
  });
  const preview = await restorePreview(f),
    reply = await f.service.apply(restoreInput(preview));
  assert.equal(reply.body.error, 'policy-restore-unknown');
  assert((await readFile(join(f.home, 'policy.yaml'), 'utf8')).includes('newer foreign policy'));
  assert.equal((await f.service.apply(restoreInput(preview))).body.error, 'preview-expired');
});

function caseRecord() {
  const classes = ['shell.network'],
    expected = [
      { taint: 'none', effect: 'ask' },
      { taint: 'suspect', effect: 'deny' },
    ];
  return {
    id: policyCaseId(classes, expected),
    createdAt: '2026-10-24T00:00:00.000Z',
    source: {
      incidentId: 'incident-' + 'd'.repeat(64),
      evidenceSha: 'd'.repeat(64),
      workspaceId: 'workspace-' + 'e'.repeat(24),
    },
    classes,
    expected,
  };
}

test('saved cases added after preview make it stale, and a fresh real replay blocks their changed decisions', async (t) => {
  const f = await policyHistoryFixture(t, built),
    p = await restorePreview(f);
  await mkdir(join(f.home, 'console'), { mode: 0o700 });
  await writeFile(
    join(f.home, 'console', 'policy-cases.json'),
    JSON.stringify({ schema: 'stroq-policy-cases-store/1', records: [caseRecord()] }),
    { mode: 0o600 },
  );
  const names = await readdir(f.store),
    reply = await f.service.apply(restoreInput(p));
  assert.equal(reply.body.error, 'policy-cases-stale');
  assert.deepEqual(await readdir(f.store), names);
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
  const fresh = await restorePreview(f);
  assert.equal(fresh.regressions.failed, 1);
  assert(fresh.blockers.includes('saved-case-failures'));
  assert.equal((await f.service.apply(restoreInput(fresh))).body.error, 'checks-failed');
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
});

test('another case-store instance holding the real lock changes a waiting restore into a stale refusal', async (t) => {
  const f = await policyHistoryFixture(t, built);
  await mkdir(join(f.home, 'console'), { mode: 0o700 });
  const p = await restorePreview(f),
    other = createPolicyCasesStore({ home: f.home });
  let release, entered;
  const barrier = new Promise((r) => (release = r)),
    ready = new Promise((r) => (entered = r));
  const held = other.withSnapshotLock(await other.capture(), async (_snapshot, replace) => {
    entered();
    await barrier;
    await replace([caseRecord()]);
  });
  await ready;
  let settled = false;
  const applying = f.service.apply(restoreInput(p)).then((r) => {
    settled = true;
    return r;
  });
  try {
    await setTimeout(40);
    assert.equal(settled, false);
  } finally {
    release();
    await held;
  }
  assert.equal((await applying).body.error, 'policy-cases-stale');
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
});

test('a changed staged candidate is refused before publication and newer staged bytes are not deleted', async (t) => {
  let staged;
  const f = await policyHistoryFixture(t, built, {
    fault: async (stage, details) => {
      if (stage === 'before-rename') {
        staged = details.temporary;
        await writeFile(staged, 'private changed candidate\n');
      }
    },
  });
  const p = await restorePreview(f),
    reply = await f.service.apply(restoreInput(p));
  assert.equal(reply.body.error, 'write-failed');
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
  assert.equal(await readFile(staged, 'utf8'), 'private changed candidate\n');
});

test('runtime change during semantic readback is unknown after publication, with no rollback', async (t) => {
  let applying = false,
    f;
  f = await policyHistoryFixture(t, built, {
    adapter: async (...args) => {
      const result = await built.adapter(...args);
      if (applying && args[0] === 'inspect') f.setRuntime('f'.repeat(64));
      return result;
    },
  });
  const p = await restorePreview(f);
  applying = true;
  const reply = await f.service.apply(restoreInput(p));
  assert.equal(reply.body.error, 'policy-restore-unknown');
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.old);
});

test('worker responses cannot override server preview, record, runtime or scope bindings', async (t) => {
  const f = await policyHistoryFixture(t, built, {
    adapter: async (...args) => {
      const r = await built.adapter(...args);
      return args[0] === 'restore-preview'
        ? { ...r, runtimeSha256: 'f'.repeat(64), private: 'raw-sentinel' }
        : r;
    },
  });
  const state = await f.service.inspect(),
    row = state.body.entries[0];
  const reply = await f.service.preview({
    entryId: row.id,
    recordSha256: row.recordSha256,
    expectedRawSha: state.body.currentRawSha,
  });
  assert.equal(reply.body.error, 'engine-failed');
  assert(!JSON.stringify(reply).includes('raw-sentinel'));
  assert.deepEqual(await readFile(join(f.home, 'policy.yaml')), f.current);
});
