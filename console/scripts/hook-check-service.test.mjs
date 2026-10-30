import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createHookCheckService } from './hook-check-service.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-hook-service-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    schema: join(repository, 'console/lib/hook-checks.ts'),
    status: join(repository, 'console/scripts/agent-status-engine.ts'),
  },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  banner: {
    js: "import {createRequire as createHookServiceRequire} from 'node:module';const require=createHookServiceRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const adapter = await import(pathToFileURL(join(output, 'status.mjs')).href);
const report = () => ({
  status: 'passed',
  standard: { ordinaryAllowed: true, encodedDenied: true },
  probes: [
    {
      id: 'ordinary',
      expectedEffect: 'allow',
      expectedWire: 'allow',
      observedEffect: 'allow',
      wireEffect: 'allow',
      auditConfirmed: true,
      exitCode: 0,
      durationMs: 1,
      matched: true,
    },
    {
      id: 'encoded-fetch',
      expectedEffect: 'deny',
      expectedWire: 'deny',
      observedEffect: 'deny',
      wireEffect: 'deny',
      auditConfirmed: true,
      exitCode: 0,
      durationMs: 1,
      matched: true,
    },
  ],
});
async function fixture(t, { agent = 'cursor', scope = 'project', ...overrides } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-hook-service-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'profile'),
    home = join(userHome, '.stroq');
  await Promise.all([mkdir(project), mkdir(userHome)]);
  const path = agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;
  const source = join(scope === 'user' ? userHome : project, path);
  await mkdir(dirname(source), { recursive: true });
  const paths = {
    cli: join(repository, 'packages/cli/dist/index.js'),
    core: join(repository, 'packages/core/dist/index.js'),
    package: join(repository, 'packages/cli/package.json'),
  };
  const config = adapter.expectedConfiguration(
    agent,
    `"${process.execPath}" "${paths.cli}" hook ${agent}`,
  );
  const raw = Buffer.from(
    '\uFEFF' + JSON.stringify({ ...config, privateSetting: 'SOURCE_PRIVATE_SENTINEL' }) + '\r\n',
  );
  await writeFile(source, raw, { mode: 0o600 });
  let calls = 0,
    revision = 'a'.repeat(64),
    clock = Date.parse('2026-10-23T12:00:00.000Z');
  const options = {
    paths,
    project,
    userHome,
    home,
    statusAdapterPath: join(output, 'status.mjs'),
    loadValidator: async () => schema,
    available: async () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => revision,
    now: () => clock,
    run: async () => {
      calls++;
      return report();
    },
    ...overrides,
  };
  const service = await createHookCheckService(options);
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    project,
    userHome,
    home,
    source,
    raw,
    config,
    options,
    service,
    agent,
    scope,
    calls: () => calls,
    changeRuntime: () => {
      revision = 'b'.repeat(64);
    },
    advance: () => {
      clock += 120001;
    },
    preview: () => service.preview({ agent, scope }),
  };
}
async function terminal(service, id) {
  for (let count = 0; count < 100; count++) {
    const job = service.getJob(id);
    if (job?.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('fixture did not complete');
}

test('GET and exact configured previews do not run hooks or create history in all three project/user scopes', async (t) => {
  for (const agent of ['claude-code', 'codex', 'cursor'])
    for (const scope of ['project', 'user']) {
      const f = await fixture(t, { agent, scope });
      const state = await f.service.getState();
      assert.equal(schema.validateHookCheckState(state), true);
      const preview = await f.preview();
      assert.equal(preview.status, 200, JSON.stringify(preview));
      assert.equal(schema.validateHookCheckPreview(preview.body), true);
      assert.equal(preview.body.canStart, true);
      assert.equal(preview.body.binding.workspaceId, state.workspaceId);
      assert.equal(preview.body.binding.policySha256, null);
      assert.equal(f.calls(), 0);
      assert.deepEqual(await readFile(f.source), f.raw);
      await assert.rejects(readdir(f.home), { code: 'ENOENT' });
      assert.ok(!JSON.stringify(preview).includes('SOURCE_PRIVATE_SENTINEL'));
      assert.ok(!JSON.stringify(preview).includes(f.dir));
    }
});

test('explicit start persists an exact preview-bound derived result, survives reload and never stamps the selected home', async (t) => {
  const f = await fixture(t),
    preview = await f.preview();
  const accepted = await f.service.start({ previewId: preview.body.id });
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  assert.equal(accepted.body.previewId, preview.body.id);
  assert.equal(schema.validateHookCheckJob(accepted.body), true);
  const completed = await terminal(f.service, accepted.body.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.status, 'passed');
  assert.equal(completed.result.hostEnforcement, false);
  assert.equal(schema.validateHookCheckJob(completed), true);
  assert.equal(f.calls(), 1);
  assert.equal((await f.service.start({ previewId: preview.body.id })).status, 409);
  for (const name of ['audit.jsonl', 'last-hook', 'sessions', 'secrets.json', 'live'])
    await assert.rejects(readFile(join(f.home, name)), { code: 'ENOENT' });
  const files = await readdir(join(f.home, 'console'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^hook-checks-[a-f0-9]{64}\.json$/);
  const stored = await readFile(join(f.home, 'console', files[0]), 'utf8');
  assert.ok(!stored.includes('SOURCE_PRIVATE_SENTINEL'));
  assert.ok(!stored.includes(f.dir));
  await f.service.close();
  const reopened = await createHookCheckService(f.options);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.getState()).jobs, [completed]);
  assert.deepEqual(await readFile(f.source), f.raw);
});

test('source bytes, mode, roots, runtime and raw-only policy drift refuse a stale preview before execution', async (t) => {
  for (const kind of ['source', 'mode', 'root', 'runtime', 'policy'])
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === 'policy') {
        await mkdir(f.home, { mode: 0o700 });
        await writeFile(
          join(f.home, 'policy.yaml'),
          'version: 1\nthreshold: 0.6\ndefault: allow\nrules: []\n',
        );
      }
      const preview = await f.preview();
      assert.equal(preview.body.canStart, true, JSON.stringify(preview));
      if (kind === 'source')
        await writeFile(f.source, JSON.stringify({ ...f.config, newSetting: true }));
      if (kind === 'mode') await chmod(f.source, 0o640);
      if (kind === 'runtime') f.changeRuntime();
      if (kind === 'policy')
        await writeFile(
          join(f.home, 'policy.yaml'),
          '# Raw-only edit\nversion: 1\nthreshold: 0.6\ndefault: allow\nrules: []\n',
        );
      if (kind === 'root') {
        await rename(f.project, f.project + '-old');
        await mkdir(join(f.project, '.cursor'), { recursive: true });
        await writeFile(f.source, f.raw);
      }
      const changed = await readFile(f.source);
      assert.equal((await f.service.start({ previewId: preview.body.id })).status, 409);
      assert.equal(f.calls(), 0);
      assert.deepEqual(await readFile(f.source), changed);
      await assert.rejects(readdir(join(f.home, 'console')), { code: 'ENOENT' });
    });
});

test('late configuration drift discards a successful executor result and retains the changed source', async (t) => {
  let source;
  const f = await fixture(t, {
    run: async () => {
      await writeFile(source, '{}');
      return report();
    },
  });
  source = f.source;
  const preview = await f.preview(),
    accepted = await f.service.start({ previewId: preview.body.id });
  assert.equal(accepted.status, 202);
  const completed = await terminal(f.service, accepted.body.id);
  assert.equal(completed.status, 'failed');
  assert.equal(completed.error, 'preview-stale');
  assert.equal(completed.result, undefined);
  assert.equal(await readFile(source, 'utf8'), '{}');
});

test('closed inputs, single-use plans, expiration and one-active-job rules cannot launch extra work', async (t) => {
  const f = await fixture(t);
  for (const input of [
    null,
    {},
    { agent: 'unknown', scope: 'project' },
    { agent: 'cursor', scope: 'project', command: 'never' },
  ])
    assert.equal((await f.service.preview(input)).status, 400);
  const preview = await f.preview();
  for (const input of [
    {},
    { previewId: preview.body.id, cli: '/outside' },
    { previewId: '../escape' },
  ])
    assert.equal((await f.service.start(input)).status, 400);
  f.advance();
  assert.equal(
    (await f.service.start({ previewId: preview.body.id })).body.error,
    'preview-expired',
  );
  assert.equal(f.calls(), 0);
  for (let count = 0; count < 9; count++) await f.preview();
  const result = await f.service.start({ previewId: preview.body.id });
  assert.equal(result.status, 409);
});

test('windsurf is not offered and a preview for it is refused before any capture or hook work', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.service.getState()).agents.map((agent) => agent.id),
    ['claude-code', 'codex', 'cursor'],
  );
  const file = join(f.project, '.windsurf/hooks.json');
  const bytes = Buffer.from('{"hooks":{"pre_run_command":[{"command":"stroq hook windsurf"}]}}');
  await mkdir(dirname(file));
  await writeFile(file, bytes);
  for (const scope of ['project', 'user']) {
    const preview = await f.service.preview({ agent: 'windsurf', scope });
    assert.deepEqual(preview, { status: 400, body: { error: 'invalid-request' } });
  }
  assert.equal(f.calls(), 0);
  assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});

test('cancellation and shutdown wait for cleanup and never retain a partial passing result', async (t) => {
  for (const operation of ['cancel', 'close'])
    await t.test(operation, async (t) => {
      let cleanup = false,
        entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const f = await fixture(t, {
        run: (_input, { signal }) =>
          new Promise((_resolve, reject) => {
            entered();
            signal.addEventListener(
              'abort',
              () =>
                setTimeout(() => {
                  cleanup = true;
                  reject(new Error('cancelled'));
                }, 20),
              { once: true },
            );
          }),
      });
      const preview = await f.preview(),
        accepted = await f.service.start({ previewId: preview.body.id });
      await started;
      assert.equal((await f.preview()).status, 409);
      assert.equal((await f.service.start({ previewId: preview.body.id })).status, 409);
      if (operation === 'cancel') await f.service.cancel({ jobId: accepted.body.id });
      else await f.service.close();
      assert.equal(cleanup, true);
      const result = f.service.getJob(accepted.body.id);
      assert.equal(result.status, operation === 'cancel' ? 'cancelled' : 'failed');
      assert.equal(result.result, undefined);
      assert.equal(schema.validateHookCheckJob(result), true);
    });
});

test('broken history refuses new execution and restart converts an interrupted attempt to server-stopped', async (t) => {
  const f = await fixture(t),
    preview = await f.preview();
  const accepted = await f.service.start({ previewId: preview.body.id });
  await terminal(f.service, accepted.body.id);
  await f.service.close();
  const name = (await readdir(join(f.home, 'console')))[0],
    file = join(f.home, 'console', name);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.runs[0] = accepted.body;
  await writeFile(file, JSON.stringify(stored));
  const recovered = await createHookCheckService(f.options);
  t.after(() => recovered.close());
  assert.equal(recovered.getJob(accepted.body.id).error, 'server-stopped');
  await recovered.close();
  await writeFile(file, '{BROKEN_PRIVATE_SENTINEL');
  const broken = await createHookCheckService(f.options);
  t.after(() => broken.close());
  const state = await broken.getState();
  assert.equal(state.history.status, 'error');
  assert.equal(
    (await broken.preview({ agent: f.agent, scope: f.scope })).body.reason,
    'history-unavailable',
  );
  assert.equal(await readFile(file, 'utf8'), '{BROKEN_PRIVATE_SENTINEL');
  assert.ok(!JSON.stringify(state).includes('BROKEN_PRIVATE_SENTINEL'));
});
