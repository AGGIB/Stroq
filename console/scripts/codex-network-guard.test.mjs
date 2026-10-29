import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  rename,
  chmod,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-guard-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    api: join(repository, 'console/scripts/codex-network-guard-operations.ts'),
    schema: join(repository, 'console/lib/codex-network-guard.ts'),
    adapter: join(repository, 'console/lib/inventory.ts'),
    skills: join(repository, 'console/scripts/codex-skill-control-operations.ts'),
    skillCapture: join(repository, 'console/scripts/codex-skill-source-capture.ts'),
  },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  config: false,
  dts: false,
  splitting: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod', 'smol-toml'],
  banner: {
    js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);",
  },
  esbuildOptions(o) {
    o.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const api = await import(pathToFileURL(join(output, 'api.mjs')).href),
  schema = await import(pathToFileURL(join(output, 'schema.mjs')).href),
  adapter = await import(pathToFileURL(join(output, 'adapter.mjs')).href);
test('compiled inventory adapter exports closed DTO validators AND finite errors', () => {
  assert.deepEqual(adapter.CODEX_NETWORK_GUARD_ERRORS, schema.CODEX_NETWORK_GUARD_ERRORS);
  for (const name of [
    'Binding',
    'Capture',
    'Selection',
    'RestoreSelection',
    'RecheckSelection',
    'Preview',
    'Record',
    'State',
    'Receipt',
  ])
    assert.equal(typeof adapter['validateCodexNetworkGuard' + name], 'function');
  for (const name of [
    'validateCodexNetworkGuardPrivatePlan',
    'codexNetworkGuardPrivatePlanBytes',
    'validateCodexNetworkGuardCheckPreparation',
    'codexNetworkGuardCheckPreparationBytes',
  ])
    assert.equal(typeof adapter[name], 'function');
  assert.equal(
    adapter.validateCodexNetworkGuardSelection({
      operation: 'guard',
      controlContextId: 'codex-context-' + 'a'.repeat(64),
      captureSha256: 'b'.repeat(64),
      path: '/tmp/arbitrary',
    }),
    false,
  );
});

const { runtimeDigest } = await import(
  pathToFileURL(join(repository, 'console/scripts/runtime-digest.mjs')).href
);
const skillApi = await import(pathToFileURL(join(output, 'skills.mjs')).href),
  skillCapture = await import(pathToFileURL(join(output, 'skillCapture.mjs')).href);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('a clock tick cannot extend the new network preview beyond its validator lifetime', async (t) => {
  const f = await fixture(t),
    request = await f.select();
  const OriginalDate = Date;
  let clock = OriginalDate.now();
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [clock++]));
    }
    static now() {
      return clock++;
    }
  };
  try {
    const p = await f.preview(request);
    assert.equal(
      OriginalDate.parse(p.preview.expiresAt) - OriginalDate.parse(p.preview.createdAt),
      120000,
    );
    assert.equal(adapter.validateCodexNetworkGuardPrivatePlan(p.privatePlan), true);
  } finally {
    globalThis.Date = OriginalDate;
  }
});
async function fixture(
  t,
  config = 'default_permissions = "source"\n[permissions.source]\nextends = ":workspace"\n[permissions.source.network]\nenabled = true\n',
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-guard-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const userHome = join(base, 'user'),
    project = join(base, 'project'),
    runtime = join(base, 'runtime');
  for (const p of [userHome, project, runtime]) await mkdir(p, { mode: 0o700 });
  await mkdir(join(userHome, '.codex'), { mode: 0o700 });
  const target = join(userHome, '.codex', 'config.toml');
  await writeFile(target, config, { mode: 0o640 });
  await writeFile(join(runtime, 'cli.js'), '// fixture');
  await writeFile(join(runtime, 'package.json'), '{}');
  const native = join(base, 'native-codex');
  await writeFile(native, 'fixture-native', { mode: 0o700 });
  const runtimePaths = { cli: join(runtime, 'cli.js'), package: join(runtime, 'package.json') };
  const options = {
    project,
    userHome,
    deadline: Date.now() + 60000,
    runtimePaths,
    runtimeSha256: await runtimeDigest(runtimePaths),
    systemSources: [],
  };
  const hooks = {
    nativeCapture: async () => {
      const s = await stat(native),
        d = await stat(base);
      return {
        path: native,
        sha256: digest(await readFile(native)),
        file: {
          dev: s.dev,
          ino: s.ino,
          uid: s.uid,
          mode: s.mode,
          nlink: s.nlink,
          size: s.size,
          mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs,
        },
        version: 'codex-cli 0.164.0-alpha.11.1',
        platform: 'darwin',
        parents: [{ path: base, dev: d.dev, ino: d.ino, uid: d.uid, mode: d.mode }],
      };
    },
  };
  const capture = () =>
      api.runCodexNetworkGuardOperation('codex-network-capture', options, {}, hooks),
    state = () => api.runCodexNetworkGuardOperation('codex-network-state', options, {}, hooks);
  const preview = async (request) =>
    api.runCodexNetworkGuardOperation('codex-network-preview', options, { request }, hooks);
  const select = async () => {
    const c = await capture();
    assert.equal(schema.validateCodexNetworkGuardCapture(c), true);
    assert.ok(c.binding);
    return {
      operation: 'guard',
      controlContextId: c.binding.controlContextId,
      captureSha256: c.binding.captureSha256,
    };
  };
  const apply = async (plan, fault) =>
    api.runCodexNetworkGuardOperation(
      'codex-network-apply',
      options,
      {
        privatePlan: structuredClone(plan),
        acknowledgeSharedUserConfig: true,
        acknowledgeRetention: true,
        ...(plan.request.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
        writerLockHeld: true,
      },
      { ...hooks, fault },
    );
  const restore = (record) =>
    preview({
      operation: 'restore',
      controlContextId: record.controlContextId,
      recordId: record.id,
      recordRevision: record.revision,
    });
  const recheck = (record) =>
    api.runCodexNetworkGuardOperation(
      'codex-network-recheck',
      options,
      {
        request: {
          controlContextId: record.controlContextId,
          recordId: record.id,
          recordRevision: record.revision,
          operationId: record.operationId,
        },
        writerLockHeld: true,
      },
      hooks,
    );
  return {
    base,
    userHome,
    project,
    target,
    native,
    options,
    hooks,
    capture,
    state,
    select,
    preview,
    apply,
    restore,
    recheck,
  };
}
test('passive capture and state create no history or native process and expose no paths', async (t) => {
  const f = await fixture(t),
    s = await f.state(),
    c = await f.capture();
  assert.equal(schema.validateCodexNetworkGuardState(s), true);
  assert.equal(c.canGuard, true);
  assert.equal(c.actionKind, 'profile-network-off');
  assert.equal(JSON.stringify(c).includes(f.base), false);
  assert.equal(s.history, 'missing');
  await assert.rejects(readFile(join(f.userHome, '.stroq', 'codex-network-guard', '.gitignore')), {
    code: 'ENOENT',
  });
});
test('in-place network reduction keeps profile identity/FS/default and Restore preserves later selector', async (t) => {
  const initial =
    'default_permissions = "source"\n[permissions.source]\nextends = ":workspace"\n[permissions.source.filesystem]\n":root" = "deny"\n":minimal" = "read"\n[permissions.source.network]\nenabled = true\n';
  const f = await fixture(t, initial),
    p = await f.preview(await f.select());
  const r = await f.apply(p.privatePlan);
  assert.equal(schema.validateCodexNetworkGuardReceipt(r), true);
  assert.equal(r.record.standing, 'selected');
  assert.equal(r.record.ownership, 'current');
  assert.equal(r.record.canRestore, true);
  const changed = await readFile(f.target, 'utf8');
  assert.ok(changed.includes('default_permissions = "source"'));
  assert.ok(changed.includes('\n":root" = "deny"\n":minimal" = "read"\n'));
  assert.ok(changed.includes('enabled = false'));
  assert.equal(changed.includes('stroq-network-' + r.record.id), false);
  await writeFile(
    f.target,
    changed.replace('default_permissions = "source"', 'default_permissions = ":read-only"') +
      '\n[other]\nkeep = true\n',
  );
  const rp = await f.restore(r.record),
    restored = await f.apply(rp.privatePlan);
  assert.equal(restored.record.operationStatus, 'restored');
  const final = await readFile(f.target, 'utf8');
  assert.ok(final.includes('default_permissions = ":read-only"'));
  assert.ok(final.includes('enabled = true'));
  assert.ok(final.includes('[other]\nkeep = true'));
});
test('legacy boolean and fullaccess mode reduction preserve existing root and tmp fields', async (t) => {
  for (const mode of ['workspace-write', 'danger-full-access'])
    await t.test(mode, async (t) => {
      const text = `sandbox_mode = "${mode}"\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/fixture/extra"]\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n`;
      const f = await fixture(t, text),
        c = await f.capture();
      assert.equal(c.canGuard, true);
      const p = await f.preview(await f.select()),
        r = await f.apply(p.privatePlan);
      const current = await readFile(f.target, 'utf8');
      assert.ok(current.includes('network_access = false'));
      assert.ok(current.includes('writable_roots = ["/fixture/extra"]'));
      assert.ok(current.includes('exclude_tmpdir_env_var = true'));
      assert.ok(current.includes('exclude_slash_tmp = true'));
      const restored = await f.apply((await f.restore(r.record)).privatePlan);
      assert.equal(restored.record.operationStatus, 'restored');
      assert.equal(await readFile(f.target, 'utf8'), text);
    });
});
test('known implicit read-only and builtin off are no-op without ownership', async (t) => {
  for (const text of [
    '[sandbox_workspace_write]\nnetwork_access = true\n',
    '',
    'default_permissions = ":workspace"\n',
  ]) {
    const f = await fixture(t, text),
      c = await f.capture();
    assert.equal(c.canGuard, false);
    assert.equal(c.reason, 'codex-network-already-off');
    assert.equal(c.canCheck, true);
    assert.equal((await f.state()).records.length, 0);
  }
});
test('Check graph uses nearest project filesystem edits and refuses detected managed policy', async (t) => {
  const f = await fixture(
    t,
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\n[permissions.source.network]\nenabled=false\n',
  );
  await mkdir(join(f.base, '.git'));
  await mkdir(join(f.base, '.codex'));
  await mkdir(join(f.project, '.codex'));
  await writeFile(
    join(f.base, '.codex', 'config.toml'),
    '[permissions.source.filesystem]\n":root"="deny"\n',
  );
  await writeFile(
    join(f.project, '.codex', 'config.toml'),
    '[permissions.source.filesystem]\n":root"="read"\n',
  );
  const c = await f.capture();
  assert.equal(c.canCheck, true);
  const p = await api.runCodexNetworkGuardOperation(
    'codex-network-check-prepare',
    f.options,
    {
      request: {
        controlContextId: c.binding.controlContextId,
        captureSha256: c.binding.captureSha256,
      },
    },
    f.hooks,
  );
  assert.equal(p.profiles.source.filesystem[':root'], 'read');
  const managed = join(f.base, 'requirements.toml');
  await writeFile(managed, 'allowed_permission_profiles=["source"]\n');
  f.options.systemSources = [{ path: managed, scope: 'managed' }];
  assert.equal((await f.capture()).canCheck, false);
});
test('private Check boundary rejects extra authority, cycles, network-on and stale capture', async (t) => {
  const f = await fixture(
    t,
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\n[permissions.source.network]\nenabled=false\n',
  );
  const c = await f.capture();
  const req = {
      controlContextId: c.binding.controlContextId,
      captureSha256: c.binding.captureSha256,
    },
    p = await api.runCodexNetworkGuardOperation(
      'codex-network-check-prepare',
      f.options,
      { request: req },
      f.hooks,
    );
  for (const mutate of [
    (v) => (v.auth = { token: 'private' }),
    (v) => (v.profiles.source.network.enabled = true),
    (v) => (v.profiles.source.extends = 'source'),
    (v) => (v.profiles.unreachable = {}),
    (v) => (v.profiles.source.network.proxy_url = 'http://localhost'),
    (v) => (v.native.sha256 = 'a'.repeat(64)),
    (v) => (v.sourcePins[0].bytes = 'raw-config'),
  ]) {
    const bad = structuredClone(p);
    mutate(bad);
    assert.equal(adapter.validateCodexNetworkGuardCheckPreparation(bad), false);
    assert.equal(adapter.codexNetworkGuardCheckPreparationBytes(bad), Infinity);
  }
  for (const bad of [null, 0, 'x', [], { profiles: 0 }])
    assert.equal(adapter.validateCodexNetworkGuardCheckPreparation(bad), false);
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace('enabled=false', 'enabled=true'),
  );
  await assert.rejects(
    api.runCodexNetworkGuardOperation(
      'codex-network-check-prepare',
      f.options,
      { request: req },
      f.hooks,
    ),
    { message: 'codex-network-stale' },
  );
  assert.equal((await f.capture()).canCheck, false);
});
test('orphan metadata is retained and blocks additional publication within the physical reserve', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select());
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('lost');
    }),
    /write-unconfirmed/,
  );
  const r = (await f.state()).records[0],
    temporary = join(
      f.userHome,
      '.stroq',
      'codex-network-guard',
      r.id,
      '.stroq-11111111-1111-4111-8111-111111111111.tmp',
    );
  await writeFile(temporary, '{}', { mode: 0o600 });
  const before = await readFile(f.target);
  await assert.rejects(f.recheck(r), { message: 'codex-network-recovery-required' });
  assert.deepEqual(await readFile(f.target), before);
  assert.equal(await readFile(temporary, 'utf8'), '{}');
  assert.equal((await f.state()).available, false);
});
test('same bytes in a replaced config parent and changed native mode refuse before retention', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select()),
    parent = dirname(f.target);
  await rename(parent, parent + '-old');
  await mkdir(parent, { mode: 0o700 });
  await rename(join(parent + '-old', 'config.toml'), f.target);
  const current = await readFile(f.target);
  await assert.rejects(f.apply(p.privatePlan), { message: 'codex-network-stale' });
  assert.deepEqual(await readFile(f.target), current);
  assert.equal((await f.state()).records.length, 0);
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await chmod(g.native, 0o500);
  await assert.rejects(g.apply(q.privatePlan), { message: 'codex-network-native-changed' });
  assert.equal((await g.state()).records.length, 0);
});
test('source alias redirection after intent cannot publish against an obsolete canonical source', async (t) => {
  const f = await fixture(t),
    a = join(f.base, 'source-a'),
    b = join(f.base, 'source-b'),
    alias = join(f.base, 'source-link');
  await mkdir(a);
  await mkdir(b);
  for (const path of [a, b]) await writeFile(join(path, 'config.toml'), '# persistent source\n');
  await symlink(a, alias);
  f.options.systemSources = [{ path: join(alias, 'config.toml'), scope: 'system' }];
  const p = await f.preview(await f.select()),
    before = await readFile(f.target);
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-intent') {
        await rm(alias);
        await symlink(b, alias);
      }
    }),
    { message: 'codex-network-write-unconfirmed' },
  );
  assert.deepEqual(await readFile(f.target), before);
  assert.equal((await f.state()).records[0].operationStatus, 'unknown');
});
test('system-only named profile cannot advertise an unsupported user overlay action', async (t) => {
  const f = await fixture(t, 'default_permissions="source"\n'),
    system = join(f.base, 'system.toml');
  await writeFile(
    system,
    '[permissions.source]\nextends=":workspace"\n[permissions.source.network]\nenabled=true\n',
  );
  f.options.systemSources = [{ path: system, scope: 'system' }];
  const c = await f.capture();
  assert.equal(c.canGuard, false);
  assert.equal(c.reason, 'codex-network-parent-unavailable');
  assert.equal((await f.state()).records.length, 0);
  await writeFile(
    system,
    (await readFile(system, 'utf8')).replace('enabled=true', 'enabled=false'),
  );
  const off = await f.capture();
  assert.equal(off.canCheck, true);
  const p = await api.runCodexNetworkGuardOperation(
    'codex-network-check-prepare',
    f.options,
    {
      request: {
        controlContextId: off.binding.controlContextId,
        captureSha256: off.binding.captureSha256,
      },
    },
    f.hooks,
  );
  assert.equal(p.profiles.source.network.enabled, false);
});
test('newer overlapping guard permanently supersedes older Restore through boolean cycles', async (t) => {
  const f = await fixture(t),
    p1 = await f.preview(await f.select()),
    r1 = await f.apply(p1.privatePlan);
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace('enabled = false', 'enabled = true'),
  );
  const p2 = await f.preview(await f.select()),
    r2 = await f.apply(p2.privatePlan);
  let s = await f.state(),
    old = s.records.find((r) => r.id === r1.record.id);
  assert.equal(old.ownership, 'superseded');
  assert.equal(old.canRestore, false);
  const before = await readFile(f.target);
  await assert.rejects(f.restore(r1.record), { message: 'codex-network-superseded' });
  assert.deepEqual(await readFile(f.target), before);
  await f.apply((await f.restore(r2.record)).privatePlan);
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace('enabled = true', 'enabled = false'),
  );
  old = (await f.state()).records.find((r) => r.id === r1.record.id);
  assert.equal(old.ownership, 'superseded');
  await assert.rejects(f.restore(old), { message: 'codex-network-superseded' });
});
test('exact staged inode recovers unknown once; equal foreign bytes and old hashes cannot clear it', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select());
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('lost');
    }),
    { message: 'codex-network-write-unconfirmed' },
  );
  const s = await f.state();
  assert.equal(s.records[0].operationStatus, 'unknown');
  const checked = await f.recheck(s.records[0]);
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.operationStatus, 'guarded');
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await assert.rejects(
    g.apply(q.privatePlan, async (stage) => {
      if (stage === 'after-intent') throw Error('lost');
    }),
    { message: 'codex-network-write-unconfirmed' },
  );
  let pending = (await g.state()).records[0];
  assert.equal((await g.recheck(pending)).writeConfirmed, false);
  await writeFile(g.target, Buffer.from(q.privatePlan.candidate));
  pending = (await g.state()).records[0];
  assert.equal((await g.recheck(pending)).writeConfirmed, false);
});
test('unknown Restore requires its exact operation and completed proof stays historical', async (t) => {
  const f = await fixture(t),
    guarded = await f.apply((await f.preview(await f.select())).privatePlan),
    p = await f.restore(guarded.record);
  await assert.rejects(
    f.apply(p.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('lost');
    }),
    /write-unconfirmed/,
  );
  const pending = (await f.state()).records[0];
  assert.equal(pending.operationStatus, 'unknown');
  assert.equal(pending.operationId, p.preview.operationId);
  await assert.rejects(f.recheck({ ...pending, operationId: guarded.operationId }), {
    message: 'codex-network-stale',
  });
  assert.equal((await f.state()).records[0].operationStatus, 'unknown');
  const checked = await f.recheck(pending);
  assert.equal(checked.writeConfirmed, true);
  assert.equal(checked.record.operationStatus, 'restored');
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace('enabled = true', 'enabled = false'),
  );
  const historical = await f.recheck((await f.state()).records[0]);
  assert.equal(historical.writeConfirmed, true);
  assert.equal(historical.record.operationStatus, 'restored');
  assert.equal(historical.record.standing, 'selected');
  assert.equal(historical.record.canRestore, false);
});
test('retained history stops at 32 records without eviction or partial 33rd retention', async (t) => {
  const f = await fixture(t);
  let first;
  for (let n = 0; n < 32; n++) {
    if (n)
      await writeFile(
        f.target,
        (await readFile(f.target, 'utf8')).replace('enabled = false', 'enabled = true'),
      );
    const r = await f.apply((await f.preview(await f.select())).privatePlan);
    first ??= r.record.id;
  }
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace('enabled = false', 'enabled = true'),
  );
  const p = await f.preview(await f.select()),
    before = await readFile(f.target);
  await assert.rejects(f.apply(p.privatePlan), { message: 'codex-network-store-full' });
  assert.deepEqual(await readFile(f.target), before);
  const state = await f.state();
  assert.equal(state.records.length, 32);
  assert.equal(state.records.find((r) => r.id === first).ownership, 'superseded');
  assert.equal(state.available, true);
});
async function skillSelection(f) {
  const path = join(f.project, '.agents', 'skills', 'notes', 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '---\nname: notes\ndescription: Summarize notes.\n---\nNotes.\n');
  const c = await skillCapture.captureCodexSkillSources(f.options),
    i = c.items[0];
  return {
    operation: 'disable',
    controlContextId: c.context.controlContextId,
    sourceId: i.sourceId,
    candidateId: i.id,
    expectedEntrypointSha256: i.entrypointSha256,
    expectedConfigSha256: c.settings.sha256,
    expectedRuntimeSha256: c.runtimeSha256,
  };
}
test('pending skill write blocks network mutation until exact skill recheck; inverse is also safe', async (t) => {
  const f = await fixture(t);
  let selection = await skillSelection(f),
    sp = await skillApi.runCodexSkillControlOperation('codex-control-preview', f.options, {
      request: selection,
    });
  await assert.rejects(
    skillApi.runCodexSkillControlOperation(
      'codex-control-apply',
      f.options,
      {
        privatePlan: sp.privatePlan,
        acknowledgeSharedUserConfig: true,
        acknowledgeRetention: true,
        writerLockHeld: true,
      },
      {
        fault: async (stage) => {
          if (stage === 'after-target-rename') throw Error('lost');
        },
      },
    ),
    /write-unconfirmed/,
  );
  const original = await readFile(f.target);
  await assert.rejects(f.preview(await f.select()), { message: 'codex-network-recovery-required' });
  assert.deepEqual(await readFile(f.target), original);
  assert.equal((await f.state()).records.length, 0);
  const pending = (
    await skillApi.runCodexSkillControlOperation('codex-control-state', f.options, {})
  ).records[0];
  const checked = await skillApi.runCodexSkillControlOperation('codex-control-recheck', f.options, {
    request: {
      controlContextId: pending.controlContextId,
      recordId: pending.id,
      recordRevision: pending.revision,
      operationId: pending.operationId,
    },
    writerLockHeld: true,
  });
  assert.equal(checked.writeConfirmed, true);
  const guard = await f.apply((await f.preview(await f.select())).privatePlan);
  assert.equal(guard.writeConfirmed, true);
  const g = await fixture(t);
  await skillSelection(g);
  const np = await g.preview(await g.select());
  await assert.rejects(
    g.apply(np.privatePlan, async (stage) => {
      if (stage === 'after-target-rename') throw Error('lost');
    }),
    /write-unconfirmed/,
  );
  selection = await skillSelection(g);
  const guardBytes = await readFile(g.target);
  await assert.rejects(
    skillApi.runCodexSkillControlOperation('codex-control-preview', g.options, {
      request: selection,
    }),
    { message: 'codex-control-recovery-required' },
  );
  assert.deepEqual(await readFile(g.target), guardBytes);
  const nr = (await g.state()).records[0];
  assert.equal((await g.recheck(nr)).writeConfirmed, true);
  sp = await skillApi.runCodexSkillControlOperation('codex-control-preview', g.options, {
    request: selection,
  });
  assert.ok(sp.privatePlan);
});
test('different named profile ownership does not spuriously supersede earlier fields', async (t) => {
  const f = await fixture(t),
    r1 = await f.apply((await f.preview(await f.select())).privatePlan);
  await writeFile(
    f.target,
    (await readFile(f.target, 'utf8')).replace(
      'default_permissions = "source"',
      'default_permissions = "other"',
    ) +
      '\n[permissions.other]\nextends = ":workspace"\n[permissions.other.network]\nenabled = true\n',
  );
  await f.apply((await f.preview(await f.select())).privatePlan);
  const old = (await f.state()).records.find((r) => r.id === r1.record.id);
  assert.equal(old.ownership, 'current');
  assert.equal(old.canRestore, true);
  assert.equal(
    (await f.apply((await f.restore(old)).privatePlan)).record.operationStatus,
    'restored',
  );
});
test('project source overrides, unsupported network escapes, mixed config and managed files refuse guard', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.codex'));
  await writeFile(join(f.project, '.codex', 'config.toml'), 'default_permissions = ":workspace"\n');
  assert.equal((await f.capture()).reason, 'codex-network-project-override');
  const mixed = await fixture(
    t,
    'default_permissions = ":workspace"\nsandbox_mode = "read-only"\n',
  );
  assert.equal((await mixed.capture()).reason, 'codex-network-mixed-config');
  const unsafe = await fixture(
    t,
    'default_permissions="source"\n[permissions.source.network]\nenabled=true\ndangerously_allow_all_unix_sockets=true\n',
  );
  assert.equal((await unsafe.capture()).reason, 'codex-network-unsupported');
  const managed = await fixture(t),
    path = join(managed.base, 'requirements.toml');
  await writeFile(path, 'allowed_sandbox_modes=["read-only"]\n');
  managed.options.systemSources = [{ path, scope: 'managed' }];
  assert.equal((await managed.capture()).reason, 'codex-network-managed-unverified');
});
test('source/native drift and consent failures cannot retain or mutate a new guard', async (t) => {
  const f = await fixture(t),
    p = await f.preview(await f.select());
  await writeFile(f.target, (await readFile(f.target, 'utf8')) + '\n# foreign\n');
  await assert.rejects(f.apply(p.privatePlan), { message: 'codex-network-stale' });
  assert.equal((await f.state()).records.length, 0);
  const g = await fixture(t),
    q = await g.preview(await g.select());
  await writeFile(g.native, 'changed-native');
  await assert.rejects(g.apply(q.privatePlan), { message: 'codex-network-native-changed' });
  assert.equal((await g.state()).records.length, 0);
  const h = await fixture(t),
    r = await h.preview(await h.select());
  await assert.rejects(
    api.runCodexNetworkGuardOperation(
      'codex-network-apply',
      h.options,
      { privatePlan: r.privatePlan, writerLockHeld: true },
      h.hooks,
    ),
    { message: 'codex-network-consent-required' },
  );
  assert.equal((await h.state()).records.length, 0);
});
test('already-off defaults prepare an auth-free closed native check without a Guard record', async (t) => {
  for (const config of [
    '',
    'default_permissions = ":workspace"\n',
    'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access=false\nwritable_roots=["/fixture/extra"]\nexclude_slash_tmp=true\n',
  ]) {
    const f = await fixture(t, config),
      c = await f.capture();
    assert.equal(c.canGuard, false);
    assert.equal(c.canCheck, true);
    assert.equal(c.reason, 'codex-network-already-off');
    const prepared = await api.runCodexNetworkGuardOperation(
      'codex-network-check-prepare',
      f.options,
      {
        request: {
          controlContextId: c.binding.controlContextId,
          captureSha256: c.binding.captureSha256,
        },
      },
      f.hooks,
    );
    assert.equal(adapter.validateCodexNetworkGuardCheckPreparation(prepared), true);
    assert.deepEqual(Object.keys(prepared).sort(), [
      'binding',
      'kind',
      'managedUnverified',
      'native',
      'networkOff',
      'profiles',
      'selectedProfile',
      'sourcePins',
    ]);
    assert.equal(JSON.stringify(prepared).includes('snapshot'), false);
    assert.equal(prepared.networkOff, true);
    assert.equal((await f.state()).records.length, 0);
  }
});
test('Check preserves policy graph and refuses unsupported endpoints without blocking safe Guard', async (t) => {
  const f = await fixture(
    t,
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\ndescription="private description"\n[permissions.source.filesystem]\nglob_scan_max_depth=3\n[permissions.source.filesystem.":workspace_roots"]\n"**/*.env"="deny"\n[permissions.source.network]\nenabled=false\n[permissions.source.network.domains]\n"bad.example"="deny"\n[permissions.source.network.unix_sockets]\n"/fixture/socket"="deny"\n',
  );
  const c = await f.capture();
  assert.equal(c.canCheck, true);
  const p = await api.runCodexNetworkGuardOperation(
    'codex-network-check-prepare',
    f.options,
    {
      request: {
        controlContextId: c.binding.controlContextId,
        captureSha256: c.binding.captureSha256,
      },
    },
    f.hooks,
  );
  assert.equal(p.profiles.source.description, undefined);
  assert.equal(p.profiles.source.filesystem.glob_scan_max_depth, 3);
  assert.equal(p.profiles.source.network.domains['bad.example'], 'deny');
  assert.equal(p.profiles.source.network.unix_sockets['/fixture/socket'], 'deny');
  assert.equal(adapter.validateCodexNetworkGuardCheckPreparation(p), true);
  const g = await fixture(
    t,
    'default_permissions="source"\n[permissions.source]\nextends=":workspace"\n[permissions.source.network]\nenabled=true\nproxy_url="http://127.0.0.1:3128"\n',
  );
  assert.equal((await g.capture()).canGuard, true);
  await g.apply((await g.preview(await g.select())).privatePlan);
  assert.equal((await g.capture()).canCheck, false);
});
test('implicit ambiguous trust is unresolved; exact trusted workspace translation preserves legacy roots', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.target,
    `[projects.${JSON.stringify(f.base)}]\ntrust_level="trusted"\n[sandbox_workspace_write]\nnetwork_access=true\n`,
  );
  const ambiguous = await f.capture();
  assert.equal(ambiguous.canGuard, false);
  assert.equal(ambiguous.canCheck, false);
  assert.equal(ambiguous.baseline.network, 'unknown');
  await writeFile(
    f.target,
    `[projects.${JSON.stringify(f.project)}]\ntrust_level="trusted"\n[sandbox_workspace_write]\nnetwork_access=false\nwritable_roots=["/fixture/extra"]\nexclude_tmpdir_env_var=true\n`,
  );
  const c = await f.capture();
  assert.equal(c.canCheck, true);
  assert.equal(c.baseline.kind, 'implicit');
  const p = await api.runCodexNetworkGuardOperation(
    'codex-network-check-prepare',
    f.options,
    {
      request: {
        controlContextId: c.binding.controlContextId,
        captureSha256: c.binding.captureSha256,
      },
    },
    f.hooks,
  );
  assert.equal(p.kind, 'implicit-translated');
  assert.equal(p.profiles[p.selectedProfile].workspace_roots['/fixture/extra'], true);
  assert.equal(p.profiles[p.selectedProfile].filesystem[':tmpdir'], 'read');
});
test('persistent system trust participates in implicit baseline before declaring network off', async (t) => {
  const f = await fixture(t, '[sandbox_workspace_write]\nnetwork_access=true\n'),
    system = join(f.base, 'system.toml');
  await writeFile(system, `[projects.${JSON.stringify(f.project)}]\ntrust_level="trusted"\n`);
  f.options.systemSources = [{ path: system, scope: 'system' }];
  const c = await f.capture();
  assert.equal(c.baseline.kind, 'implicit');
  assert.equal(c.baseline.profile, 'workspace');
  assert.equal(c.baseline.network, 'on');
  assert.equal(c.canCheck, false);
  assert.equal(c.canGuard, true);
  await f.apply((await f.preview(await f.select())).privatePlan);
  assert.match(await readFile(f.target, 'utf8'), /network_access=false/);
});
