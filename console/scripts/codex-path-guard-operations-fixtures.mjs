import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { runtimeDigest } from './runtime-digest.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-ops-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    api: join(repository, 'console/scripts/codex-path-guard-operations.ts'),
    schema: join(repository, 'console/lib/codex-path-guard.ts'),
    private: join(repository, 'console/lib/codex-path-guard-private.ts'),
    network: join(repository, 'console/scripts/codex-network-guard-operations.ts'),
    networkStore: join(repository, 'console/scripts/codex-network-guard-store.ts'),
    networkPlanner: join(repository, 'console/scripts/codex-network-guard-toml.ts'),
    pathStore: join(repository, 'console/scripts/codex-path-guard-store.ts'),
    pathPlanner: join(repository, 'console/scripts/codex-path-guard-toml.ts'),
    pathCapture: join(repository, 'console/scripts/codex-path-guard-capture.ts'),
    binding: join(repository, 'console/scripts/codex-path-guard-binding.ts'),
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
export const api = await import(pathToFileURL(join(output, 'api.mjs')).href),
  schema = await import(pathToFileURL(join(output, 'schema.mjs')).href),
  privateSchema = await import(pathToFileURL(join(output, 'private.mjs')).href);
export const cross = Object.fromEntries(
  await Promise.all(
    [
      'network',
      'networkStore',
      'networkPlanner',
      'pathStore',
      'pathPlanner',
      'pathCapture',
      'binding',
    ].map(async (name) => [name, await import(pathToFileURL(join(output, name + '.mjs')).href)]),
  ),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const original =
  'default_permissions="source"\n[permissions.source]\nextends=":workspace"\nnetwork={enabled=false}\n';
export async function fixture(t, { config = original, custom = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-ops-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const userHome = join(base, 'user'),
    project = join(base, 'project'),
    runtime = join(base, 'runtime');
  for (const p of [userHome, project, runtime]) await mkdir(p, { mode: 0o700 });
  await mkdir(join(project, '.git'), { mode: 0o700 });
  const home = join(userHome, custom ? 'custom-codex' : '.codex');
  await mkdir(home, { mode: 0o700 });
  const target = join(home, 'config.toml');
  await writeFile(target, config, { mode: 0o640 });
  const native = join(base, 'native');
  await writeFile(native, 'inert-native', { mode: 0o700 });
  const runtimePaths = { cli: join(runtime, 'cli.js'), package: join(runtime, 'package.json') };
  await writeFile(runtimePaths.cli, '// fixture');
  await writeFile(runtimePaths.package, '{}');
  const options = {
    project,
    userHome,
    deadline: Date.now() + 120000,
    runtimePaths,
    runtimeSha256: await runtimeDigest(runtimePaths),
    systemSources: [],
    ...(custom ? { codexEnvironment: { CODEX_HOME: home } } : {}),
  };
  let nativeCaptures = 0;
  const hooks = {
    nativeCapture: async () => {
      nativeCaptures++;
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
  const run = (op, data = {}, extra = {}) =>
    api.runCodexPathGuardOperation('codex-path-' + op, options, data, { ...hooks, ...extra });
  const state = (extra) => run('state', {}, extra),
    capture = () => run('capture'),
    preview = (request) => run('preview', { request });
  const select = async (presetId = 'aws-credentials') => {
    const c = await capture();
    return {
      operation: 'guard',
      controlContextId: c.binding.controlContextId,
      captureSha256: c.binding.captureSha256,
      presetId,
    };
  };
  const apply = (plan, fault) =>
    run(
      'apply',
      {
        privatePlan: structuredClone(plan),
        acknowledgeSharedUserConfig: true,
        acknowledgeRetention: true,
        ...(plan.request.operation === 'restore' ? { acknowledgeWeakening: true } : {}),
        writerLockHeld: true,
      },
      { fault },
    );
  const restore = (record) =>
    preview({
      operation: 'restore',
      controlContextId: record.controlContextId,
      recordId: record.id,
      recordRevision: record.revision,
    });
  const recheck = (record) =>
    run('recheck', {
      request: {
        controlContextId: record.controlContextId,
        recordId: record.id,
        recordRevision: record.revision,
        operationId: record.operationId,
      },
      writerLockHeld: true,
    });
  return {
    base,
    userHome,
    project,
    target,
    native,
    options,
    hooks,
    run,
    state,
    capture,
    preview,
    select,
    apply,
    restore,
    recheck,
    get nativeCaptures() {
      return nativeCaptures;
    },
  };
}
