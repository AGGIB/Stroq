import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import {
  access,
  chmod,
  readFile,
  rm,
  writeFile,
  stat,
  link,
  symlink,
  rename,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundle,
  fixture,
  put,
  preview,
  apply,
  signedManifest,
} from './credential-filter-test-helpers.mjs';

let adapters;
before(async () => {
  adapters = await bundle();
});
after(async () => {
  await adapters?.clean();
});

test('Cursor counts exact preexisting user patterns without claiming ownership', async (t) => {
  const f = await fixture(t, adapters);
  await put(join(f.project, '.cursorignore'), '\uFEFF.env\r\n.env.*\r\n# .env\r\n!.env\r\n');
  const result = await f.filters.state();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = result.body.targets.find((value) => value.id === 'cursor-project');
  assert.equal(row.present, 2);
  assert.equal(row.managed, 0);
  assert.equal(row.unmanaged, 2);
  assert.equal(row.status, 'configured');
  const p = await preview(f.filters);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.added, 0);
  assert.equal(p.body.operation, 'update');
  await assert.rejects(access(f.home));
});

test('safe errors expose only a closed public reason, never exception text', () => {
  assert.equal(
    adapters.api.safeError(new Error('credential-filter-private/value')),
    'credential-filter-unavailable',
  );
  assert.equal(
    adapters.api.safeError(new Error('credential-filter-source-invalid')),
    'credential-filter-source-invalid',
  );
});

test('Cursor BOM is only normalized at the beginning of the whole document', () => {
  assert.equal(
    adapters.api.presentItems({ agent: 'cursor' }, '.env\n\uFEFF.env.*\n').present.size,
    1,
  );
  assert.equal(
    adapters.api.presentItems({ agent: 'cursor' }, '\uFEFF.env\n.env.*\n').present.size,
    2,
  );
});

test('unchanged source bytes with changed mode refuse the approved plan before mutation', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '# user\n');
  const p = await preview(f.filters);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await chmod(file, 0o640);
  const result = await apply(f.filters, p.body);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'credential-filter-preview-stale');
  assert.equal(await readFile(file, 'utf8'), '# user\n');
});

test('source-invalid rows retain exact raw-byte evidence rather than replacement text', async (t) => {
  const f = await fixture(t, adapters),
    bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  await put(join(f.project, '.claude', 'settings.local.json'), bytes);
  const result = await f.filters.state(),
    row = result.body.targets.find((v) => v.id === 'claude-project');
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'credential-filter-source-invalid');
  assert.equal(row.bytes, bytes.length);
  const { createHash } = await import('node:crypto');
  assert.equal(row.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(access(f.home));
});

test('Cursor guarded undo preserves explicit user patterns and reports fixed-rule counts', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '.env\n.env.*\n# foreign\n');
  const p = await preview(f.filters);
  assert.equal((await apply(f.filters, p.body)).status, 200);
  const state = await f.filters.state(),
    row = state.body.targets.find((v) => v.id === 'cursor-project');
  assert.equal(row.managed, 2);
  assert.equal(row.present, 2);
  const undo = await preview(f.filters, 'cursor-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.removed, 0);
  assert.equal(undo.body.kept, 2);
  assert.equal((await apply(f.filters, undo.body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), '.env\n.env.*\n# foreign\n');
  const after = (await f.filters.state()).body.targets.find((v) => v.id === 'cursor-project');
  assert.equal(after.managed, 0);
  assert.equal(after.unmanaged, 2);
  assert.equal(after.applications, 0);
});

for (const target of ['claude-project', 'claude-user', 'cursor-project'])
  test(`${target} read-only preview, shared ack retry, exact raw roundtrip and single use`, async (t) => {
    const f = await fixture(t, adapters),
      root = target === 'claude-user' ? f.userHome : f.project;
    const file = join(
      root,
      ...(target === 'cursor-project'
        ? ['.cursorignore']
        : ['.claude', target === 'claude-user' ? 'settings.json' : 'settings.local.json']),
    );
    const original = Buffer.from(
      '\uFEFF' +
        (target === 'cursor-project'
          ? '# foreign\r\ncache/\r\n'
          : '{\r\n\t"theme": "fixture-private-user-value",\r\n\t"permissions": {"deny":["Read(./user-private)"]}\r\n}'),
    );
    await put(file, original, 0o640);
    assert.equal((await f.filters.state()).status, 200);
    const p = await preview(f.filters, target);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(!JSON.stringify(p.body).includes('fixture-private'));
    assert.ok(!JSON.stringify(p.body).includes(f.dir));
    await assert.rejects(access(f.home));
    const missing = await f.filters.apply({
      previewId: p.body.id,
      confirm: true,
      acknowledgeNativeLimits: true,
      acknowledgePrivateRetention: true,
    });
    if (Object.values(p.body.needs).some(Boolean)) assert.equal(missing.status, 400);
    const result = missing.status === 200 ? missing : await apply(f.filters, p.body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await apply(f.filters, p.body)).status, 409);
    const state = await f.filters.state(),
      row = state.body.targets.find((v) => v.id === target);
    assert.equal(row.status, 'configured');
    assert.equal(row.present, row.required);
    assert.equal(row.applications, 1);
    const undo = await preview(f.filters, target, 'undo-filter');
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const noWeaken = {
      previewId: undo.body.id,
      confirm: true,
      acknowledgeNativeLimits: true,
      acknowledgePrivateRetention: true,
    };
    assert.equal((await f.filters.apply(noWeaken)).status, 400);
    assert.equal((await apply(f.filters, undo.body)).status, 200);
    assert.deepEqual(await readFile(file), original);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
  });

test('missing sources are created only on apply, then exact undo removes owned files', async (t) => {
  const f = await fixture(t, adapters),
    initial = await f.filters.state();
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  for (const row of initial.body.targets) assert.equal(row.status, 'absent', JSON.stringify(row));
  const p = await preview(f.filters);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.operation, 'create');
  await assert.rejects(access(f.home));
  assert.equal((await apply(f.filters, p.body)).status, 200);
  const undo = await preview(f.filters, 'cursor-project', 'undo-filter');
  assert.equal(undo.body.operation, 'remove-created-file');
  assert.equal(undo.body.backup, 'none-new-file');
  assert.equal((await apply(f.filters, undo.body)).status, 200);
  await assert.rejects(access(join(f.project, '.cursorignore')));
});

test('Claude invalid permission element types refuse native-invalid configurations', async (t) => {
  const f = await fixture(t, adapters),
    rules = adapters.api.fixedItems({ agent: 'claude-code' });
  const file = await put(
    join(f.project, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { deny: [...rules, null] } }),
  );
  const row = (await f.filters.state()).body.targets.find((v) => v.id === 'claude-project');
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'credential-filter-source-invalid');
  assert.notEqual((await preview(f.filters, 'claude-project')).status, 200);
  await assert.rejects(access(f.home));
  assert.ok((await readFile(file, 'utf8')).includes('null'));
});

test('private plans are runtime-bound, capped at eight, expire in memory and cannot replay', async (t) => {
  const f = await fixture(t, adapters);
  let runtime = 'a'.repeat(64),
    time = Date.now();
  const service = f.service({ runtimeDigest: async () => runtime, now: () => time });
  const first = await preview(service);
  assert.equal(first.status, 200);
  for (let n = 0; n < 8; n++) assert.equal((await preview(service)).status, 200);
  assert.equal((await apply(service, first.body)).body.error, 'credential-filter-preview-missing');
  const stale = await preview(service);
  runtime = 'b'.repeat(64);
  assert.equal((await apply(service, stale.body)).body.error, 'credential-filter-preview-stale');
  const expired = await preview(service);
  time += 120001;
  assert.equal(
    (await apply(service, expired.body)).body.error,
    'credential-filter-preview-expired',
  );
  await assert.rejects(access(join(f.project, '.cursorignore')));
});

test('wall-clock TTL releases retained raw plans without another request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = await fixture(t, adapters),
    p = await preview(f.filters);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  t.mock.timers.tick(120001);
  assert.equal((await apply(f.filters, p.body)).body.error, 'credential-filter-preview-missing');
  await assert.rejects(access(f.home));
});

test('terminal worker interruption preserves recorded history, requires recheck and leaves real lock usable', async (t) => {
  const f = await fixture(t, adapters, { fault: 'after-engine' }),
    file = await put(join(f.project, '.cursorignore'), '# original\n');
  const p = await preview(f.filters),
    result = await apply(f.filters, p.body);
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.error, 'credential-filter-recovery-required');
  assert.ok((await readFile(file, 'utf8')).includes('# >>> stroq'));
  const fresh = f.service({ fault: null }),
    row = (await fresh.state()).body.targets.find((v) => v.id === 'cursor-project');
  assert.equal(row.undoAvailable, true);
  const undo = await preview(fresh, 'cursor-project', 'undo-filter');
  assert.equal((await apply(fresh, undo.body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), '# original\n');
});

test('hard worker deadline terminates the writer before parent lock release', async (t) => {
  const f = await fixture(t, adapters, { fault: 'pause-before-engine', timeoutMs: 1500 }),
    file = await put(join(f.project, '.cursorignore'), '# original\n');
  const p = await preview(f.filters);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const result = await apply(f.filters, p.body);
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(await readFile(file, 'utf8'), '# original\n');
  const fresh = f.service({ fault: null, timeoutMs: 5000 }),
    again = await preview(fresh);
  assert.equal((await apply(fresh, again.body)).status, 200);
});

test('preexisting Claude deny rules stay unowned and an unchanged apply creates no store', async (t) => {
  const f = await fixture(t, adapters),
    rules = adapters.api.fixedItems({ agent: 'claude-code' });
  const file = await put(
    join(f.project, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { deny: rules } }),
  );
  const p = await preview(f.filters, 'claude-project');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.operation, 'unchanged');
  const result = await apply(f.filters, p.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.applications, 0);
  await assert.rejects(access(f.home));
  assert.ok((await readFile(file, 'utf8')).includes('permissions'));
  const row = (await f.filters.state()).body.targets.find((v) => v.id === 'claude-project');
  assert.equal(row.managed, 0);
  assert.equal(row.unmanaged, 13);
});

test('edited or duplicate Cursor blocks fail closed without changing source', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '# foreign\n');
  const p = await preview(f.filters);
  assert.equal((await apply(f.filters, p.body)).status, 200);
  const canonical = await readFile(file, 'utf8');
  for (const edited of [canonical.replace('.env.*', '.env.production'), canonical + canonical]) {
    await writeFile(file, edited);
    const row = (await f.filters.state()).body.targets.find((v) => v.id === 'cursor-project');
    assert.equal(row.status, 'unavailable');
    assert.equal(row.reason, 'credential-filter-edited-block');
    assert.notEqual((await preview(f.filters)).status, 200);
    assert.notEqual((await preview(f.filters, 'cursor-project', 'undo-filter')).status, 200);
    assert.equal(await readFile(file, 'utf8'), edited);
  }
});

test('source symlinks and hardlinks are refused and cannot initialize retention', async (t) => {
  const f = await fixture(t, adapters),
    target = await put(join(f.dir, 'foreign'), '# private\n'),
    file = join(f.project, '.cursorignore');
  await symlink(target, file);
  assert.notEqual((await preview(f.filters)).status, 200);
  await rm(file);
  await link(target, file);
  assert.notEqual((await preview(f.filters)).status, 200);
  assert.equal(await readFile(target, 'utf8'), '# private\n');
  await assert.rejects(access(f.home));
});

test('undo keeps newer user siblings, edited manifest is stale, and unknown recipe history is refused', async (t) => {
  const f = await fixture(t, adapters),
    file = await put(join(f.project, '.cursorignore'), '# original\n');
  assert.equal((await apply(f.filters, (await preview(f.filters)).body)).status, 200);
  await writeFile(file, (await readFile(file, 'utf8')) + 'later-user-rule/\n');
  const undo = await preview(f.filters, 'cursor-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.removed, 2);
  assert.equal(undo.body.kept, 0);
  const manifest = join(f.home, 'harden', 'manifest.json'),
    raw = await readFile(manifest, 'utf8');
  await writeFile(manifest, raw + '\n');
  assert.equal((await apply(f.filters, undo.body)).status, 409);
  const valid = await preview(f.filters, 'cursor-project', 'undo-filter');
  assert.equal((await apply(f.filters, valid.body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), '# original\nlater-user-rule/\n');
  assert.equal((await apply(f.filters, (await preview(f.filters)).body)).status, 200);
  const doc = JSON.parse(await readFile(manifest, 'utf8'));
  doc.files[file][0].recipe = 'unknown-fixture-recipe';
  // Edited without the home key, the manifest is not used at all.
  await writeFile(manifest, JSON.stringify(doc));
  assert.equal(
    (await f.filters.state()).body.targets.find((v) => v.id === 'cursor-project').reason,
    'credential-filter-storage-unavailable',
  );
  // Signed with the key, its unknown recipe is read and refused as mixed history.
  await writeFile(manifest, await signedManifest(f.home, doc.files));
  const row = (await f.filters.state()).body.targets.find((v) => v.id === 'cursor-project');
  assert.equal(row.reason, 'credential-filter-mixed-history');
  assert.equal(row.managed, null);
  assert.equal(row.undoAvailable, false);
  assert.notEqual((await preview(f.filters, 'cursor-project', 'undo-filter')).status, 200);
});

async function git(root) {
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  await mkdir(join(root, '.git', 'refs'));
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    join(root, '.git', 'config'),
    '[core]\nrepositoryformatversion = 0\nbare = false\n',
  );
}
test('native linked worktree writes only main checkout and shared acknowledgement binds both apply and undo', async (t) => {
  const f = await fixture(t, adapters);
  await git(f.project);
  const worktree = join(f.dir, 'linked'),
    gd = join(f.project, '.git', 'worktrees', 'linked');
  await mkdir(worktree);
  await mkdir(gd, { recursive: true });
  await writeFile(join(worktree, '.git'), `gitdir: ${gd}\n`);
  await writeFile(join(gd, 'commondir'), '../..\n');
  await writeFile(join(gd, 'gitdir'), `${join(worktree, '.git')}\n`);
  await writeFile(join(gd, 'HEAD'), 'ref: refs/heads/linked\n');
  const service = f.service({ project: worktree }),
    p = await preview(service, 'claude-project');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.location, 'main-checkout');
  assert.equal(p.body.context, 'repository');
  assert.equal(p.body.needs.acknowledgeSharedScope, true);
  assert.equal(
    (
      await service.apply({
        previewId: p.body.id,
        confirm: true,
        acknowledgeNativeLimits: true,
        acknowledgePrivateRetention: true,
      })
    ).status,
    400,
  );
  await assert.rejects(access(f.home));
  assert.equal((await apply(service, p.body)).status, 200);
  await assert.rejects(access(join(worktree, '.claude', 'settings.local.json')));
  assert.equal(
    JSON.parse(await readFile(join(f.project, '.claude', 'settings.local.json'), 'utf8'))
      .permissions.deny.length,
    13,
  );
  const undo = await preview(f.filters, 'claude-project', 'undo-filter');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.context, 'repository');
  assert.equal(undo.body.needs.acknowledgeSharedScope, true);
  assert.equal((await apply(f.filters, undo.body)).status, 200);
  await assert.rejects(access(join(f.project, '.claude', 'settings.local.json')));
});

test('changed Git metadata invalidates native source binding before lock initialization', async (t) => {
  const f = await fixture(t, adapters);
  await git(f.project);
  const p = await preview(f.filters, 'claude-project');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await writeFile(join(f.project, '.git', 'HEAD'), 'ref: refs/heads/changed\n');
  const result = await apply(f.filters, p.body);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'credential-filter-preview-stale');
  await assert.rejects(access(f.home));
});

test('late external edits survive and cannot produce an approved-candidate receipt', async (t) => {
  const f = await fixture(t, adapters, { fault: 'pause-before-final-evidence' }),
    file = await put(join(f.project, '.cursorignore'), '# original\n');
  const p = await preview(f.filters),
    pending = apply(f.filters, p.body);
  let changed = '';
  for (let n = 0; n < 300; n++) {
    const current = await readFile(file, 'utf8');
    if (current.includes('# >>> stroq')) {
      changed = current + 'newer-external-rule/\n';
      break;
    }
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(changed, 'fixture engine did not reach final-evidence gap');
  await writeFile(file, changed);
  const result = await pending;
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.error, 'credential-filter-recovery-required');
  assert.equal(await readFile(file, 'utf8'), changed);
});
