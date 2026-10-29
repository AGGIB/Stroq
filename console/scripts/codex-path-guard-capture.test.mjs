import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  realpath,
  stat,
  readFile,
  rename,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { runtimeDigest } from './runtime-digest.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-capture-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    api: join(repository, 'console/scripts/codex-path-guard-capture.ts'),
    schema: join(repository, 'console/lib/codex-path-guard.ts'),
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
  schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const digest = (b) => createHash('sha256').update(b).digest('hex');
const original =
  'default_permissions="source"\n[permissions.source]\nextends=":workspace"\n[permissions.source.network]\nenabled=true\n';
async function fixture(t, config = original) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-capture-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    runtime = join(base, 'runtime');
  for (const p of [project, userHome, runtime]) await mkdir(p, { mode: 0o700 });
  await mkdir(join(project, '.git'), { mode: 0o700 });
  await mkdir(join(userHome, '.codex'), { mode: 0o700 });
  await mkdir(join(userHome, '.aws'), { mode: 0o700 });
  const target = join(userHome, '.aws/credentials'),
    configPath = join(userHome, '.codex/config.toml'),
    native = join(base, 'native');
  await writeFile(target, 'inert-unread-secret', { mode: 0o600 });
  await chmod(target, 0);
  await writeFile(configPath, config, { mode: 0o600 });
  await writeFile(native, 'inert-native', { mode: 0o700 });
  const runtimePaths = { cli: join(runtime, 'cli.js'), package: join(runtime, 'package.json') };
  await writeFile(runtimePaths.cli, '// inert');
  await writeFile(runtimePaths.package, '{}');
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
        r = await stat(base);
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
        parents: [{ path: base, dev: r.dev, ino: r.ino, uid: r.uid, mode: r.mode }],
      };
    },
  };
  return { base, project, userHome, target, configPath, options, hooks };
}
test('manual capture derives exact metadata-only routes and valid bounded public report without credential bodies', async (t) => {
  const f = await fixture(t),
    c = await api.capturePathGuard(f.options, f.hooks);
  assert.equal(schema.validateCodexPathGuardCapture(c.public), true);
  assert.equal(c.profileName, 'source');
  assert.equal(c.public.presets[0].target, 'regular');
  assert.equal(c.public.presets[0].canGuard, true);
  assert.equal(c.public.presets[0].reason, null);
  assert.equal(c.public.presets.length, 7);
  assert.ok(c.public.presets.slice(1).every((p) => p.target === 'absent' && p.canGuard));
  assert.equal(c.public.binding.targetMetadataSha256, c.targets.sha256);
  assert.equal(JSON.stringify(c.public).includes(f.userHome), false);
  assert.equal(JSON.stringify(c).includes('inert-unread-secret'), false);
  assert.equal(await readFile(f.configPath, 'utf8'), original);
  assert.equal((await stat(f.target)).mode & 0o777, 0);
  await api.assertPathGuardCapture(f.options, c, f.hooks);
});
test('known declaration denial is not adopted and builtin/legacy/managed/selector overrides remain explicit', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.configPath,
    original + '[permissions.source.filesystem]\n' + JSON.stringify(f.target) + '="deny"\n',
  );
  let c = await api.capturePathGuard(f.options, f.hooks);
  assert.equal(c.public.presets[0].declaration, 'deny');
  assert.equal(c.public.presets[0].canGuard, false);
  assert.equal(c.public.presets[0].reason, 'codex-path-guard-already-denied');
  for (const config of ['default_permissions=":workspace"\n', 'sandbox_mode="workspace-write"\n']) {
    await writeFile(f.configPath, config);
    c = await api.capturePathGuard(f.options, f.hooks);
    assert.ok(c.public.presets.every((p) => !p.canGuard));
    assert.equal(schema.validateCodexPathGuardCapture(c.public), true);
  }
  await writeFile(f.configPath, original);
  await mkdir(join(f.project, '.codex'));
  await writeFile(join(f.project, '.codex/config.toml'), 'default_permissions="source"\n');
  c = await api.capturePathGuard(f.options, f.hooks);
  assert.equal(c.public.reason, 'codex-path-guard-project-override');
  await rm(join(f.project, '.codex'), { recursive: true });
  const managed = join(f.base, 'requirements.toml');
  await writeFile(managed, '[permissions]\nallowed_permission_profiles=[":read-only"]\n');
  c = await api.capturePathGuard(
    { ...f.options, systemSources: [{ path: managed, scope: 'managed' }] },
    f.hooks,
  );
  assert.equal(c.public.reason, 'codex-path-guard-managed-unverified');
  assert.ok(c.public.presets.every((p) => !p.canGuard));
});
test('target replacement invalidates Guard admission; Restore can still be prepared after target disappearance', async (t) => {
  const f = await fixture(t),
    c = await api.capturePathGuard(f.options, f.hooks);
  await writeFile(join(f.userHome, '.aws/replacement'), 'inert-unread-secret', { mode: 0o600 });
  await rename(join(f.userHome, '.aws/replacement'), f.target);
  await assert.rejects(api.assertPathGuardCapture(f.options, c, f.hooks), /codex-path-guard-stale/);
  await rm(f.target);
  await api.assertPathGuardCapture(f.options, c, f.hooks, 'restore');
  await writeFile(f.configPath, original + '# later edit\n');
  await assert.rejects(
    api.assertPathGuardCapture(f.options, c, f.hooks, 'restore'),
    /codex-path-guard-stale/,
  );
});
test('source graph changes invalidate capture while a failed inspection returns a finite report without private data', async (t) => {
  const f = await fixture(t),
    c = await api.capturePathGuard(f.options, f.hooks);
  await mkdir(join(f.project, '.codex'));
  await writeFile(
    join(f.project, '.codex/config.toml'),
    '[permissions.source.filesystem]\n"/owned/unrelated"="deny"\n',
  );
  await assert.rejects(api.assertPathGuardCapture(f.options, c, f.hooks), /codex-path-guard-stale/);
  await writeFile(
    f.configPath,
    'default_permissions="a"\ndefault_permissions="b"\n# private failure details\n',
  );
  const report = await api.inspectPathGuard(f.options, f.hooks);
  assert.equal(schema.validateCodexPathGuardCapture(report), true);
  assert.equal(report.binding, null);
  assert.ok(report.presets.every((p) => !p.canGuard));
  assert.equal(JSON.stringify(report).includes('private failure details'), false);
});
test('history and Restore capture never inspect credential-target metadata; explicit Inspect is the only admission', async (t) => {
  const f = await fixture(t);
  let inspected = 0;
  const hooks = {
    ...f.hooks,
    targetCapture: async () => {
      inspected++;
      throw Error('metadata-not-authorized');
    },
  };
  const c = await api.capturePathGuard(f.options, hooks, 'restore');
  assert.equal(inspected, 0);
  assert.ok(
    c.targets.targets.every(
      (p) => p.status === 'unavailable' && p.file === null && p.directories.length === 0,
    ),
  );
  assert.equal(schema.validateCodexPathGuardCapture(c.public), true);
  assert.ok(c.public.presets.every((p) => !p.canGuard));
  await api.assertPathGuardCapture(f.options, c, hooks, 'restore');
  assert.equal(inspected, 0);
  await assert.rejects(
    api.capturePathGuard(f.options, hooks, 'guard'),
    /codex-path-guard-unavailable/,
  );
  assert.equal(inspected, 1);
});
