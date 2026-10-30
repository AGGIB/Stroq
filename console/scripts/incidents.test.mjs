import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../../packages/core/dist/index.js';
import { createIncidentService } from './incidents.mjs';

const NOW = new Date('2026-10-23T09:00:00.000Z');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-incidents-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  await mkdir(home, { mode: 0o700 });
  return { root, home, file: join(home, 'audit.jsonl') };
}
const input = (effect = 'deny', extra = {}) => ({
  sessionId: 'private-session',
  phase: 'pre',
  tool: 'Bash',
  summary: 'credential_should_not_escape',
  classes: ['shell.network', 'secret.egress'],
  decision: { effect, ruleId: 'private-rule', reason: 'private reason' },
  ...extra,
});
const build = (home, options = {}) => createIncidentService({ home, now: () => NOW, ...options });

test('missing journal read does not create state; refuses automatic verification claims', async (t) => {
  const { home } = await fixture(t);
  const service = build(home);
  const result = await service.read();
  assert.equal(result.schema, 'stroq-incidents/1');
  assert.equal(result.window.kind, 'missing');
  assert.deepEqual(result.incidents, []);
  assert.deepEqual(await readdir(home), []);
  assert.equal((await service.verify()).status, 'missing');
});

test('queue uses only genuine pre-deny/ask and post-suspect semantics; no sensitive text leaks', async (t) => {
  const { home, file } = await fixture(t);
  const journal = new AuditLog(file, () => NOW);
  await journal.append(input('allow'));
  await journal.append(input('deny', { phase: 'post' }));
  await journal.append(input('deny', { outcome: 'failed' }));
  await journal.append(
    input('allow', {
      phase: 'post',
      scan: { verdict: 'suspect', score: 0.8, ruleIds: ['private-rule'] },
    }),
  );
  await journal.append(
    input('deny', { secrets: [{ name: 'PRIVATE_KEY_LABEL', source: '/private/path' }] }),
  );
  await journal.append(input('ask'));
  const result = await build(home).read();
  assert.equal(result.incidents.length, 3);
  assert.deepEqual(
    result.incidents.map((row) => row.kind),
    ['policy-ask', 'policy-deny', 'content-flag'],
  );
  assert.equal(result.incidents[1].secretReferences, 1);
  assert.deepEqual(result.incidents[1].relatedIds, [result.incidents[2].id]);
  assert.equal(result.incidents[1].status, 'open');
  const encoded = JSON.stringify(result);
  for (const privateText of [
    'private-session',
    'credential_should_not_escape',
    'private reason',
    'private-rule',
    '/private/path',
    'PRIVATE_KEY_LABEL',
  ])
    assert.equal(encoded.includes(privateText), false);
  assert.equal(encoded.includes('blocked'), false);
});

test('manual review persists privately, reopens and binds exact evidence revision', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  const service = build(home);
  const [incident] = (await service.read()).incidents;
  const request = {
    id: incident.id,
    expectedEvidenceSha: incident.evidenceSha,
    status: 'reviewed',
  };
  const reviewed = await service.review(request);
  assert.equal(reviewed.status, 'reviewed');
  assert.equal((await build(home).read()).incidents[0].status, 'reviewed');
  const store = join(home, 'console', 'incident-reviews.json');
  assert.equal((await lstat(store)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(home, 'console'))).mode & 0o777, 0o700);
  assert.equal((await readFile(store, 'utf8')).includes('credential_should_not_escape'), false);
  assert.equal((await service.review({ ...request, status: 'open' })).status, 'open');
  await assert.rejects(
    service.review({ ...request, expectedEvidenceSha: '0'.repeat(64) }),
    /stale-evidence/,
  );
  await assert.rejects(service.review({ ...request, status: 'remediated' }), /invalid-request/);
  await assert.rejects(service.review({ ...request, comment: 'text' }), /invalid-request/);
  const lines = await readFile(file, 'utf8');
  await writeFile(file, lines.replace('private reason', 'changed reason'));
  await assert.rejects(service.review(request), /stale-evidence/);
});

test('malformed records are omitted and tail bounds do not silently imply a complete queue', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  await writeFile(file, 'not-json\n' + (await readFile(file, 'utf8')));
  const service = build(home, { maxReadBytes: 1024 });
  assert.equal((await service.read()).window.omitted, 1);
  const row = await readFile(file, 'utf8');
  await writeFile(file, `${'x'.repeat(1400)}\n${row}`);
  const result = await service.read();
  assert.equal(result.window.truncated, true);
  assert.equal(result.incidents.length, 1);
});

test('a complete bounded operation stays selectable after JSON escaping expands its audit line', async (t) => {
  const { home, file } = await fixture(t);
  const operation = JSON.stringify({ content: '"'.repeat(20000), note: 'PRIVATE_REVIEW_TEXT' });
  assert.ok(Buffer.byteLength(operation) < 64 * 1024);
  const entry = await new AuditLog(file, () => NOW).append(input('deny', { operation }));
  const bytes = await readFile(file);
  assert.ok(bytes.length > 64 * 1024);
  const service = build(home);
  const result = await service.read();
  assert.equal(result.incidents.length, 1);
  assert.equal(result.window.omitted, 0);
  assert.equal(result.incidents[0].sequence, entry.seq);
  const selected = await service.selectForComparison({
    id: result.incidents[0].id,
    expectedEvidenceSha: result.incidents[0].evidenceSha,
  });
  assert.equal(selected.operation, operation);
  assert.equal(JSON.stringify(result).includes('PRIVATE_REVIEW_TEXT'), false);
  assert.deepEqual(await readFile(file), bytes);
});

test('an audit line exceeding the expanded fixed budget remains an explicit omission', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input('deny', { operation: 'x'.repeat(512 * 1024) }));
  const result = await build(home).read();
  assert.equal(result.incidents.length, 0);
  assert.equal(result.window.omitted, 1);
});

test('symlink journal and review stores are refused without writes to targets', async (t) => {
  const { root, home, file } = await fixture(t);
  const target = join(root, 'target');
  await writeFile(target, 'untouched', { mode: 0o600 });
  await symlink(target, file);
  assert.equal((await build(home).read()).window.kind, 'refused');
  assert.equal((await build(home).verify()).status, 'refused');
  await rm(file);
  await new AuditLog(file, () => NOW).append(input());
  await mkdir(join(home, 'console'), { mode: 0o700 });
  await symlink(target, join(home, 'console', 'incident-reviews.json'));
  const service = build(home);
  const [incident] = (await service.read()).incidents;
  await assert.rejects(
    service.review({
      id: incident.id,
      expectedEvidenceSha: incident.evidenceSha,
      status: 'reviewed',
    }),
    /review-unavailable/,
  );
  assert.equal(await readFile(target, 'utf8'), 'untouched');
});

test('review expires and concurrent writers cannot lose review records', async (t) => {
  const { home, file } = await fixture(t);
  const audit = new AuditLog(file, () => NOW);
  await audit.append(input('deny'));
  await audit.append(input('ask'));
  const service = build(home);
  const rows = (await service.read()).incidents;
  const requests = rows.map((row) => ({
    id: row.id,
    expectedEvidenceSha: row.evidenceSha,
    status: 'reviewed',
  }));
  await Promise.all(requests.map((request) => service.review(request)));
  assert.ok((await service.read()).incidents.every((row) => row.status === 'reviewed'));
  const expired = build(home, { now: () => new Date(NOW.getTime() + 91 * 24 * 3600_000) });
  assert.ok((await expired.read()).incidents.every((row) => row.status === 'open'));
});

test('full captured journal goes through AuditLog.verify and detects an edited record', async (t) => {
  const { home, file } = await fixture(t);
  const audit = new AuditLog(file, () => NOW);
  await audit.append(input());
  await audit.append(input('ask'));
  let verifiedPath;
  const verifyAdapter = async (path) => {
    verifiedPath = path;
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    return new AuditLog(path).verify();
  };
  const service = build(home, { verifyAdapter });
  const result = await service.verify();
  assert.equal(result.status, 'consistent');
  assert.equal(result.count, 2);
  assert.equal(
    result.journalSha,
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  );
  await assert.rejects(lstat(verifiedPath), { code: 'ENOENT' });
  await writeFile(file, (await readFile(file, 'utf8')).replace('private reason', 'edited reason'));
  const changed = await service.verify();
  assert.equal(changed.status, 'broken');
  assert.equal(changed.brokenAt, 1);
  assert.ok(changed.limitations.some((text) => /truncation/i.test(text)));
});

test('full verification reports size limits and malformed engine answers safely', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  assert.equal((await build(home, { maxVerifyBytes: 16 }).verify()).status, 'limit');
  const failed = build(home, {
    verifyAdapter: async () => ({ ok: true, count: -1, brokenAt: null }),
  });
  assert.equal((await failed.verify()).status, 'engine-unavailable');
  await chmod(home, 0o777);
  assert.equal((await build(home).read()).window.kind, 'refused');
});

test('unterminated records are not promoted to complete observations and malformed metadata is omitted', async (t) => {
  const { home, file } = await fixture(t);
  const row = await new AuditLog(file, () => NOW).append(input());
  await writeFile(file, JSON.stringify(row));
  let result = await build(home).read();
  assert.deepEqual(result.incidents, []);
  assert.equal(result.window.omitted, 1);
  await writeFile(
    file,
    `${JSON.stringify({ ...row, ts: '2026-02-31T09:00:00.000Z' })}\n${JSON.stringify({ ...row, hash: '../untrusted' })}\n${JSON.stringify(row).slice(0, -12)}`,
  );
  result = await build(home).read();
  assert.deepEqual(result.incidents, []);
  assert.equal(result.window.omitted, 3);
});

test('corrupt or public review store is never replaced and cross-process lock returns busy', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  const service = build(home);
  const [row] = (await service.read()).incidents;
  const request = { id: row.id, expectedEvidenceSha: row.evidenceSha, status: 'reviewed' };
  await mkdir(join(home, 'console'), { mode: 0o700 });
  const store = join(home, 'console', 'incident-reviews.json');
  await writeFile(store, '{broken', { mode: 0o600 });
  await assert.rejects(service.review(request), /review-unavailable/);
  assert.equal(await readFile(store, 'utf8'), '{broken');
  assert.equal((await service.read()).incidents[0].status, 'open');
  await writeFile(store, JSON.stringify({ schema: 'stroq-incident-reviews/1', records: [] }));
  await chmod(store, 0o644);
  await assert.rejects(service.review(request), /review-unavailable/);
  await chmod(store, 0o600);
  await writeFile(join(home, 'console', '.incident-reviews.lock'), 'existing writer', {
    mode: 0o600,
  });
  await assert.rejects(service.review(request), /busy/);
});

test('verification is serialized and its captured checksum identifies its snapshot after journal changes', async (t) => {
  const { home, file } = await fixture(t);
  const audit = new AuditLog(file, () => NOW);
  await audit.append(input());
  const beforeSha = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const service = build(home, {
    verifyAdapter: async (path) => {
      enter();
      await pending;
      return new AuditLog(path).verify();
    },
  });
  const first = service.verify();
  await entered;
  await assert.rejects(service.verify(), /busy/);
  await assert.rejects(service.verify({ file }), /invalid-request/);
  await audit.append(input('ask'));
  release();
  const result = await first;
  assert.equal(result.status, 'consistent');
  assert.equal(result.count, 1);
  assert.equal(result.journalSha, beforeSha);
  assert.notEqual(
    result.journalSha,
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  );
});

test('shutdown waits for captured verification and rejects all new work', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const service = build(home, {
    verifyAdapter: async (path) => {
      entered();
      await gate;
      return new AuditLog(path).verify();
    },
  });
  const verification = service.verify();
  await started;
  let closed = false;
  const shutdown = service.close().then(() => {
    closed = true;
  });
  await assert.rejects(service.read(), /server-stopped/);
  await assert.rejects(service.review({}), /server-stopped/);
  await assert.rejects(service.verify(), /server-stopped/);
  assert.equal(closed, false);
  release();
  assert.equal((await verification).status, 'consistent');
  await shutdown;
  assert.equal(closed, true);
});

test('built isolated worker verifies with the source engine and detects a tampered hash chain', async (t) => {
  const { home, file } = await fixture(t);
  await new AuditLog(file, () => NOW).append(input());
  const service = build(home);
  t.after(() => service.close());
  assert.equal((await service.verify()).status, 'consistent');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('private reason', 'tampered reason'),
  );
  const broken = await service.verify();
  assert.equal(broken.status, 'broken');
  assert.equal(broken.count, 1);
  assert.equal(broken.brokenAt, 1);
});
