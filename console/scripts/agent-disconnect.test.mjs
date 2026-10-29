import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { createAgentDisconnect } from './agent-disconnect.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(join(tmpdir(), 'stroq-disconnect-test-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    adapter: resolve(repository, 'console/scripts/agent-status-engine.ts'),
    schema: resolve(repository, 'console/scripts/local-api-schema.ts'),
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
    js: "import { createRequire as createDisconnectRequire } from 'node:module'; const require = createDisconnectRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': resolve(repository, 'packages/core/src/index.ts') };
  },
});
for (const name of ['atlas', 'scope', 'asi'])
  await copyFile(
    resolve(repository, `packages/cli/src/coverage/${name}.json`),
    join(output, `${name}.json`),
  );
const adapter = await import(pathToFileURL(join(output, 'adapter.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const workspaceId = `workspace-${'a'.repeat(24)}`;
const relative = (agent) =>
  agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;
async function fixture(t, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-disconnect-service-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const options = {
    project,
    userHome,
    home,
    workspaceId,
    adapterPath: join(output, 'adapter.mjs'),
    loadSchema: async () => schema,
    runtimeDigest: async () => 'a'.repeat(64),
    engineAvailability: async () => ({ available: true, version: '0.28.0' }),
    withConfigurationLock: async (_context, action) => action(),
    ...extra,
  };
  const service = await createAgentDisconnect(options);
  t.after(() => service.close());
  async function installed(agent = 'claude-code', scope = 'project', overrides = {}) {
    const config = {
      ...adapter.expectedConfiguration(
        agent,
        `"${process.execPath}" "${ENGINE_PATHS.cli}" hook ${agent}`,
      ),
      env: { PRIVATE_TOKEN: 'PRIVATE_SENTINEL' },
      ...overrides,
    };
    const file = join(scope === 'user' ? userHome : project, relative(agent));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
    await writeFile(file, bytes, { mode: 0o640 });
    return { file, config, bytes };
  }
  return { base, project, userHome, home, service, options, installed };
}
const consent = (preview) => ({
  previewId: preview.previewId,
  acknowledgeWeakenProtection: true,
  acknowledgeRetainedCopy: true,
  acknowledgeSharedScope: preview.scopeImpact === 'all-workspaces',
});

test('availability reads no configs and exact request boundaries refuse arbitrary targets', async (t) => {
  const f = await fixture(t);
  assert.equal(schema.validateAgentDisconnectState(f.service.getState()), true);
  assert.deepEqual(await readdir(f.project), []);
  for (const input of [
    null,
    {},
    { agent: 'mcp', scope: 'project' },
    { agent: 'cursor', scope: 'project', path: '/foreign' },
  ]) {
    assert.equal((await f.service.preview(input)).status, 400);
  }
  const noOp = await f.service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.operation, 'unchanged');
  assert.equal(schema.validateAgentDisconnectPreview(noOp.body), true);
  assert.equal(
    (await f.service.apply(consent(noOp.body))).body.error,
    'agent-disconnect-no-changes',
  );
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('windsurf is refused as an invalid request before any hook file is read or changed', async (t) => {
  const f = await fixture(t);
  const files = [
    join(f.project, '.windsurf', 'hooks.json'),
    join(f.userHome, '.codeium', 'windsurf', 'hooks.json'),
  ];
  const bytes = Buffer.from('{"hooks":{"pre_run_command":[{"command":"stroq hook windsurf"}]}}\n');
  for (const file of files) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o640 });
  }
  for (const scope of ['project', 'user']) {
    const preview = await f.service.preview({ agent: 'windsurf', scope });
    assert.deepEqual(preview, { status: 400, body: { error: 'invalid-request' } });
  }
  for (const file of files) assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('all agents/scopes remove exact hooks, preserve settings/modes and retain a private full copy', async (t) => {
  const f = await fixture(t);
  await mkdir(f.home, { mode: 0o700 });
  const record = Buffer.from('{"PRIVATE_INSTALL_RECORD":"unchanged"}');
  await writeFile(join(f.home, 'install.json'), record, { mode: 0o600 });
  for (const agent of ['claude-code', 'cursor', 'codex'])
    for (const scope of ['project', 'user']) {
      const original = await f.installed(agent, scope);
      const preview = await f.service.preview({ agent, scope });
      assert.equal(preview.status, 200, JSON.stringify(preview));
      assert.equal(schema.validateAgentDisconnectPreview(preview.body), true);
      assert.equal(JSON.stringify(preview).includes('PRIVATE_'), false);
      assert.deepEqual(await readFile(original.file), original.bytes);
      const result = await f.service.apply(consent(preview.body));
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(schema.validateAgentDisconnectReceipt(result.body), true);
      assert.equal(result.body.backupId, result.body.receiptId);
      assert.deepEqual(JSON.parse(await readFile(original.file, 'utf8')).env, original.config.env);
      assert.equal((await stat(original.file)).mode & 0o777, 0o640);
      const backup = join(
        f.home,
        'backups',
        'console-disconnect',
        result.body.backupId,
        'before.json',
      );
      assert.deepEqual(await readFile(backup), original.bytes);
      assert.equal((await stat(backup)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(join(f.home, 'install.json')), record);
      assert.equal((await f.service.apply(consent(preview.body))).status, 409);
    }
});

test('missing acknowledgements preserve the preview and user-home alias requires shared consent', async (t) => {
  const f = await fixture(t);
  const original = await f.installed('cursor', 'user');
  const alias = join(f.base, 'alias');
  await symlink(f.userHome, alias);
  const service = await createAgentDisconnect({ ...f.options, project: alias });
  t.after(() => service.close());
  const preview = await service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(preview.body.scopeImpact, 'all-workspaces');
  assert.equal(preview.body.target, '~/.cursor/hooks.json');
  const missing = consent(preview.body);
  delete missing.acknowledgeRetainedCopy;
  assert.equal((await service.apply(missing)).status, 400);
  assert.equal(
    (await service.apply({ ...consent(preview.body), acknowledgeSharedScope: false })).status,
    400,
  );
  assert.deepEqual(await readFile(original.file), original.bytes);
  assert.equal((await service.apply(consent(preview.body))).status, 200);
});

test('source bytes, mode, inode, runtime and expiry remain bound to a single-use preview', async (t) => {
  let revision = 'a'.repeat(64),
    now = Date.now();
  const f = await fixture(t, { runtimeDigest: async () => revision, now: () => now });
  for (const change of ['bytes', 'mode', 'inode', 'runtime', 'expiry']) {
    const original = await f.installed('cursor');
    const preview = await f.service.preview({ agent: 'cursor', scope: 'project' });
    if (change === 'bytes') await writeFile(original.file, '{}');
    if (change === 'mode') await chmod(original.file, 0o600);
    if (change === 'inode') {
      const other = join(f.base, 'copy');
      await writeFile(other, original.bytes, { mode: 0o640 });
      await rename(other, original.file);
    }
    if (change === 'runtime') revision = 'b'.repeat(64);
    if (change === 'expiry') now += 300_001;
    const after = await readFile(original.file);
    assert.equal((await f.service.apply(consent(preview.body))).status, 409);
    assert.deepEqual(await readFile(original.file), after);
    assert.equal((await f.service.apply(consent(preview.body))).status, 409);
  }
});

test('invalid bytes/JSON and links are refused without touching a second source', async (t) => {
  const f = await fixture(t);
  const original = await f.installed('codex');
  const cursor = await f.installed('cursor');
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from('{"x":1,"x":2}'),
    Buffer.from('{/*jsonc*/}'),
  ]) {
    await writeFile(cursor.file, bytes);
    assert.equal((await f.service.preview({ agent: 'cursor', scope: 'project' })).status, 422);
  }
  await rm(cursor.file);
  await symlink(original.file, cursor.file);
  assert.equal((await f.service.preview({ agent: 'cursor', scope: 'project' })).status, 422);
  await rm(cursor.file);
  await link(original.file, cursor.file);
  assert.equal((await f.service.preview({ agent: 'cursor', scope: 'project' })).status, 422);
  assert.deepEqual(await readFile(original.file), original.bytes);
});

test('readback conflicts preserve foreign bytes and close waits for a started commit', async (t) => {
  let file;
  const f = await fixture(t, {
    fault: async (phase) => {
      if (phase === 'after-rename') await writeFile(file, 'FOREIGN_SENTINEL');
    },
  });
  file = (await f.installed('cursor')).file;
  const preview = await f.service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(
    (await f.service.apply(consent(preview.body))).body.error,
    'agent-disconnect-write-failed',
  );
  assert.equal(await readFile(file, 'utf8'), 'FOREIGN_SENTINEL');
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const g = await fixture(t, {
    fault: async (phase) => {
      if (phase === 'after-backup') {
        entered();
        await gate;
      }
    },
  });
  await g.installed('cursor');
  const p = await g.service.preview({ agent: 'cursor', scope: 'project' });
  const applying = g.service.apply(consent(p.body));
  await started;
  let closed = false;
  const closing = g.service.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  release();
  assert.equal((await applying).status, 200);
  await closing;
});

test('an explicit empty environment never adopts an ambient Stroq home', async (t) => {
  const f = await fixture(t);
  const before = process.env.STROQ_HOME;
  process.env.STROQ_HOME = join(f.base, 'unselected');
  try {
    const service = await createAgentDisconnect({ ...f.options, home: undefined, environment: {} });
    t.after(() => service.close());
    assert.equal(service.getState().available, true);
  } finally {
    if (before === undefined) delete process.env.STROQ_HOME;
    else process.env.STROQ_HOME = before;
  }
});

test('validation never recreates a listed recovery record that disappeared', async (t) => {
  const f = await fixture(t);
  await f.installed('cursor');
  const first = await f.service.preview({ agent: 'cursor', scope: 'project' });
  const receipt = await f.service.apply(consent(first.body));
  const old = join(f.home, 'backups', 'console-disconnect', receipt.body.backupId);
  const held = join(f.base, 'held-backup');
  await f.installed('cursor');
  let raced = false;
  const service = await createAgentDisconnect({
    ...f.options,
    fault: async (phase) => {
      if (phase === 'before-backup-record-inspect' && !raced) {
        raced = true;
        await rename(old, held);
      }
    },
  });
  t.after(() => service.close());
  const preview = await service.preview({ agent: 'cursor', scope: 'project' });
  assert.equal((await service.apply(consent(preview.body))).status, 422);
  assert.equal(raced, true);
  await assert.rejects(stat(old), { code: 'ENOENT' });
  assert.ok((await readFile(join(held, 'before.json'))).length > 0);
});

test('recovery capacity refuses another full copy without evicting an existing record', async (t) => {
  const f = await fixture(t);
  const original = await f.installed('cursor');
  const vault = join(f.home, 'backups', 'console-disconnect');
  await mkdir(vault, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 32; i++)
    await mkdir(join(vault, `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`), {
      mode: 0o700,
    });
  const preview = await f.service.preview({ agent: 'cursor', scope: 'project' });
  const result = await f.service.apply(consent(preview.body));
  assert.equal(result.body.error, 'agent-disconnect-backup-full');
  assert.equal((await readdir(vault)).length, 32);
  assert.deepEqual(await readFile(original.file), original.bytes);
});

test('private preview storage is bounded by count and captured byte size', async (t) => {
  const f = await fixture(t);
  await f.installed('cursor');
  const previews = [];
  for (let i = 0; i < 9; i++)
    previews.push((await f.service.preview({ agent: 'cursor', scope: 'project' })).body);
  assert.equal(
    (await f.service.apply(consent(previews[0]))).body.error,
    'agent-disconnect-preview-missing',
  );
  const g = await fixture(t);
  await g.installed('cursor', 'project', { privateData: 'x'.repeat(900_000) });
  const large = [];
  for (let i = 0; i < 5; i++)
    large.push((await g.service.preview({ agent: 'cursor', scope: 'project' })).body);
  assert.equal(
    (await g.service.apply(consent(large[0]))).body.error,
    'agent-disconnect-preview-missing',
  );
  assert.equal((await g.service.apply(consent(large.at(-1)))).status, 200);
});
