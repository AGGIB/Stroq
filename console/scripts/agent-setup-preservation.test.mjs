import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAgentSetup } from './agent-setup.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { startServer } from './serve.mjs';

const adapter = await import('../.local-engine/agent-status-engine.js');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const command = (agent) => `"${process.execPath}" "${ENGINE_PATHS.cli}" hook ${agent}`;
const target = (agent) =>
  agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;
const consent = (body) => ({
  previewId: body.id,
  confirm: true,
  ...Object.fromEntries(
    Object.entries(body.needs)
      .filter(([, needed]) => needed)
      .map(([key]) => [key, true]),
  ),
});
const parsed = (bytes) => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const native = {
  permissions: { allow: ['Read(src/**)'], deny: ['Read(.env)', 'Read(.env.*)'] },
  env: { PRIVATE_VALUE: 'PRIVATE_NATIVE_SENTINEL' },
  future: { nested: ['keep', 42, false] },
};

function mixedConfiguration(agent) {
  const template = adapter.expectedConfiguration(agent, command(agent));
  const event = Object.keys(template.hooks)[0];
  const grouped = agent !== 'cursor';
  const first = structuredClone(template.hooks[event]);
  const handler = grouped ? first[0].hooks[0] : first[0];
  const ordinary = { ...handler, command: 'echo ORDINARY_PRIVATE_SENTINEL', timeout: 7 };
  const suffix = { ...handler, command: `echo hook ${agent}`, timeout: 11 };
  const altered = { ...handler, timeout: (handler.timeout ?? 15) + 1 };
  if (grouped) {
    first[0].hooks.push(ordinary, suffix, altered);
    first.push({
      ...structuredClone(first[0]),
      matcher: 'ForeignTool',
      hooks: [structuredClone(handler)],
    });
  } else first.push(ordinary, suffix, altered);
  const config = {
    ...native,
    ...template,
    hooks: {
      [event]: first,
      ForeignEvent: grouped ? [{ matcher: 'ForeignTool', hooks: [ordinary] }] : [ordinary],
    },
  };
  return { template, event, config, foreign: grouped ? 5 : 4, lookalikes: grouped ? 3 : 2 };
}

async function fixture(t, { agent = 'cursor', scope = 'project', config, runtime } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-setup-preserve-http-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'profile'),
    root = join(dir, 'out');
  await Promise.all([mkdir(project), mkdir(userHome), mkdir(root)]);
  const home = join(userHome, '.stroq'),
    file = join(scope === 'user' ? userHome : project, target(agent));
  await mkdir(dirname(file), { recursive: true });
  const before = Buffer.isBuffer(config)
    ? config
    : Buffer.from(
        '\uFEFF' + JSON.stringify(config ?? native, null, '\t').replaceAll('\n', '\r\n') + '\r\n',
      );
  await writeFile(file, before, { mode: 0o640 });
  await writeFile(join(root, 'index.html'), 'fixture');
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  const setup = runtime
    ? await createAgentSetup({ project, userHome, home, workspaceId, runtimeDigest: runtime })
    : undefined;
  const app = await startServer({ project, userHome, home, root, setup, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  async function request(path, body) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function preview() {
    const result = await request('/api/agent-setup/preview', { agent, scope });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const schema = await import('../.local-engine/local-api-schema.js');
    assert.equal(schema.validateSetupPreview(result.body), true);
    assert.equal(result.body.schema, 'stroq-agent-setup-preview/2');
    assert.equal(result.body.workspaceId, workspaceId);
    for (const secret of [dir, 'PRIVATE_NATIVE_SENTINEL', 'ORDINARY_PRIVATE_SENTINEL'])
      assert.ok(!JSON.stringify(result.body).includes(secret));
    return result.body;
  }
  async function apply(preview) {
    const result = await request('/api/agent-setup/apply', consent(preview));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const schema = await import('../.local-engine/local-api-schema.js');
    assert.equal(schema.validateSetupResult(result.body), true);
    assert.equal(result.body.schema, 'stroq-agent-setup-result/2');
    assert.equal(result.body.previewId, preview.id);
    assert.equal(result.body.candidateSha256, hash(await readFile(file)));
    for (const secret of [dir, 'PRIVATE_NATIVE_SENTINEL', 'ORDINARY_PRIVATE_SENTINEL'])
      assert.ok(!JSON.stringify(result.body).includes(secret));
    return result.body;
  }
  return { dir, project, userHome, home, file, before, agent, scope, request, preview, apply };
}

test('Connect preserves a foreign suffix command through the actual setup service', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-setup-preserve-')));
  const project = join(dir, 'workspace');
  const userHome = join(dir, 'profile');
  await Promise.all([mkdir(project), mkdir(userHome)]);
  const file = join(project, '.cursor/hooks.json');
  await mkdir(dirname(file));
  const foreign = { command: 'echo hook cursor', timeout: 7 };
  await writeFile(file, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [foreign] } }));
  // Keep the original CLI merge regression independent of concurrently edited platform sources.
  const { cli, core, package: packagePath } = ENGINE_PATHS;
  const setup = await createAgentSetup({
    project,
    userHome,
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    environment: {},
    paths: { cli, core, package: packagePath },
  });
  t.after(async () => {
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  });
  const preview = await setup.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  const applied = await setup.apply(consent(preview.body));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    after.hooks.beforeShellExecution.find((row) => row.command === foreign.command),
    foreign,
  );
  assert.equal(applied.body.status, 'review-required');
});

for (const agent of ['claude-code', 'cursor', 'codex'])
  for (const scope of ['project', 'user']) {
    test(`Connect ${agent} ${scope} adds only missing exact hooks and preserves foreign native settings`, async (t) => {
      const source = mixedConfiguration(agent);
      const f = await fixture(t, { agent, scope, config: source.config });
      const preview = await f.preview();
      const total = Object.keys(source.template.hooks).length;
      assert.equal(preview.addedHooks, total - 1);
      assert.equal(preview.replacedHooks, 0);
      assert.equal(preview.preservedHooks, source.foreign);
      assert.equal(preview.remainingLookalikes, source.lookalikes);
      assert.equal(preview.scopeImpact, scope === 'user' ? 'all-workspaces' : 'workspace');
      assert.equal(preview.needs.acknowledgeSharedScope, scope === 'user');
      assert.equal(preview.needs.acknowledgeRetainedCopy, true);
      assert.deepEqual(await readFile(f.file), f.before);
      await assert.rejects(access(f.home), { code: 'ENOENT' });
      for (const key of Object.keys(preview.needs).filter((key) => preview.needs[key])) {
        const missing = consent(preview);
        delete missing[key];
        assert.equal((await f.request('/api/agent-setup/apply', missing)).status, 400);
        assert.deepEqual(await readFile(f.file), f.before);
      }
      const result = await f.apply(preview);
      assert.equal(result.status, 'review-required');
      assert.equal(result.remainingLookalikes, source.lookalikes);
      assert.equal(result.currentExactHooks, total);
      assert.equal(result.backupId, preview.id);
      assert.deepEqual(
        await readFile(join(f.home, 'backups/console-setup', `${result.backupId}.config.json`)),
        f.before,
      );
      const after = parsed(await readFile(f.file));
      for (const [key, value] of Object.entries(native)) assert.deepEqual(after[key], value);
      assert.deepEqual(after.hooks[source.event], source.config.hooks[source.event]);
      assert.deepEqual(after.hooks.ForeignEvent, source.config.hooks.ForeignEvent);
      for (const [event, groups] of Object.entries(source.template.hooks))
        if (event !== source.event) assert.deepEqual(after.hooks[event], groups);
      assert.equal((await stat(f.file)).mode & 0o777, 0o640);
      const row = (await f.request('/api/agents')).body.agents.find((row) => row.id === agent);
      assert.equal(row.scopes.find((row) => row.scope === scope).state, 'changed');
      assert.notEqual(row.proof.state, 'verified');
      if (agent === 'cursor' && scope === 'project') {
        const currentBytes = await readFile(f.file);
        const recordBytes = await readFile(join(f.home, 'install.json'));
        const recovery = join(f.home, 'backups/console-setup');
        const copies = await readdir(recovery);
        const unchanged = await f.preview();
        assert.equal(unchanged.operation, 'unchanged');
        const reviewed = await f.apply(unchanged);
        assert.equal(reviewed.status, 'review-required');
        assert.equal(reviewed.backupId, null);
        assert.equal(reviewed.backup.complete, false);
        assert.deepEqual(await readFile(f.file), currentBytes);
        assert.deepEqual(await readFile(join(f.home, 'install.json')), recordBytes);
        assert.deepEqual(await readdir(recovery), copies);
        const disconnect = await f.request('/api/agent-disconnect/preview', { agent, scope });
        assert.equal(disconnect.status, 200, JSON.stringify(disconnect.body));
        const removed = await f.request('/api/agent-disconnect/apply', {
          previewId: disconnect.body.previewId,
          acknowledgeWeakenProtection: true,
          acknowledgeRetainedCopy: true,
        });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        assert.equal(removed.body.remainingLookalikes, source.lookalikes);
        const reenabled = await f.apply(await f.preview());
        assert.equal(reenabled.status, 'review-required');
        const restored = parsed(await readFile(f.file));
        for (const handler of source.config.hooks[source.event].slice(1))
          assert.ok(
            restored.hooks[source.event].some(
              (row) => JSON.stringify(row) === JSON.stringify(handler),
            ),
          );
      }
    });
  }

test('actual setup HTTP refuses windsurf as an invalid request without reading or writing', async (t) => {
  const raw = Buffer.from('{"hooks":{"pre_run_command":[{"command":"echo hook windsurf"}]}}\n');
  const f = await fixture(t, { agent: 'windsurf', config: raw });
  for (const scope of ['project', 'user']) {
    const response = await f.request('/api/agent-setup/preview', { agent: 'windsurf', scope });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepEqual(response.body, { error: 'invalid-request' });
  }
  assert.deepEqual(await readFile(f.file), raw);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

for (const agent of ['claude-code', 'cursor', 'codex']) {
  test(`exact ${agent} no-op preserves raw bytes and creates no backup, lock or install record`, async (t) => {
    const config = adapter.expectedConfiguration(agent, command(agent));
    const raw = Buffer.from('\uFEFF' + JSON.stringify(config) + '\r\n');
    const f = await fixture(t, { agent, config: raw });
    const preview = await f.preview();
    assert.equal(preview.operation, 'unchanged');
    assert.equal(preview.addedHooks, 0);
    assert.equal(preview.sourceSha256, hash(raw));
    assert.equal(preview.candidateSha256, hash(raw));
    const result = await f.apply(preview);
    assert.equal(result.status, 'unchanged');
    assert.equal(result.backupId, null);
    assert.equal(result.backup.complete, false);
    assert.equal(result.backup.label, null);
    assert.deepEqual(await readFile(f.file), raw);
    await assert.rejects(access(f.home), { code: 'ENOENT' });
  });
}

for (const shape of ['array', 'object']) {
  test(`Codex legacy root ${shape} entries remain at root and count as current exact configuration`, async (t) => {
    const template = adapter.expectedConfiguration('codex', command('codex'));
    const config = { ...native };
    for (const [event, groups] of Object.entries(template.hooks))
      config[event] = shape === 'array' ? groups : groups[0];
    const f = await fixture(t, { agent: 'codex', config });
    const preview = await f.preview();
    assert.equal(preview.operation, 'unchanged');
    assert.equal(preview.addedHooks, 0);
    assert.equal(preview.remainingLookalikes, 0);
    const result = await f.apply(preview);
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(await readFile(f.file), f.before);
    const status = await f.request('/api/agents');
    const row = status.body.agents.find((row) => row.id === 'codex');
    assert.equal(row.scopes[0].state, 'present');
    assert.equal(row.scopes[0].reason, 'matches-current-install');
    await assert.rejects(access(f.home), { code: 'ENOENT' });
  });
}

test('only an extra exact duplicate is deduplicated while altered hooks remain reviewable', async (t) => {
  const source = mixedConfiguration('cursor');
  source.config.hooks[source.event].push(structuredClone(source.template.hooks[source.event][0]));
  const f = await fixture(t, { config: source.config });
  const preview = await f.preview();
  assert.equal(preview.replacedHooks, 1);
  assert.equal(preview.preservedHooks, source.foreign);
  const result = await f.apply(preview);
  assert.equal(result.status, 'review-required');
  const after = parsed(await readFile(f.file));
  const exact = source.template.hooks[source.event][0];
  assert.equal(
    after.hooks[source.event].filter((row) => JSON.stringify(row) === JSON.stringify(exact)).length,
    1,
  );
  assert.deepEqual(after.hooks[source.event], source.config.hooks[source.event].slice(0, -1));
});

test('actual setup HTTP refuses duplicate keys, lossy numbers, invalid UTF-8 and repeated BOM without writes', async (t) => {
  const f = await fixture(t);
  for (const bytes of [
    Buffer.from('{"private":"PRIVATE_PARSE_SENTINEL","owner":1,"owner":2}'),
    Buffer.from('{"private":"PRIVATE_PARSE_SENTINEL","unsafe":9007199254740993}'),
    Buffer.from([0xff]),
    Buffer.from('\uFEFF\uFEFF{"private":"PRIVATE_PARSE_SENTINEL"}'),
  ]) {
    await writeFile(f.file, bytes);
    const response = await f.request('/api/agent-setup/preview', {
      agent: f.agent,
      scope: f.scope,
    });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.error, 'invalid-config');
    assert.ok(!JSON.stringify(response.body).includes('PRIVATE_PARSE_SENTINEL'));
    assert.deepEqual(await readFile(f.file), bytes);
    await assert.rejects(access(f.home), { code: 'ENOENT' });
  }
});

test('approved source, mode, root and runtime drift refuse setup with no configuration or recovery write', async (t) => {
  for (const mutation of ['source', 'mode', 'root', 'runtime'])
    await t.test(mutation, async (t) => {
      let revision = 'a'.repeat(64);
      const f = await fixture(t, { runtime: async () => revision });
      const preview = await f.preview();
      let expected = f.before;
      if (mutation === 'source') {
        expected = Buffer.from('{"private":"PRIVATE_LATE_SENTINEL"}');
        await writeFile(f.file, expected);
      }
      if (mutation === 'mode') await chmod(f.file, 0o600);
      if (mutation === 'runtime') revision = 'b'.repeat(64);
      if (mutation === 'root') {
        await rename(f.project, `${f.project}-old`);
        await mkdir(dirname(f.file), { recursive: true });
        await writeFile(f.file, expected, { mode: 0o640 });
      }
      const result = await f.request('/api/agent-setup/apply', consent(preview));
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.deepEqual(await readFile(f.file), expected);
      if (mutation === 'mode') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
      await assert.rejects(access(join(f.home, 'backups/console-setup')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.home, 'install.json')), { code: 'ENOENT' });
      assert.ok(!JSON.stringify(result.body).includes(f.dir));
    });
});
