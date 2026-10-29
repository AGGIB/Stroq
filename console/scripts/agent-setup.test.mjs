import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSetup } from './agent-setup.mjs';
import { ENGINE_PATHS } from './control-engine.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const consent = (preview) => ({
  previewId: preview.id,
  confirm: true,
  ...Object.fromEntries(
    Object.entries(preview.needs)
      .filter(([, needed]) => needed)
      .map(([key]) => [key, true]),
  ),
});

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'stroq-agent-setup-'));
  const project = join(dir, 'workspace');
  const userHome = join(dir, 'user');
  await mkdir(project);
  await mkdir(userHome);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const setup = await createAgentSetup({ project, userHome, environment: {}, ...extra });
  t.after(() => setup.close());
  return { dir, project, userHome, setup, home: join(userHome, '.stroq') };
}

test('only fixed agent/scope inputs are accepted; custom homes cannot install elsewhere', async (t) => {
  const { setup } = await fixture(t);
  assert.equal(setup.getState().schema, 'stroq-agent-setup/2');
  for (const input of [
    null,
    {},
    { agent: 'mcp', scope: 'project' },
    { agent: 'cursor', scope: '../../' },
    { agent: 'cursor', scope: 'user', path: '/tmp/pwn' },
  ]) {
    assert.equal((await setup.preview(input)).status, 400);
  }
  assert.equal((await setup.apply({ previewId: 'bad', confirm: true })).status, 400);
  const custom = await fixture(t, { home: '/unused-custom-stroq' });
  assert.equal(custom.setup.getState().available, false);
  assert.equal(custom.setup.getState().reason, 'custom-home-unsupported');
});

test('windsurf is not offered and a request for it is refused before any file is read', async (t) => {
  const { setup, project, userHome, home } = await fixture(t);
  assert.deepEqual(
    setup.getState().agents.map((agent) => agent.id),
    ['claude-code', 'cursor', 'codex'],
  );
  const file = join(project, '.windsurf', 'hooks.json');
  const original = '{"hooks":{"pre_run_command":[{"command":"other"}]}}';
  await mkdir(join(project, '.windsurf'));
  await writeFile(file, original);
  for (const scope of ['project', 'user']) {
    const preview = await setup.preview({ agent: 'windsurf', scope });
    assert.deepEqual(preview, { status: 400, body: { error: 'invalid-request' } });
  }
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(userHome), []);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('setup waits on the same real manifest lock as file filters and removes no foreign settings', async (t) => {
  const { setup, project, home } = await fixture(t);
  const file = join(project, '.claude', 'settings.json');
  const original = '{"foreign":"preserved"}\n';
  await mkdir(join(project, '.claude'));
  await writeFile(file, original);
  const preview = await setup.preview({ agent: 'claude-code', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  const engine = await import(
    pathToFileURL(runtimeLayout().adapter('credential-filter-engine.js')).href
  );
  let release, enter;
  const entered = new Promise((done) => {
    enter = done;
  });
  const held = engine.withManifestLock(
    { home, version: '0.28.0', now: () => new Date() },
    async () => {
      enter();
      await new Promise((done) => {
        release = done;
      });
    },
  );
  await entered;
  try {
    const result = await setup.apply(consent(preview.body));
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(result.body.error, 'agent-configuration-busy');
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(stat(join(home, 'install.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(home, 'backups', 'console-setup')), { code: 'ENOENT' });
  } finally {
    release();
    await held;
  }
  const fresh = await setup.preview({ agent: 'claude-code', scope: 'project' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh));
  assert.equal((await setup.apply(consent(fresh.body))).status, 200);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).foreign, 'preserved');
});

test('preview is read-only and private; apply preserves hooks, backs up exact bytes, and records configuration only', async (t) => {
  const { setup, project, home } = await fixture(t);
  const path = join(project, '.claude', 'settings.json');
  const original = JSON.stringify({
    env: { PRIVATE_TOKEN: 'never-to-browser' },
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: 'other-private-command' }] },
      ],
    },
  });
  await mkdir(join(project, '.claude'));
  await writeFile(path, original);
  const preview = await setup.preview({ agent: 'claude-code', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.body.preservedHooks, 1);
  assert.equal(preview.body.hookEvents.length, 3);
  assert.equal(preview.body.backup.required, true);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(!JSON.stringify(preview).includes('never-to-browser'));
  assert.ok(!JSON.stringify(preview).includes('other-private-command'));
  assert.ok(!JSON.stringify(preview).includes(project));
  assert.equal((await setup.apply({ previewId: preview.body.id, confirm: false })).status, 400);
  const applied = await setup.apply(consent(preview.body));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(applied.body.status, 'configured');
  assert.equal(applied.body.evidence, 'configuration');
  assert.equal(applied.body.verified, false);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.hooks.PreToolUse[0].hooks[0].command, 'other-private-command');
  assert.equal(config.env.PRIVATE_TOKEN, 'never-to-browser');
  assert.equal(
    await readFile(
      join(home, 'backups', 'console-setup', `${applied.body.backupId}.config.json`),
      'utf8',
    ),
    original,
  );
  assert.equal((await stat(join(home, 'install.json'))).mode & 0o777, 0o600);
  assert.equal((await setup.apply(consent(preview.body))).status, 409);
});

test('all three agents use the current exact templates in both scopes with honest next steps', async (t) => {
  const { setup, userHome } = await fixture(t);
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    for (const scope of ['project', 'user']) {
      const preview = await setup.preview({ agent, scope });
      assert.equal(preview.status, 200, JSON.stringify(preview));
      const applied = await setup.apply(consent(preview.body));
      assert.equal(applied.status, 200, JSON.stringify(applied));
      assert.equal(applied.body.needsApproval, agent === 'codex');
      assert.equal(applied.body.verified, false);
    }
  }
  const cursor = JSON.parse(await readFile(join(userHome, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(cursor.hooks.preToolUse[0].failClosed, true);
  assert.equal(cursor.hooks.preToolUse[0].matcher, '^(Write|Delete)$');
});

test('changed config and expired previews are refused before writing', async (t) => {
  let now = Date.now();
  const { setup, project } = await fixture(t, { now: () => now });
  const first = await setup.preview({ agent: 'cursor', scope: 'project' });
  await mkdir(join(project, '.cursor'));
  await writeFile(join(project, '.cursor', 'hooks.json'), '{"changed":true}');
  assert.equal((await setup.apply(consent(first.body))).body.error, 'preview-stale');
  const second = await setup.preview({ agent: 'cursor', scope: 'project' });
  now += 300_001;
  assert.equal((await setup.apply(consent(second.body))).body.error, 'preview-expired');
  assert.equal(await readFile(join(project, '.cursor', 'hooks.json'), 'utf8'), '{"changed":true}');
});

test('symlinks, hardlinks, invalid UTF-8 and malformed hook shapes fail closed', async (t) => {
  const { setup, project, dir } = await fixture(t);
  const folder = join(project, '.cursor');
  const target = join(folder, 'hooks.json');
  await mkdir(folder);
  const external = join(dir, 'elsewhere.json');
  await writeFile(external, '{}');
  await symlink(external, target);
  assert.equal(
    (await setup.preview({ agent: 'cursor', scope: 'project' })).body.error,
    'unsafe-config',
  );
  await rm(target);
  await link(external, target);
  assert.equal(
    (await setup.preview({ agent: 'cursor', scope: 'project' })).body.error,
    'unsafe-config',
  );
  await rm(target);
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from('{"hooks":{"preToolUse":[null]}}'),
    Buffer.from('{"hooks":[]}'),
  ]) {
    await writeFile(target, bytes);
    assert.equal(
      (await setup.preview({ agent: 'cursor', scope: 'project' })).body.error,
      'invalid-config',
    );
  }
  assert.equal(await readFile(external, 'utf8'), '{}');
});

test('disabled Claude hooks cannot become configured protection', async (t) => {
  const { setup, project } = await fixture(t);
  await mkdir(join(project, '.claude'));
  await writeFile(join(project, '.claude', 'settings.json'), '{"disableAllHooks":true}');
  assert.equal(
    (await setup.preview({ agent: 'claude-code', scope: 'project' })).body.error,
    'hooks-disabled',
  );
});

test('changed advisory record and symlinked backup directories cannot write a config', async (t) => {
  const { setup, project, home, dir } = await fixture(t);
  const first = await setup.preview({ agent: 'codex', scope: 'project' });
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'install.json'), '{"version":1,"entries":{}}');
  assert.equal((await setup.apply(consent(first.body))).body.error, 'preview-stale');
  const second = await setup.preview({ agent: 'codex', scope: 'project' });
  await symlink(dir, join(home, 'backups'));
  assert.equal((await setup.apply(consent(second.body))).body.error, 'unsafe-config');
  assert.deepEqual(await readdir(project), []);
});

test('a changed CLI chunk invalidates approval even when the entry path and version are unchanged', async (t) => {
  const fixtureState = await fixture(t);
  fixtureState.setup.close();
  const dist = join(fixtureState.dir, 'dist');
  await mkdir(dist);
  const cli = join(dist, 'index.js');
  await writeFile(cli, `await import(${JSON.stringify(pathToFileURL(ENGINE_PATHS.cli).href)});`);
  await writeFile(join(dist, 'chunk.js'), 'export const version = 1;');
  const setup = await createAgentSetup({
    ...fixtureState,
    paths: { ...ENGINE_PATHS, cli },
    environment: {},
  });
  t.after(() => setup.close());
  const preview = await setup.preview({ agent: 'cursor', scope: 'project' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  await writeFile(join(dist, 'chunk.js'), 'export const version = 2;');
  const result = await setup.apply(consent(preview.body));
  assert.equal(result.body.error, 'preview-stale');
  assert.deepEqual(await readdir(fixtureState.project), []);
});

test('Codex legacy root groups stay in place; reinstall retains foreign hooks without writes or duplicate exact hooks', async (t) => {
  const { setup, project, home } = await fixture(t);
  await mkdir(join(project, '.codex'));
  const target = join(project, '.codex', 'hooks.json');
  const foreign = {
    matcher: 'Read',
    hooks: [{ type: 'command', command: 'private-hook-command' }],
  };
  await writeFile(
    target,
    JSON.stringify({
      PreToolUse: [foreign],
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'second-command' }] }],
      },
    }),
  );
  const first = await setup.preview({ agent: 'codex', scope: 'project' });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.body.preservedHooks, 2);
  assert.equal(first.body.addedHooks, 2);
  assert.equal((await setup.apply(consent(first.body))).status, 200);
  const configuredBytes = await readFile(target);
  const recovery = join(home, 'backups', 'console-setup');
  const copies = await readdir(recovery);
  const recorded = await readFile(join(home, 'install.json'));
  const second = await setup.preview({ agent: 'codex', scope: 'project' });
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.body.operation, 'unchanged');
  assert.equal(second.body.replacedHooks, 0);
  assert.equal(second.body.addedHooks, 0);
  const unchanged = await setup.apply(consent(second.body));
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.status, 'unchanged');
  assert.equal(unchanged.body.backupId, null);
  assert.deepEqual(await readFile(target), configuredBytes);
  assert.deepEqual(await readdir(recovery), copies);
  assert.deepEqual(await readFile(join(home, 'install.json')), recorded);
  const result = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(result.PreToolUse, [foreign]);
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'second-command');
  assert.equal(result.hooks.PreToolUse.length, 2);
});

test('shutdown settles in-flight work and refuses new previews and applies', async (t) => {
  const { setup, project } = await fixture(t);
  const pending = setup.preview({ agent: 'cursor', scope: 'project' });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await setup.close();
  assert.equal(settled, true);
  assert.equal((await pending).body.error, 'server-stopped');
  assert.equal((await setup.preview({ agent: 'cursor', scope: 'project' })).status, 503);
  assert.equal(setup.getState().available, false);
  assert.deepEqual(await readdir(project), []);
});
