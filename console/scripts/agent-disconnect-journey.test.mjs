import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ENGINE_PATHS } from './control-engine.mjs';
import { startServer } from './serve.mjs';

const adapter = await import('../.local-engine/agent-status-engine.js');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const command = (agent) => `"${process.execPath}" "${ENGINE_PATHS.cli}" hook ${agent}`;
const target = (agent) =>
  agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;

function configured(agent) {
  const value = adapter.expectedConfiguration(agent, command(agent));
  const first = Object.keys(value.hooks)[0];
  const foreign = { command: 'echo USER_HOOK_SENTINEL', timeout: 7 };
  if (agent === 'cursor') value.hooks[first].push(foreign);
  else value.hooks[first][0].hooks.push(foreign);
  value.hooks.ForeignEvent = agent === 'cursor' ? [foreign] : [{ hooks: [foreign] }];
  value.privateSetting = 'PRIVATE_CONFIG_SENTINEL';
  return value;
}

async function fixture(
  t,
  { agent = 'claude-code', scope = 'project', aliasHome = false, runtime } = {},
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-disconnect-http-')));
  const userHome = join(dir, 'user');
  const project = aliasHome ? join(dir, 'home-alias') : join(dir, 'workspace');
  const root = join(dir, 'out');
  const home = join(userHome, '.stroq');
  await Promise.all([mkdir(userHome), mkdir(root)]);
  if (aliasHome) await symlink(userHome, project);
  else await mkdir(project);
  await writeFile(join(root, 'index.html'), 'inert fixture');
  const file = join(scope === 'user' ? userHome : project, target(agent));
  await mkdir(dirname(file), { recursive: true });
  const config = configured(agent);
  const before = Buffer.from(
    `\uFEFF${JSON.stringify(config, null, 2).replaceAll('\n', '\r\n')}\r\n`,
  );
  await writeFile(file, before, { mode: 0o640 });
  const canonicalProject = await realpath(project);
  const workspaceId = `workspace-${digest(canonicalProject).slice(0, 24)}`;
  const disconnect = runtime
    ? await (
        await import('./agent-disconnect.mjs')
      ).createAgentDisconnect({
        project: canonicalProject,
        userHome,
        home,
        workspaceId,
        runtimeDigest: runtime,
      })
    : undefined;
  const app = await startServer({ project, userHome, home, root, disconnect, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  async function request(path, body, extra = {}) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  function privateProjection(body) {
    const text = JSON.stringify(body);
    for (const privateValue of [
      dir,
      command(agent),
      'PRIVATE_CONFIG_SENTINEL',
      'USER_HOOK_SENTINEL',
    ])
      assert.ok(!text.includes(privateValue), 'Public evidence must not include private config');
  }
  return {
    dir,
    project,
    userHome,
    root,
    home,
    file,
    agent,
    scope,
    config,
    before,
    request,
    privateProjection,
    workspaceId,
  };
}

const consent = (preview) => ({
  previewId: preview.previewId,
  acknowledgeWeakenProtection: true,
  acknowledgeRetainedCopy: true,
  ...(preview.needs.acknowledgeSharedScope ? { acknowledgeSharedScope: true } : {}),
});

async function preview(f, selection = { agent: f.agent, scope: f.scope }) {
  const result = await f.request('/api/agent-disconnect/preview', selection);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const schemas = await import('../.local-engine/local-api-schema.js');
  assert.equal(schemas.validateAgentDisconnectPreview(result.body), true);
  f.privateProjection(result.body);
  return result.body;
}

async function agentRow(f) {
  const response = await f.request('/api/agents');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.agents.find((row) => row.id === f.agent);
}

async function historicalProof(f) {
  const version = JSON.parse(await readFile(ENGINE_PATHS.package, 'utf8')).version;
  const proof = {
    version: 1,
    agent: f.agent,
    hostVersion: '2.1.271',
    stroqVersion: version,
    policySha256: adapter.policyFingerprint(null),
    at: new Date(Date.now() - 60_000).toISOString(),
    mode: 'live',
    state: 'verified',
    caveats: [],
    probes: [
      {
        id: 'allow',
        kind: 'allow',
        mark: 'passed',
        reason: 'ran',
        evidence: { E1: true, E2: true, E3: true, E4: null },
      },
      {
        id: 'deny',
        kind: 'deny',
        mark: 'passed',
        reason: 'blocked',
        evidence: { E1: true, E2: true, E3: true, E4: true },
      },
      {
        id: 'deny:control',
        kind: 'deny',
        mark: 'passed',
        reason: 'armed',
        evidence: { E1: true, E2: null, E3: true, E4: null },
      },
    ],
  };
  await mkdir(join(f.home, 'live'), { recursive: true, mode: 0o700 });
  const file = join(f.home, 'live', `${f.agent}.json`);
  const bytes = Buffer.from(JSON.stringify(proof));
  await writeFile(file, bytes);
  return { file, bytes };
}

test('disconnect GET is read-only and does not create backup storage', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/agent-disconnect');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const schemas = await import('../.local-engine/local-api-schema.js');
  assert.equal(schemas.validateAgentDisconnectState(response.body), true);
  assert.equal(response.body.workspaceId, f.workspaceId);
  f.privateProjection(response.body);
  assert.deepEqual(await readFile(f.file), f.before);
  assert.equal((await stat(f.file)).mode & 0o777, 0o640);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

for (const agent of ['claude-code', 'cursor'])
  for (const scope of ['project', 'user']) {
    test(`${agent} ${scope}: preview, consent, exact backup, removal and fresh re-enable`, async (t) => {
      const f = await fixture(t, { agent, scope });
      const storedProof = agent === 'claude-code' ? await historicalProof(f) : null;
      const other = join(scope === 'project' ? f.userHome : f.project, target(agent));
      await mkdir(dirname(other), { recursive: true });
      const otherBytes = Buffer.from('{"untouched":"OTHER_SCOPE_SENTINEL"}');
      await writeFile(other, otherBytes);
      const before = await preview(f);
      assert.equal(before.operation, 'remove-hooks');
      assert.equal(before.scopeImpact, scope === 'user' ? 'all-workspaces' : 'workspace');
      assert.equal(before.sourceSha256, digest(f.before));
      assert.equal(before.removedHooks, agent === 'claude-code' ? 3 : 7);
      assert.equal(before.preservedHooks, 2);
      assert.equal(before.remainingLookalikes, 0);
      assert.equal(before.hostEnforcement, false);
      assert.deepEqual(await readFile(f.file), f.before);
      await assert.rejects(access(join(f.home, 'backups')), { code: 'ENOENT' });
      for (const key of [
        'acknowledgeWeakenProtection',
        'acknowledgeRetainedCopy',
        ...(scope === 'user' ? ['acknowledgeSharedScope'] : []),
      ]) {
        const body = consent(before);
        delete body[key];
        const refused = await f.request('/api/agent-disconnect/apply', body);
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.deepEqual(await readFile(f.file), f.before);
        await assert.rejects(access(join(f.home, 'backups')), { code: 'ENOENT' });
      }
      const applied = await f.request('/api/agent-disconnect/apply', consent(before));
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      const schemas = await import('../.local-engine/local-api-schema.js');
      assert.equal(schemas.validateAgentDisconnectReceipt(applied.body), true);
      assert.equal(applied.body.backupId, applied.body.receiptId);
      assert.equal(applied.body.previewId, before.previewId);
      assert.equal(applied.body.candidateSha256, before.candidateSha256);
      assert.equal(applied.body.currentExactHooks, 0);
      assert.equal(applied.body.requiresNewSession, true);
      f.privateProjection(applied.body);
      const afterBytes = await readFile(f.file);
      assert.equal(digest(afterBytes), before.candidateSha256);
      assert.equal(afterBytes.subarray(0, 3).toString('hex'), 'efbbbf');
      assert.ok(afterBytes.toString().includes('\r\n'));
      const after = JSON.parse(afterBytes.toString().trim());
      assert.equal(after.privateSetting, f.config.privateSetting);
      assert.deepEqual(after.hooks.ForeignEvent, f.config.hooks.ForeignEvent);
      const first = after.hooks[Object.keys(f.config.hooks)[0]][0];
      assert.deepEqual(agent === 'cursor' ? first : first.hooks[0], {
        command: 'echo USER_HOOK_SENTINEL',
        timeout: 7,
      });
      assert.ok(JSON.stringify(after).includes('USER_HOOK_SENTINEL'));
      assert.ok(!JSON.stringify(after).includes(ENGINE_PATHS.cli));
      assert.equal((await stat(f.file)).mode & 0o777, 0o640);
      assert.deepEqual(await readFile(other), otherBytes);
      const backup = join(
        f.home,
        'backups/console-disconnect',
        applied.body.backupId,
        'before.json',
      );
      assert.deepEqual(await readFile(backup), f.before);
      assert.equal((await stat(backup)).mode & 0o777, 0o600);
      await assert.rejects(access(join(f.home, 'install.json')), { code: 'ENOENT' });
      const removedRow = await agentRow(f);
      assert.equal(removedRow.scopes.find((entry) => entry.scope === scope).state, 'missing');
      if (storedProof) {
        assert.deepEqual(await readFile(storedProof.file), storedProof.bytes);
        assert.equal(removedRow.proof.state, 'stale');
        assert.equal(removedRow.proof.reason, 'proof-context-changed');
      }
      const current = await preview(f);
      assert.equal(current.operation, 'unchanged');
      assert.equal(current.removedHooks, 0);
      const setup = await f.request('/api/agent-setup/preview', { agent, scope });
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      assert.equal(schemas.validateSetupPreview(setup.body), true);
      const reenabled = await f.request('/api/agent-setup/apply', {
        previewId: setup.body.id,
        confirm: true,
        ...Object.fromEntries(
          Object.entries(setup.body.needs)
            .filter(([, needed]) => needed)
            .map(([key]) => [key, true]),
        ),
      });
      assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
      assert.equal(schemas.validateSetupResult(reenabled.body), true);
      assert.equal(reenabled.body.status, 'configured');
      const row = await agentRow(f);
      assert.equal(row.scopes.find((entry) => entry.scope === scope).state, 'present');
      assert.equal(
        row.scopes.find((entry) => entry.scope === scope).reason,
        'matches-current-install',
      );
      assert.notEqual(row.proof.state, 'verified');
      if (storedProof) assert.equal(row.proof.reason, 'proof-context-changed');
      assert.deepEqual(await readFile(other), otherBytes);
    });
  }

test('disconnect refuses HTTP auth, Origin, encoding, bounded bodies and browser-selected filesystem fields', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/agent-disconnect',
    '/api/agent-disconnect/preview',
    '/api/agent-disconnect/apply',
  ]) {
    const body = path.endsWith('disconnect') ? undefined : {};
    assert.equal((await f.request(path, body, { Authorization: '' })).status, 401);
    assert.equal((await f.request(path, body, { Origin: 'https://foreign.invalid' })).status, 403);
  }
  for (const path of ['/api/agent-disconnect/preview', '/api/agent-disconnect/apply']) {
    assert.equal((await f.request(path, Buffer.from([0xff]))).status, 400);
    assert.equal((await f.request(path, Buffer.alloc(4097, 'x'))).status, 413);
    assert.equal((await f.request(path, {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.request(path, {}, { 'Content-Encoding': 'gzip' })).status, 415);
    const rejected = await f.request(path, {
      agent: f.agent,
      scope: f.scope,
      path: f.file,
      command: command(f.agent),
    });
    assert.equal(rejected.status, 400);
    f.privateProjection(rejected.body);
  }
  for (const selection of [
    { agent: ['claude-code'], scope: 'project' },
    { agent: 'claude-code', scope: ['project'] },
    { agent: 'copilot', scope: 'project' },
  ])
    assert.equal((await f.request('/api/agent-disconnect/preview', selection)).status, 400);
  const approved = await preview(f);
  for (const extra of [
    { confirm: true },
    { scope: 'user' },
    { command: command(f.agent) },
    { path: f.file },
  ])
    assert.equal(
      (await f.request('/api/agent-disconnect/apply', { ...consent(approved), ...extra })).status,
      400,
    );
  assert.deepEqual(await readFile(f.file), f.before);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});

test('source byte or mode changes invalidate an approved disconnect without backup or replacement', async (t) => {
  for (const change of ['bytes', 'mode'])
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const approved = await preview(f);
      const changed = Buffer.from('{"edited":"PRIVATE_LATE_EDITOR"}');
      if (change === 'bytes') await writeFile(f.file, changed);
      else await chmod(f.file, 0o600);
      const response = await f.request('/api/agent-disconnect/apply', consent(approved));
      assert.equal(response.status, 409, JSON.stringify(response.body));
      f.privateProjection(response.body);
      assert.deepEqual(await readFile(f.file), change === 'bytes' ? changed : f.before);
      assert.equal((await stat(f.file)).mode & 0o777, change === 'mode' ? 0o600 : 0o640);
      await assert.rejects(access(join(f.home, 'backups/console-disconnect')), { code: 'ENOENT' });
    });
});

test('runtime revision and replaced project identity invalidate previews before writing', async (t) => {
  let revision = 'a'.repeat(64);
  const f = await fixture(t, { runtime: async () => revision });
  let approved = await preview(f);
  revision = 'b'.repeat(64);
  assert.equal((await f.request('/api/agent-disconnect/apply', consent(approved))).status, 409);
  assert.deepEqual(await readFile(f.file), f.before);
  approved = await preview(f);
  await rename(f.project, `${f.project}-old`);
  await mkdir(dirname(f.file), { recursive: true });
  await writeFile(f.file, f.before);
  const response = await f.request('/api/agent-disconnect/apply', consent(approved));
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(await readFile(f.file), f.before);
  assert.deepEqual(await readFile(join(`${f.project}-old`, target(f.agent))), f.before);
  await assert.rejects(access(join(f.home, 'backups/console-disconnect')), { code: 'ENOENT' });
});

test('canonical home alias discloses shared impact and requires shared-scope consent', async (t) => {
  const f = await fixture(t, { aliasHome: true });
  const approved = await preview(f);
  assert.equal(approved.scope, 'project');
  assert.equal(approved.scopeImpact, 'all-workspaces');
  assert.equal(approved.needs.acknowledgeSharedScope, true);
  assert.equal(approved.target, '~/.claude/settings.json');
  const body = consent(approved);
  delete body.acknowledgeSharedScope;
  assert.equal((await f.request('/api/agent-disconnect/apply', body)).status, 400);
  assert.deepEqual(await readFile(f.file), f.before);
  assert.equal((await f.request('/api/agent-disconnect/apply', consent(approved))).status, 200);
});

test('an exact runtime command is removable while a suffix lookalike remains foreign', async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  const lookalike = { type: 'command', command: 'echo hook claude-code' };
  config.hooks.PreToolUse[0].hooks.push(lookalike);
  await writeFile(f.file, JSON.stringify(config));
  const approved = await preview(f);
  assert.equal(approved.removedHooks, 3);
  assert.equal(approved.remainingLookalikes, 1);
  assert.equal(approved.preservedHooks, 3);
  const response = await f.request('/api/agent-disconnect/apply', consent(approved));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.remainingLookalikes, 1);
  const after = JSON.parse(await readFile(f.file, 'utf8'));
  assert.ok(after.hooks.PreToolUse[0].hooks.some((row) => row.command === lookalike.command));
  assert.equal((await agentRow(f)).scopes[0].state, 'changed');
});
