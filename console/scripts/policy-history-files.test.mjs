import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  chmod,
  rename,
  symlink,
  lstat,
  readFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPolicyState, samePolicyRevision } from './policy-files.mjs';
import { readPolicyHistory } from './policy-history-files.mjs';
import { buildPolicyHistoryFixture, hash } from './policy-history-test-helpers.mjs';
const built = await buildPolicyHistoryFixture();
test.after(() => rm(built.output, { recursive: true, force: true }));

test('exact current source binding refuses same-byte replacement and mode drift', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-pins-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'policy.yaml'),
    text = 'version: 1\nthreshold: 0.6\ndefault: allow\nrules: []\n';
  await writeFile(path, text, { mode: 0o600 });
  let before = await readPolicyState(home);
  await chmod(path, 0o640);
  assert.equal(samePolicyRevision(before, await readPolicyState(home)), false);
  before = await readPolicyState(home);
  await writeFile(join(home, 'replacement'), text, { mode: 0o640 });
  await rename(join(home, 'replacement'), path);
  assert.equal(samePolicyRevision(before, await readPolicyState(home)), false);
});

test('history inspection of a missing home is read-only and explicit', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = await readPolicyHistory(join(base, 'absent'), {
    parseJson: () => ({ ok: false }),
  });
  assert.deepEqual(result.history, { status: 'ready', limited: false });
  assert.deepEqual(result.entries, []);
  await assert.rejects(lstat(join(base, 'absent')), { code: 'ENOENT' });
});

test('a missing policy home keeps its legacy string anchor separate from exact capture root pins', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-missing-anchor-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'absent'),
    state = await readPolicyState(home);
  assert.equal(typeof state.anchor, 'string');
  assert.equal(state.anchor, base);
  assert.equal(state.captureRoot.path, base);
  assert.equal(state.captureRoot.ino, state.anchorStat.ino);
  assert.equal(state.capture.file, null);
  assert.deepEqual(state.missing, [home]);
  assert.equal(state.capture.directories[0].ino, state.anchorStat.ino);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});

test('all intent and backup bytes share the 8MiB budget before any over-budget payload is read', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-budget-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = join(home, 'backups', 'console-policy');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const bytes = Buffer.alloc(256 * 1024, 0x23);
  for (let i = 0; i < 32; i++) {
    const id = randomUUID();
    await writeFile(join(store, `${id}.yaml`), bytes, { mode: 0o600 });
    await writeFile(
      join(store, `${id}.json`),
      JSON.stringify({
        schema: 'stroq-policy-write/1',
        receiptId: id,
        appliedAt: new Date(1700000000000 + i * 1000).toISOString(),
        beforeRawSha: hash(bytes),
        afterRawSha: 'b'.repeat(64),
        policyFingerprint: 'c'.repeat(64),
        backupId: id,
      }),
      { mode: 0o600 },
    );
  }
  const result = await readPolicyHistory(home, { parseJson: built.schema.parsePolicyHistoryJson });
  assert.equal(result.history.status, 'partial');
  assert.equal(result.history.limited, true);
  assert.equal(result.entries.length, 32);
  assert.equal(result.entries.filter((r) => r.recovery === 'backup').length, 31);
  const retained = [...result.captured.values()].reduce(
    (n, v) => n + v.recordSnapshot.bytes.length + (v.backupSnapshot?.bytes?.length ?? 0),
    0,
  );
  assert(retained <= 8 * 1024 * 1024);
});

test('a missing store behind an unsafe parent link is unavailable, never a verified empty history', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-link-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const foreign = join(home, 'foreign');
  await mkdir(foreign);
  await symlink(foreign, join(home, 'backups'));
  const result = await readPolicyHistory(home, { parseJson: built.schema.parsePolicyHistoryJson });
  assert.equal(result.history.status, 'unavailable');
  assert.deepEqual(result.entries, []);
});

test('duplicate intent keys, missing backups and no-op deletion records remain partial without source reflection', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'stroq-policy-history-invalid-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = join(home, 'backups', 'console-policy');
  await mkdir(store, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    record = {
      schema: 'stroq-policy-write/1',
      receiptId: id,
      appliedAt: new Date().toISOString(),
      beforeRawSha: 'a'.repeat(64),
      afterRawSha: 'b'.repeat(64),
      policyFingerprint: 'c'.repeat(64),
      backupId: id,
    };
  const path = join(store, `${id}.json`),
    raw = JSON.stringify(record);
  await writeFile(path, raw, { mode: 0o600 });
  const absent = await readPolicyHistory(home, { parseJson: built.schema.parsePolicyHistoryJson });
  assert.equal(absent.entries[0].recovery, 'unavailable');
  assert.equal(absent.history.status, 'partial');
  const duplicate = raw.replace('{', '{"sch\\u0065ma":"private-sentinel",');
  await writeFile(path, duplicate);
  const invalid = await readPolicyHistory(home, { parseJson: built.schema.parsePolicyHistoryJson });
  assert.equal(invalid.history.status, 'partial');
  assert.deepEqual(invalid.entries, []);
  assert(!JSON.stringify(invalid.entries).includes('private-sentinel'));
  assert.equal(await readFile(path, 'utf8'), duplicate);
  await writeFile(
    path,
    JSON.stringify({
      ...record,
      schema: 'stroq-policy-write/2',
      beforeRawSha: null,
      afterRawSha: null,
      backupId: null,
    }),
  );
  assert.deepEqual(
    (await readPolicyHistory(home, { parseJson: built.schema.parsePolicyHistoryJson })).entries,
    [],
  );
});
