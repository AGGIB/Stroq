import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { build } from 'tsup';
const repo = join(import.meta.dirname, '../..'),
  output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-service-build-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    service: join(import.meta.dirname, 'codex-network-service.ts'),
    backend: join(import.meta.dirname, 'codex-network-guard-operations.ts'),
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
    js: "import{createRequire as fixtureRequire}from'node:module';const require=fixtureRequire(import.meta.url);",
  },
  esbuildOptions(o) {
    o.alias = { '@stroq/core': join(repo, 'packages/core/src/index.ts') };
  },
});
const { createCodexNetworkGuardService } = await import(
    pathToFileURL(join(output, 'service.mjs')).href
  ),
  { runCodexNetworkGuardOperation } = await import(pathToFileURL(join(output, 'backend.mjs')).href);
const { runtimeDigest } = await import('./runtime-digest.mjs');
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-service-'))),
    project = join(base, 'project'),
    userHome = join(base, 'user'),
    runtime = join(base, 'runtime');
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const p of [project, userHome, runtime]) await mkdir(p, { mode: 0o700 });
  await mkdir(join(userHome, '.codex'), { mode: 0o700 });
  const target = join(userHome, '.codex/config.toml'),
    original =
      'default_permissions = "source"\n[permissions.source]\nextends = ":workspace"\n[permissions.source.network]\nenabled = true\n';
  await writeFile(target, original, { mode: 0o600 });
  await writeFile(join(runtime, 'cli.js'), '//cli');
  await writeFile(join(runtime, 'package.json'), '{}');
  const native = join(base, 'native');
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
  const nativeCapture = async () => {
    const s = await stat(native),
      d = await stat(base);
    return {
      path: native,
      sha256: sha(await readFile(native)),
      file: Object.fromEntries(
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((k) => [k, s[k]]),
      ),
      version: 'codex-cli 0.164.0-alpha.11.1',
      platform: 'darwin',
      parents: [{ path: base, dev: d.dev, ino: d.ino, uid: d.uid, mode: d.mode }],
    };
  };
  const calls = [];
  let block = false;
  const inventory = {
    codexNetworkRuntime: async () => {
      await extra.beforeRuntime?.();
      return options.runtimeSha256;
    },
    codexNetworkOperation: async (op, data, extra = {}) => {
      calls.push({ op, data, extra });
      if (block) return { status: 409, body: { error: 'codex-network-busy' } };
      try {
        return {
          status: 200,
          body: await runCodexNetworkGuardOperation(
            op,
            { ...options, deadline: Date.now() + 60000 },
            { ...data, ...(extra.writer ? { writerLockHeld: true } : {}) },
            { nativeCapture },
          ),
        };
      } catch (e) {
        return { status: 409, body: { error: e.message } };
      }
    },
  };
  const service = createCodexNetworkGuardService({ inventory });
  t.after(() => service.close());
  const capture = async () => {
    const r = await service.capture({});
    assert.equal(r.status, 200);
    return r.body;
  };
  const preview = async () => {
    const c = await capture();
    return service.preview({
      operation: 'guard',
      controlContextId: c.binding.controlContextId,
      captureSha256: c.binding.captureSha256,
    });
  };
  const confirm = (p) => ({
    previewId: p.id,
    controlContextId: p.controlContextId,
    acknowledgeSharedUserConfig: true,
    acknowledgeRetention: true,
  });
  return {
    service,
    calls,
    target,
    original,
    capture,
    preview,
    confirm,
    block: () => {
      block = true;
    },
  };
}
test('passive read/capture never starts a native process or changes configuration', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.read()).status, 200);
  await f.capture();
  assert.deepEqual(
    f.calls.map((c) => c.op),
    ['codex-network-state', 'codex-network-capture'],
  );
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});
test('one-use preview hides private plan, consented Apply uses exact shared writer bridge', async (t) => {
  const f = await fixture(t),
    p = await f.preview();
  assert.equal(p.status, 200);
  assert.equal(Object.hasOwn(p.body, 'privatePlan'), false);
  assert.equal(JSON.stringify(p).includes(f.target), false);
  const receipt = await f.service.apply(f.confirm(p.body));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.writeConfirmed, true);
  assert.match(await readFile(f.target, 'utf8'), /enabled = false/);
  assert.equal(f.calls.at(-1).extra.writer, true);
  assert.equal(f.calls.at(-1).data.writerLockHeld, undefined);
  assert.equal((await f.service.apply(f.confirm(p.body))).status, 409);
});
test('malformed consent and busy each consume their known preview before refusal', async (t) => {
  const f = await fixture(t),
    p = (await f.preview()).body;
  assert.equal(
    (await f.service.apply({ ...f.confirm(p), acknowledgeRetention: false })).status,
    400,
  );
  assert.equal((await f.service.apply(f.confirm(p))).status, 409);
  const q = (await f.preview()).body;
  f.block();
  assert.equal((await f.service.apply(f.confirm(q))).body.error, 'codex-network-busy');
  assert.equal((await f.service.apply(f.confirm(q))).body.error, 'codex-network-stale');
});
test('foreign context, arbitrary paths and Guard weakening consent cannot be smuggled into Apply', async (t) => {
  const f = await fixture(t),
    p = (await f.preview()).body;
  assert.equal(
    (
      await f.service.apply({
        ...f.confirm(p),
        controlContextId: 'codex-context-' + '0'.repeat(64),
      })
    ).status,
    400,
  );
  const q = (await f.preview()).body;
  assert.equal(
    (await f.service.apply({ ...f.confirm(q), acknowledgeWeakening: true })).status,
    400,
  );
  assert.equal((await f.service.capture({ path: f.target })).status, 400);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});

test('closing while Apply awaits runtime cannot publish a configuration after shutdown', async (t) => {
  const extra = {},
    f = await fixture(t, extra),
    p = (await f.preview()).body;
  let release, entered;
  const seen = new Promise((r) => {
    entered = r;
  });
  extra.beforeRuntime = () =>
    new Promise((r) => {
      release = r;
      entered();
    });
  const applying = f.service.apply(f.confirm(p));
  await seen;
  const closing = f.service.close();
  release();
  const response = await applying;
  await closing;
  assert.equal(response.status, 503);
  assert.equal(await readFile(f.target, 'utf8'), f.original);
});
