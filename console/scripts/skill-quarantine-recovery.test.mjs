import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createSkillQuarantine } from './skill-quarantine.mjs';
import { fixture, skill, preview, apply, vault } from './skill-quarantine-test-helpers.mjs';

test('failed final write retains payload and durable intent; explicit recovery restore is possible', async (t) => {
  const f = await fixture(t, { fault: 'before-final-manifest' });
  const source = await skill(f);
  const p = await preview(f);
  assert.equal((await apply(f.quarantine, p.body)).body.error, 'quarantine-recovery-required');
  await assert.rejects(access(source));
  const record = (await f.quarantine.read()).body.records[0];
  assert.equal(record.status, 'recovery-required');
  assert.equal(record.payload, 'match');
  const recovery = createSkillQuarantine({
    project: f.project,
    userHome: f.userHome,
    runtimeDigest: async () => 'a'.repeat(64),
  });
  t.after(() => recovery.close());
  const restore = await recovery.preview({ action: 'restore', recordId: record.id });
  assert.equal(restore.status, 200);
  assert.equal((await apply(recovery, restore.body)).body.status, 'restored');
  assert.equal(
    await readFile(join(source, 'SKILL.md'), 'utf8'),
    '# Release notes\nSummarize the changes.',
  );
});

test('interrupted restore keeps payload and partial resources without publishing SKILL.md', async (t) => {
  const f = await fixture(t);
  const source = await skill(f);
  await writeFile(join(source, 'resource.txt'), 'Resource bytes');
  const p = await preview(f);
  const q = await apply(f.quarantine, p.body);
  const broken = createSkillQuarantine({
    project: f.project,
    userHome: f.userHome,
    runtimeDigest: async () => 'a'.repeat(64),
    fault: 'restore-before-skill',
  });
  t.after(() => broken.close());
  const restore = await broken.preview({ action: 'restore', recordId: q.body.recordId });
  assert.equal((await apply(broken, restore.body)).body.error, 'quarantine-recovery-required');
  assert.equal(await readFile(join(source, 'resource.txt'), 'utf8'), 'Resource bytes');
  await assert.rejects(access(join(source, 'SKILL.md')));
  assert.equal(
    await readFile(join(vault(f.project, q.body.recordId), 'payload', 'SKILL.md'), 'utf8'),
    '# Release notes\nSummarize the changes.',
  );
  const state = (await f.quarantine.read()).body.records[0];
  assert.equal(state.status, 'recovery-required');
  assert.equal(
    (await f.quarantine.preview({ action: 'restore', recordId: q.body.recordId })).body.error,
    'quarantine-recovery-required',
  );
});

test('vault markers are private and copied or malformed records are never silently adopted', async (t) => {
  const f = await fixture(t);
  await skill(f);
  const p = await preview(f);
  const q = await apply(f.quarantine, p.body);
  const marker = join(f.project, '.claude', '.stroq-quarantine', '.gitignore');
  assert.equal(await readFile(marker, 'utf8'), '*\n');
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  const other = join(f.dir, 'other');
  await mkdir(join(other, '.claude'), { recursive: true });
  await cp(
    join(f.project, '.claude', '.stroq-quarantine'),
    join(other, '.claude', '.stroq-quarantine'),
    { recursive: true },
  );
  const copied = createSkillQuarantine({
    project: other,
    userHome: f.userHome,
    runtimeDigest: async () => 'a'.repeat(64),
  });
  t.after(() => copied.close());
  const copiedState = (await copied.read()).body;
  assert.equal(copiedState.available, false);
  assert.equal(copiedState.records.length, 0);
  assert.ok(copiedState.gaps.some((gap) => gap.code === 'record-invalid'));
  await writeFile(marker, '# Disabled ignore');
  const bad = (await f.quarantine.read()).body;
  assert.equal(bad.available, false);
  assert.equal(bad.reason, 'vault-unavailable');
  assert.equal(
    (await f.quarantine.preview({ action: 'restore', recordId: q.body.recordId })).status,
    503,
  );
});

test('restore apply refuses a new file or directory that appeared after its preview', async (t) => {
  const f = await fixture(t);
  const source = await skill(f);
  const p = await preview(f);
  const q = await apply(f.quarantine, p.body);
  const restore = await f.quarantine.preview({ action: 'restore', recordId: q.body.recordId });
  await writeFile(source, 'OUTSIDE_NEW_CONTENT');
  assert.equal((await apply(f.quarantine, restore.body)).body.error, 'quarantine-conflict');
  assert.equal(await readFile(source, 'utf8'), 'OUTSIDE_NEW_CONTENT');
  assert.ok((await stat(join(vault(f.project, q.body.recordId), 'payload'))).isDirectory());
});

test('shutdown stops mutation worker before the main-process lock is released', async (t) => {
  const f = await fixture(t, { fault: 'pause-after-intent' });
  const source = await skill(f);
  const p = await preview(f);
  const applying = apply(f.quarantine, p.body);
  const manifestPath = join(vault(f.project, p.body.recordId), 'manifest.json');
  let intent = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(manifestPath);
      intent = true;
      break;
    } catch {
      await sleep(20);
    }
  }
  assert.equal(intent, true);
  assert.ok(
    (await stat(join(f.userHome, '.claude', '.stroq-quarantine.apply.lock'))).isDirectory(),
  );
  assert.equal((await f.quarantine.read()).body.error, 'quarantine-busy');
  await f.quarantine.close();
  assert.equal((await applying).body.error, 'server-stopped');
  await assert.rejects(access(join(f.userHome, '.claude', '.stroq-quarantine.apply.lock')));
  assert.ok((await stat(source)).isDirectory());
  const current = createSkillQuarantine({
    project: f.project,
    userHome: f.userHome,
    runtimeDigest: async () => 'a'.repeat(64),
  });
  t.after(() => current.close());
  const record = (await current.read()).body.records[0];
  assert.equal(record.status, 'recovery-required');
  assert.equal(record.original, 'same');
  assert.equal(record.payload, 'missing');
});

test('malformed structured-clone worker replies return a fixed error rather than crashing', async (t) => {
  const f = await fixture(t);
  for (const [name, expression] of [
    ['bigint', "({ kind: 'result', body: 1n })"],
    ['circular', "(() => { const v = { kind: 'result' }; v.body = v; return v; })()"],
  ]) {
    const workerPath = join(f.dir, `${name}.mjs`);
    await writeFile(
      workerPath,
      `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${expression});`,
    );
    const service = createSkillQuarantine({
      project: f.project,
      userHome: f.userHome,
      workerPath,
      runtimeDigest: async () => 'a'.repeat(64),
    });
    t.after(() => service.close());
    assert.deepEqual(await service.read(), {
      status: 503,
      body: { error: 'quarantine-unavailable' },
    });
  }
});

test('linked vault or apply lock cannot redirect mutation', async (t) => {
  const f = await fixture(t);
  const source = await skill(f);
  const outside = join(f.dir, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.project, '.claude', '.stroq-quarantine'));
  const state = (await f.quarantine.read()).body;
  assert.equal(state.available, false);
  await rm(join(f.project, '.claude', '.stroq-quarantine'));
  const p = await preview(f);
  await mkdir(join(f.userHome, '.claude'));
  await symlink(outside, join(f.userHome, '.claude', '.stroq-quarantine.apply.lock'));
  assert.equal((await apply(f.quarantine, p.body)).status, 503);
  assert.ok((await stat(source)).isDirectory());
  await assert.rejects(access(join(outside, 'owner.json')));
});

test('a full bounded vault refuses another quarantine and malformed excess never reports green', async (t) => {
  const f = await fixture(t);
  await skill(f);
  const p = await preview(f);
  const q = await apply(f.quarantine, p.body);
  const originalRecord = vault(f.project, q.body.recordId);
  for (let index = 1; index < 32; index++) {
    const id = randomUUID();
    const directory = vault(f.project, id);
    await cp(originalRecord, directory, { recursive: true });
    const file = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify({ ...manifest, id })}\n`);
  }
  await skill(f, 'project', 'another');
  assert.equal((await preview(f, 'another')).body.error, 'quarantine-full');
  assert.equal((await f.quarantine.read()).body.records.length, 32);
  await mkdir(vault(f.project, randomUUID()), { mode: 0o700 });
  const state = (await f.quarantine.read()).body;
  assert.equal(state.available, false);
  assert.ok(state.gaps.some((gap) => gap.code === 'vault-limit'));
  assert.ok(state.records.length <= 32);
});

test('incomplete and oversized physical captures cannot be quarantined under an old fingerprint', async (t) => {
  const f = await fixture(t);
  const source = await skill(f);
  const p = await preview(f);
  await writeFile(join(source, 'large.bin'), Buffer.alloc(200_001));
  const request = { action: 'quarantine', id: p.item.id, expectedSha256: p.item.sha256 };
  assert.equal((await f.quarantine.preview(request)).body.error, 'quarantine-unsupported');
  await rm(join(source, 'large.bin'));
  await mkdir(join(source, 'node_modules'));
  assert.equal((await f.quarantine.preview(request)).body.error, 'quarantine-unsupported');
  await assert.rejects(access(join(f.project, '.claude', '.stroq-quarantine')));
});
