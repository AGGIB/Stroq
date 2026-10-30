import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from './serve.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-filter-http-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'profile'),
    home = join(userHome, '.stroq'),
    root = join(dir, 'out');
  await Promise.all([project, userHome, root].map((path) => mkdir(path)));
  await writeFile(join(root, 'index.html'), 'fixture');
  const app = await startServer({ root, project, userHome, home, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  const schema = await import('../.local-engine/local-api-schema.js');
  async function request(path, body, extra = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + app.token,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const preview = (target, action = 'apply-filter') =>
    request('/api/credential-filters/preview', { target, action });
  const applyInput = (p) => ({
    previewId: p.id,
    confirm: true,
    acknowledgeNativeLimits: true,
    acknowledgePrivateRetention: true,
    ...(p.action === 'undo-filter' ? { acknowledgeWeakenFilter: true } : {}),
    ...Object.fromEntries(
      Object.entries(p.needs)
        .filter(([, needed]) => needed)
        .map(([name]) => [name, true]),
    ),
  });
  const apply = (p) => request('/api/credential-filters/apply', applyInput(p));
  const state = async () => {
    const r = await request('/api/credential-filters');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(schema.validateCredentialFilters(r.body), true);
    return r.body;
  };
  return { dir, project, userHome, home, schema, request, preview, apply, applyInput, state };
}

for (const target of ['claude-project', 'claude-user', 'cursor-project'])
  test(
    'actual HTTP ' + target + ' preview/apply/recheck/exact undo preserves foreign settings',
    async (t) => {
      const f = await fixture(t);
      const isCursor = target === 'cursor-project';
      const parent = target === 'claude-user' ? f.userHome : f.project;
      if (!isCursor) await mkdir(join(parent, '.claude'));
      const file = join(
        parent,
        isCursor
          ? '.cursorignore'
          : '.claude/' + (target === 'claude-user' ? 'settings.json' : 'settings.local.json'),
      );
      const document = {
        permissions: { allow: ['Bash(git status)'], deny: ['Read(./private-owner-file)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'PRIVATE_SETTINGS_SENTINEL' }] }] },
        theme: 'dark',
      };
      const original = Buffer.from(
        isCursor
          ? '# PRIVATE_SETTINGS_SENTINEL\r\nowner-data/\r\n'
          : '\uFEFF' + JSON.stringify(document, null, '\t').replaceAll('\n', '\r\n') + '\r\n',
      );
      await writeFile(file, original, { mode: 0o640 });
      const before = await f.state();
      assert.equal(before.targets.find((r) => r.id === target).undoAvailable, false);
      const plan = await f.preview(target);
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(f.schema.validateCredentialFilterPreview(plan.body), true);
      assert.equal(plan.body.hostEnforcement, false);
      assert.deepEqual(await readFile(file), original);
      await assert.rejects(access(f.home));
      const noAck = f.applyInput(plan.body);
      delete noAck.acknowledgeNativeLimits;
      assert.equal((await f.request('/api/credential-filters/apply', noAck)).status, 400);
      const result = await f.apply(plan.body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(f.schema.validateCredentialFilterReceipt(result.body), true);
      assert.equal(result.body.previewId, plan.body.id);
      assert.equal(result.body.candidateSha256, plan.body.candidateSha256);
      const configured = await f.state(),
        row = configured.targets.find((r) => r.id === target);
      assert.equal(row.status, 'configured');
      assert.equal(row.present, row.required);
      assert.equal(row.undoAvailable, true);
      const changed = await readFile(file, 'utf8');
      if (isCursor) assert.ok(changed.includes('owner-data/'));
      else {
        const after = JSON.parse(changed.replace(/^\uFEFF/, ''));
        assert.deepEqual(after.hooks, document.hooks);
        assert.deepEqual(after.permissions.allow, document.permissions.allow);
        assert.ok(after.permissions.deny.includes('Read(./private-owner-file)'));
      }
      assert.equal((await f.apply(plan.body)).status, 409);
      const undo = await f.preview(target, 'undo-filter');
      assert.equal(undo.status, 200, JSON.stringify(undo.body));
      assert.equal(f.schema.validateCredentialFilterPreview(undo.body), true);
      const missingWeak = f.applyInput(undo.body);
      delete missingWeak.acknowledgeWeakenFilter;
      assert.equal((await f.request('/api/credential-filters/apply', missingWeak)).status, 400);
      const restored = await f.apply(undo.body);
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal(f.schema.validateCredentialFilterReceipt(restored.body), true);
      assert.deepEqual(await readFile(file), original);
      assert.equal((await f.state()).targets.find((r) => r.id === target).undoAvailable, false);
      for (const response of [
        before,
        plan.body,
        result.body,
        configured,
        undo.body,
        restored.body,
      ]) {
        const raw = JSON.stringify(response);
        assert.ok(!raw.includes(f.dir));
        assert.ok(!raw.includes('PRIVATE_SETTINGS_SENTINEL'));
        assert.ok(!raw.includes('Bash(git status)'));
      }
    },
  );

test('actual credential routes keep authentication, exact Origin and strict request boundaries', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/credential-filters',
    '/api/credential-filters/preview',
    '/api/credential-filters/apply',
  ]) {
    const body = path.endsWith('filters') ? undefined : {};
    assert.equal((await f.request(path, body, { Authorization: '' })).status, 401);
    assert.equal((await f.request(path, body, { Origin: 'https://foreign.invalid' })).status, 403);
  }
  for (const action of ['preview', 'apply']) {
    const path = '/api/credential-filters/' + action;
    for (const raw of [Buffer.from('{"confirm":true,"confirm":false}'), Buffer.from([0xff])])
      assert.equal((await f.request(path, raw)).status, 400);
    assert.equal((await f.request(path, Buffer.alloc(4097, 'x'))).status, 413);
    assert.equal((await f.request(path, { path: '/outside', command: 'never-run' })).status, 400);
  }
  await assert.rejects(access(f.home));
});

test('stale source and mode cannot consume a reviewed credential plan into a different file', async (t) => {
  const f = await fixture(t);
  const file = join(f.project, '.cursorignore');
  await writeFile(file, 'owner/\n', { mode: 0o644 });
  const plan = await f.preview('cursor-project');
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  await writeFile(file, 'new-owner/\n');
  assert.equal((await f.apply(plan.body)).status, 409);
  assert.equal(await readFile(file, 'utf8'), 'new-owner/\n');
  const modePlan = await f.preview('cursor-project');
  assert.equal(modePlan.status, 200, JSON.stringify(modePlan.body));
  await chmod(file, 0o600);
  assert.equal((await f.apply(modePlan.body)).status, 409);
  assert.equal(await readFile(file, 'utf8'), 'new-owner/\n');
});

test('created Claude settings undo removes only its empty file; newer siblings survive surgical undo', async (t) => {
  const f = await fixture(t),
    file = join(f.project, '.claude', 'settings.local.json');
  const first = await f.preview('claude-project');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.operation, 'create');
  assert.equal((await f.apply(first.body)).status, 200);
  const remove = await f.preview('claude-project', 'undo-filter');
  assert.equal(remove.status, 200, JSON.stringify(remove.body));
  assert.equal(remove.body.operation, 'remove-created-file');
  assert.equal(remove.body.backup, 'none-new-file');
  assert.equal((await f.apply(remove.body)).status, 200);
  await assert.rejects(access(file));
  const second = await f.preview('claude-project');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((await f.apply(second.body)).status, 200);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  doc.ownerAdded = { keep: true };
  await writeFile(file, JSON.stringify(doc));
  const undo = await f.preview('claude-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.operation, 'remove-managed');
  assert.equal((await f.apply(undo.body)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ownerAdded: { keep: true } });
});

test('preexisting explicit Claude rules remain user-owned after an unchanged apply', async (t) => {
  const f = await fixture(t),
    file = join(f.userHome, '.claude', 'settings.json');
  await mkdir(join(f.userHome, '.claude'));
  const homePatterns = [
    '.ssh/**',
    '.aws/**',
    '.config/gcloud/**',
    '.config/gh/hosts.yml',
    '.kube/**',
    '.docker/config.json',
    '.npmrc',
    '.netrc',
    '.pgpass',
    '.git-credentials',
    '.gnupg/**',
  ];
  const rules = ['Read(./.env)', 'Read(./.env.*)', ...homePatterns.map((p) => 'Read(~/' + p + ')')];
  const original = Buffer.from(JSON.stringify({ permissions: { deny: rules } }));
  await writeFile(file, original);
  const state = await f.state(),
    row = state.targets.find((r) => r.id === 'claude-user');
  assert.equal(row.status, 'configured');
  assert.equal(row.managed, 0);
  assert.equal(row.unmanaged, 13);
  assert.equal(row.undoAvailable, false);
  const plan = await f.preview('claude-user');
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.operation, 'unchanged');
  assert.equal((await f.apply(plan.body)).body.status, 'unchanged');
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(access(f.home));
  assert.notEqual((await f.preview('claude-user', 'undo-filter')).status, 200);
});
