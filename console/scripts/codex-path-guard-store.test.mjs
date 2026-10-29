import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
  link,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tsImport } from 'tsx/esm/api';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-store-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const load = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
const store = await load('./codex-path-guard-store.ts'),
  binding = await load('./codex-path-guard-binding.ts'),
  manifestApi = await load('./codex-path-guard-manifest.ts'),
  owner = await load('./codex-path-guard-ownership.ts'),
  planner = await load('./codex-path-guard-toml.ts');
const { rootIdentity, snapshotFile } = await import('./agent-setup-files.mjs');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  stamp = '2026-10-27T00:00:00.000Z';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-store-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const user = await rootIdentity(base),
    target = join(base, '.codex', 'config.toml');
  await mkdir(join(base, '.codex'), { mode: 0o700 });
  const initial = Buffer.from(
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\n',
  );
  await writeFile(target, initial, { mode: 0o600 });
  const before = await snapshotFile(user, target, binding.CONFIG_BYTES),
    context = {
      id: 'codex-context-' + hash,
      user,
      target,
      rootBinding: binding.controlHash(JSON.stringify(user)),
    };
  const create = async (n = 1, options = {}) => {
    const credentialTarget = join(
        base,
        options.presetId === 'npmrc' ? '.npmrc' : '.aws/credentials',
      ),
      p = planner.planCodexPathGuard({
        bytes: initial,
        operationId: id(n),
        targetPath: credentialTarget,
      });
    const m = {
      schema: 'stroq-codex-path-record/1',
      id: id(n),
      operationId: id(n),
      controlContextId: context.id,
      rootBinding: context.rootBinding,
      target,
      sequence: n,
      ownedKeys: owner.pathGuardOwnedKeys(p.owned),
      kind: 'profile-path-deny',
      presetId: options.presetId ?? 'aws-credentials',
      profileName: 'source',
      credentialTarget,
      targetMetadataSha256: hash,
      dependencySha256: hash,
      createdAt: stamp,
      updatedAt: stamp,
      phase: 'prepared',
      originalSha256: before.sha256,
      candidateSha256: binding.controlHash(p.bytes),
      beforeBytes: initial.length,
      candidateBytes: p.bytes.length,
      mode: before.mode,
      nativeBinarySha256: hash,
      captureSha256: hash,
      sourceGraphSha256: hash,
      staged: null,
      parents: binding.controlParents(before),
      publication: null,
      restoreSha256: null,
      restoreStaged: null,
      restorePublication: null,
      ...options,
    };
    let r = await store.createPathGuardRecord(
      context,
      m,
      initial,
      Buffer.from(p.bytes),
      async () => {},
    );
    await writeFile(target, p.bytes, { mode: 0o600 });
    const snap = await snapshotFile(user, target, binding.CONFIG_BYTES);
    await store.savePathGuardManifest(
      context,
      { ...m, phase: 'guarded', staged: binding.publishedPin(snap.file), publication: snap.file },
      r.revision,
      async () => {},
    );
    r = await store.getPathGuardRecord(context, m.id);
    return { m, p, r };
  };
  return {
    base,
    user,
    target,
    initial,
    before,
    context,
    create,
    vault: join(base, '.stroq', 'codex-path-guard'),
  };
}
test('passive missing vault has no side effects; real record roundtrips raw private bytes and descriptor', async (t) => {
  const f = await fixture(t),
    empty = await store.readPathGuardVault(f.context);
  assert.equal(empty.missing, true);
  assert.equal(empty.count, 0);
  await assert.rejects(readFile(join(f.vault, '.gitignore')), { code: 'ENOENT' });
  const { r, p } = await f.create();
  assert.deepEqual(r.before, f.initial);
  assert.deepEqual(r.candidate, Buffer.from(p.bytes));
  assert.equal(manifestApi.validPathGuardManifest(r.manifest, id(1)), true);
  assert.equal(r.owned.targetPath, join(f.base, '.aws/credentials'));
  const v = await store.readPathGuardVault(f.context);
  assert.equal(v.count, 1);
  assert.equal(v.records.length, 1);
  assert.equal(v.pendingStaging, false);
  assert.ok(v.bytes <= binding.STORE_BYTES);
});
test('manifest closes metadata, path ownership and phase evidence', async (t) => {
  const f = await fixture(t),
    { m } = await f.create();
  for (const patch of [
    { extra: true },
    { presetId: 'any' },
    { kind: 'profile-child' },
    { ownedKeys: [['permissions', 'other', 'filesystem', m.credentialTarget]] },
    { credentialTarget: '/../wrong' },
    { dependencySha256: null },
    { targetMetadataSha256: null },
    { sequence: 0 },
    { parentProfile: null },
    { phase: 'guarded' },
    { originalSha256: null },
  ])
    assert.equal(
      manifestApi.validPathGuardManifest({ ...m, ...patch }, m.id),
      false,
      JSON.stringify(patch),
    );
});
test('reserved filesystem profile cannot be retained as valid manifest ownership', async (t) => {
  const f = await fixture(t),
    { m } = await f.create();
  assert.equal(
    manifestApi.validPathGuardManifest(
      {
        ...m,
        profileName: 'filesystem',
        ownedKeys: [['permissions', 'filesystem', 'filesystem', m.credentialTarget]],
      },
      m.id,
    ),
    false,
  );
});
test('foreign raw bytes, selected profile, target preset and ownership reconstruction cannot be adopted', async (t) => {
  for (const variant of ['candidate', 'before', 'profile', 'preset', 'owned'])
    await t.test(variant, async (t) => {
      const f = await fixture(t),
        { r } = await f.create();
      if (variant === 'candidate' || variant === 'before')
        await writeFile(join(r.directory, variant + '.toml'), 'unrelated', { mode: 0o600 });
      else {
        const m = { ...r.manifest };
        if (variant === 'profile') m.profileName = 'other';
        if (variant === 'preset') m.presetId = 'npmrc';
        if (variant === 'owned') m.ownedKeys[0][3] = join(f.base, '.npmrc');
        await writeFile(r.path, JSON.stringify(m), { mode: 0o600 });
      }
      await assert.rejects(store.readPathGuardVault(f.context), {
        message: 'codex-path-guard-store-unavailable',
      });
    });
});
test('symlink, hardlink and permissive private raw files refuse without repair', async (t) => {
  for (const variant of ['symlink', 'hardlink', 'mode'])
    await t.test(variant, async (t) => {
      const f = await fixture(t),
        { r } = await f.create(),
        path = join(r.directory, 'candidate.toml'),
        foreign = join(f.base, 'foreign');
      if (variant === 'mode') await chmod(path, 0o644);
      else {
        await writeFile(foreign, r.candidate, { mode: 0o600 });
        await rm(path);
        if (variant === 'symlink') await symlink(foreign, path);
        else await link(foreign, path);
      }
      await assert.rejects(store.readPathGuardVault(f.context), {
        message: 'codex-path-guard-store-unavailable',
      });
      if (variant !== 'mode') assert.deepEqual(await readFile(foreign), r.candidate);
    });
});
test('newer overlapping ownership supersedes forever while different target/profile remains independent', async (t) => {
  const f = await fixture(t),
    first = (await f.create()).r,
    second = (await f.create(2)).r,
    third = (await f.create(3, { presetId: 'npmrc' })).r;
  assert.equal(owner.pathGuardSuperseded(first, [first, second, third]), true);
  assert.throws(() => owner.assertPathGuardOwnership(first, [second]), {
    message: 'codex-path-guard-superseded',
  });
  assert.equal(owner.pathGuardSuperseded(second, [first, second, third]), false);
  assert.equal(
    owner.pathGuardSuperseded(first, [
      { ...second, manifest: { ...second.manifest, phase: 'restored' } },
    ]),
    true,
  );
  assert.equal(
    owner.pathGuardSuperseded(first, [
      {
        ...second,
        manifest: {
          ...second.manifest,
          ownedKeys: [['permissions', 'different', 'filesystem', first.manifest.credentialTarget]],
        },
      },
    ]),
    false,
  );
});
test('manifest orphan temp blocks another publication; staged raw state is counted and preserved', async (t) => {
  const f = await fixture(t),
    { r } = await f.create(),
    temp = join(r.directory, '.stroq-' + id(9) + '.tmp');
  await writeFile(temp, '{}', { mode: 0o600 });
  const v = await store.readPathGuardVault(f.context);
  assert.equal(v.pendingStaging, true);
  await assert.rejects(
    store.savePathGuardManifest(f.context, r.manifest, r.revision, async () => {}),
    { message: 'codex-path-guard-recovery-required' },
  );
  assert.equal(await readFile(temp, 'utf8'), '{}');
  const staged = join(f.vault, '.prepared-' + id(8));
  await mkdir(staged, { mode: 0o700 });
  await writeFile(join(staged, 'before.toml'), 'partial', { mode: 0o600 });
  const pending = await store.readPathGuardVault(f.context);
  assert.equal(pending.count, 2);
  assert.equal(pending.records.length, 1);
});
test('record sequence is monotonic, duplicate or oversized stores refuse', async (t) => {
  const f = await fixture(t);
  await f.create();
  await assert.rejects(f.create(2, { sequence: 1 }), {
    message: 'codex-path-guard-recovery-required',
  });
  const { r } = await f.create(2);
  await writeFile(join(r.directory, 'record.json'), 'x'.repeat(binding.MANIFEST_BYTES + 1), {
    mode: 0o600,
  });
  await assert.rejects(store.readPathGuardVault(f.context), {
    message: 'codex-path-guard-store-unavailable',
  });
});
test('invalid retention input refuses before any private vault creation', async (t) => {
  const f = await fixture(t),
    targetPath = join(f.base, '.aws/credentials'),
    p = planner.planCodexPathGuard({ bytes: f.initial, operationId: id(1), targetPath });
  await assert.rejects(
    store.createPathGuardRecord(
      f.context,
      { id: id(1) },
      f.initial,
      Buffer.from(p.bytes),
      async () => {
        throw Error('must not reach guard');
      },
    ),
    { message: 'codex-path-guard-recovery-required' },
  );
  await assert.rejects(readFile(join(f.vault, '.gitignore')), { code: 'ENOENT' });
});
test('record save cannot rewrite durable sequence, original ownership or private target', async (t) => {
  const f = await fixture(t),
    { r } = await f.create(),
    original = await readFile(r.path);
  for (const patch of [
    { sequence: 2 },
    { dependencySha256: 'b'.repeat(64) },
    { credentialTarget: join(f.base, '.npmrc') },
    { profileName: 'other' },
  ])
    await assert.rejects(
      store.savePathGuardManifest(
        f.context,
        { ...r.manifest, ...patch },
        r.revision,
        async () => {},
      ),
      { message: 'codex-path-guard-recovery-required' },
    );
  await assert.rejects(
    store.savePathGuardManifest(
      f.context,
      r.manifest,
      r.revision,
      async () => {},
      join(f.base, 'foreign.json'),
    ),
    { message: 'codex-path-guard-recovery-required' },
  );
  assert.deepEqual(await readFile(r.path), original);
});
async function duplicateRecord(f, source, n, pad) {
  const directory = join(f.vault, id(n));
  await mkdir(directory, { mode: 0o700 }).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  const before =
    pad === undefined
      ? f.initial
      : Buffer.concat([f.initial, Buffer.from('#' + 'x'.repeat(pad) + '\n')]);
  const p = planner.planCodexPathGuard({
    bytes: before,
    operationId: id(n),
    targetPath: source.manifest.credentialTarget,
  });
  const m = {
    ...source.manifest,
    id: id(n),
    operationId: id(n),
    sequence: n,
    originalSha256: binding.controlHash(before),
    candidateSha256: binding.controlHash(p.bytes),
    beforeBytes: before.length,
    candidateBytes: p.bytes.length,
  };
  for (const [name, body] of [
    ['before.toml', before],
    ['candidate.toml', p.bytes],
    ['record.json', JSON.stringify(m)],
  ])
    await writeFile(join(directory, name), body, { mode: 0o600 });
}
test('32 retained records stop admission and physical reservation cap refuses oversized histories', async (t) => {
  await t.test('count', async (t) => {
    const f = await fixture(t),
      { r } = await f.create();
    for (let n = 2; n <= 32; n++) await duplicateRecord(f, r, n);
    const v = await store.readPathGuardVault(f.context);
    assert.equal(v.count, 32);
    await assert.rejects(f.create(33), { message: 'codex-path-guard-store-full' });
  });
  await t.test('bytes', async (t) => {
    const f = await fixture(t),
      { r } = await f.create();
    for (let n = 1; n <= 32; n++) await duplicateRecord(f, r, n, 261800);
    await assert.rejects(store.readPathGuardVault(f.context), {
      message: 'codex-path-guard-store-unavailable',
    });
  });
});
