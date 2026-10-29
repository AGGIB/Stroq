import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createInventory } from './inventory.mjs';
import { createSkillQuarantine } from './skill-quarantine.mjs';
import { fixture, skill, apply, vault } from './skill-quarantine-test-helpers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const idFor = (scope, name = 'notes') =>
  `item-${hash(`skill\0claude-code\0${scope}\0${name}`).slice(0, 24)}`;
const options = (project, userHome) => ({
  project,
  userHome,
  runtimeDigest: async () => 'a'.repeat(64),
});
const inventoryFor = (t, project, userHome, home) => {
  const inventory = createInventory({ project, userHome, home });
  t.after(() => inventory.close());
  return inventory;
};
const quarantineFor = (t, project, userHome) => {
  const quarantine = createSkillQuarantine(options(project, userHome));
  t.after(() => quarantine.close());
  return quarantine;
};
async function runWorker(t, data) {
  const worker = new Worker(
    new URL('../.local-engine/skill-quarantine-worker.js', import.meta.url),
    {
      workerData: { deadline: Date.now() + 25_000, ...data },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
    },
  );
  t.after(() => worker.terminate());
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Fixture worker timed out'));
    }, 25_000);
    worker.once('error', reject);
    worker.once('message', async (value) => {
      clearTimeout(timer);
      await worker.terminate();
      resolve(value);
    });
  });
}
for (const alias of ['none', 'project', 'user']) {
  test(`home-as-workspace uses one user skill identity and cross-workspace restore (${alias} alias)`, async (t) => {
    const f = await fixture(t),
      source = await skill(f, 'user');
    const link = join(f.dir, 'home-alias');
    await symlink(f.userHome, link, 'dir');
    const project = alias === 'project' ? link : f.userHome;
    const userHome = alias === 'user' ? link : f.userHome;
    const inventory = inventoryFor(t, project, userHome, join(f.userHome, '.stroq'));
    const quarantine = quarantineFor(t, project, userHome);
    const state = await inventory.read();
    assert.equal(state.status, 200);
    const items = state.body.items.filter((item) => item.kind === 'skill' && item.sha256);
    assert.equal(items.length, 1);
    assert.equal(items[0].scope, 'user');
    assert.equal(items[0].id, idFor('user'));
    const item = items[0];
    const details = await inventory.inspect({ id: item.id, expectedSha256: item.sha256 });
    assert.equal(details.status, 200);
    assert.equal(details.body.artifact.scope, 'user');
    assert.equal(details.body.artifact.id, item.id);
    const forged = await quarantine.preview({
      action: 'quarantine',
      id: idFor('project'),
      expectedSha256: item.sha256,
    });
    assert.equal(forged.status, 409);
    await access(source);
    const p = await quarantine.preview({
      action: 'quarantine',
      id: item.id,
      expectedSha256: item.sha256,
    });
    assert.equal(p.status, 200);
    assert.equal(p.body.artifact.scope, 'user');
    assert.equal(p.body.affectsAllWorkspaces, true);
    const removed = await apply(quarantine, p.body);
    assert.equal(removed.status, 200);
    await assert.rejects(access(source));
    const another = join(f.dir, 'another-workspace');
    await mkdir(another);
    const other = quarantineFor(t, another, f.userHome);
    const retained = await other.read();
    assert.equal(retained.status, 200);
    assert.equal(retained.body.records.length, 1);
    assert.equal(retained.body.records[0].artifact.scope, 'user');
    const restore = await other.preview({ action: 'restore', recordId: removed.body.recordId });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.affectsAllWorkspaces, true);
    assert.equal((await apply(other, restore.body)).status, 200);
    assert.equal(
      await readFile(join(source, 'SKILL.md'), 'utf8'),
      '# Release notes\nSummarize the changes.',
    );
  });
}

test('a forged private project-scoped plan cannot mutate an aliased user skill', async (t) => {
  const f = await fixture(t),
    source = await skill(f, 'user');
  const inventory = inventoryFor(t, f.userHome, f.userHome, join(f.userHome, '.stroq'));
  const item = (await inventory.read()).body.items.find((item) => item.kind === 'skill');
  const root = await stat(f.userHome),
    directory = await stat(source);
  const text = await readFile(join(source, 'SKILL.md'));
  const plan = {
    action: 'quarantine',
    recordId: randomUUID(),
    scope: 'project',
    name: 'notes',
    root: { path: f.userHome, ino: root.ino, dev: root.dev },
    sha256: item.sha256,
    files: 1,
    bytes: text.length,
    sourceIdentity: { ino: directory.ino, dev: directory.dev },
    manifestSha: null,
    artifact: {
      id: idFor('project'),
      name: 'notes',
      agent: 'claude-code',
      scope: 'project',
      sha256: item.sha256,
    },
    createdAt: new Date().toISOString(),
  };
  const response = await runWorker(t, {
    operation: 'apply',
    project: f.userHome,
    userHome: f.userHome,
    plan,
    previewId: randomUUID(),
  });
  assert.equal(response.error, 'quarantine-preview-stale');
  assert.deepEqual(await readFile(join(source, 'SKILL.md')), text);
  await assert.rejects(access(join(f.userHome, '.claude', '.stroq-quarantine')));
});

test('legacy project-scoped retained records at the user root remain a visible gap without migration', async (t) => {
  const f = await fixture(t);
  await skill(f, 'user');
  const inventory = inventoryFor(t, f.userHome, f.userHome, join(f.userHome, '.stroq'));
  const quarantine = quarantineFor(t, f.userHome, f.userHome);
  const item = (await inventory.read()).body.items.find((item) => item.kind === 'skill');
  const p = await quarantine.preview({
    action: 'quarantine',
    id: item.id,
    expectedSha256: item.sha256,
  });
  const removed = await apply(quarantine, p.body);
  assert.equal(removed.status, 200);
  const path = join(vault(f.userHome, removed.body.recordId), 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const legacy = {
    ...manifest,
    scope: 'project',
    artifact: { ...manifest.artifact, scope: 'project', id: idFor('project') },
  };
  const bytes = JSON.stringify(legacy) + '\n';
  await writeFile(path, bytes);
  const state = await quarantine.read();
  assert.equal(state.status, 200);
  assert.equal(state.body.available, false);
  assert.ok(state.body.gaps.some((gap) => gap.scope === 'user' && gap.code === 'record-invalid'));
  assert.equal(
    (await quarantine.preview({ action: 'restore', recordId: removed.body.recordId })).status,
    503,
  );
  assert.equal(await readFile(path, 'utf8'), bytes);
  await access(join(vault(f.userHome, removed.body.recordId), 'payload', 'SKILL.md'));
  await assert.rejects(access(join(f.userHome, '.claude', 'skills', 'notes')));
});

test('a legacy project review baseline does not adopt the new user-scoped revision', async (t) => {
  const f = await fixture(t);
  await skill(f, 'user');
  const home = join(f.userHome, '.stroq'),
    inventory = inventoryFor(t, f.userHome, f.userHome, home);
  const first = await inventory.read(),
    current = first.body.items.find((item) => item.kind === 'skill');
  const workspace = first.body.workspace.id;
  await mkdir(join(home, 'console'), { recursive: true, mode: 0o700 });
  const entry = {
    id: idFor('project'),
    kind: 'skill',
    name: 'notes',
    agent: 'claude-code',
    scope: 'project',
    fileType: 'skill-tree',
    sha256: current.sha256,
  };
  await writeFile(
    join(home, 'console', `inventory-${workspace}.json`),
    JSON.stringify({
      schema: 'stroq-inventory-baseline/1',
      workspace,
      reviewedAt: new Date().toISOString(),
      entries: [entry],
    }),
    { mode: 0o600 },
  );
  const state = await inventory.read();
  assert.equal(state.status, 200);
  const user = state.body.items.find((item) => item.id === idFor('user'));
  assert.ok(user);
  assert.equal(user.state, 'unreviewed');
  assert.equal(user.reviewedSha256, null);
  const legacy = state.body.items.find((item) => item.id === idFor('project'));
  assert.equal(legacy.state, 'unverifiable');
  assert.equal(legacy.sha256, null);
});

test('ordinary distinct roots retain separate project and user identities and impacts', async (t) => {
  const f = await fixture(t);
  await skill(f, 'project');
  await skill(f, 'user');
  const state = await f.inventory.read();
  const items = state.body.items.filter((item) => item.kind === 'skill');
  assert.equal(items.length, 2);
  for (const item of items) {
    const p = await f.quarantine.preview({
      action: 'quarantine',
      id: item.id,
      expectedSha256: item.sha256,
    });
    assert.equal(p.status, 200);
    assert.equal(p.body.affectsAllWorkspaces, item.scope === 'user');
  }
});
