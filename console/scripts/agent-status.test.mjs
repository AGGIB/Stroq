import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAgentStatus } from './agent-status.mjs';

const adapterPath = new URL('../.local-engine/agent-status-engine.js', import.meta.url);
const adapter = await import(adapterPath.href);
const NOW = Date.parse('2026-10-23T06:00:00.000Z');
const target = (agent) =>
  agent === 'claude-code' ? '.claude/settings.json' : `.${agent}/hooks.json`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stroq-agent-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const userHome = join(root, 'user');
  const home = join(userHome, '.stroq');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  const cli = join(root, 'engine.js');
  const packagePath = join(root, 'package.json');
  await writeFile(cli, '/* inert current engine fixture */');
  await writeFile(packagePath, JSON.stringify({ version: '0.28.0' }));
  const options = { project, userHome, home, paths: { cli, package: packagePath }, now: () => NOW };
  const command = (agent) => `"${process.execPath}" "${cli}" hook ${agent}`;
  async function write(agent, scope, config) {
    const file = join(scope === 'user' ? userHome : project, target(agent));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
    return file;
  }
  const service = await createAgentStatus(options);
  t.after(() => service.close());
  const get = async (agent) => {
    const response = await service.read();
    assert.equal(response.status, 200);
    return response.body.agents.find((entry) => entry.id === agent);
  };
  return { ...options, service, command, write, get };
}

test('a read reports three agents and both scopes without creating anything', async (t) => {
  const f = await fixture(t);
  const response = await f.service.read();
  assert.equal(response.body.schema, 'stroq-agents/1');
  assert.equal(response.body.source, 'local');
  assert.equal(response.body.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    response.body.agents.map((agent) => agent.id),
    ['claude-code', 'cursor', 'codex'],
  );
  for (const agent of response.body.agents) {
    assert.equal(agent.hostVersion, null);
    assert.deepEqual(
      agent.scopes.map((scope) => scope.scope),
      ['project', 'user'],
    );
    assert(agent.scopes.every((scope) => scope.state === 'missing'));
    assert.equal(agent.observation.state, 'missing');
    assert.equal(agent.proof.state, agent.id === 'cursor' ? 'unsupported' : 'missing');
  }
  assert.deepEqual(await readdir(f.home), []);
  assert.deepEqual(await readdir(f.project), []);
});

test('windsurf hook files, records, stamps and proofs never produce a reported agent', async (t) => {
  const f = await fixture(t);
  const hooks = JSON.stringify({
    hooks: { pre_run_command: [{ command: f.command('windsurf') }] },
  });
  for (const file of [
    join(f.project, '.windsurf/hooks.json'),
    join(f.userHome, '.codeium/windsurf/hooks.json'),
  ]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, hooks);
  }
  await writeFile(
    join(f.home, 'install.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'windsurf:project': {
          command: f.command('windsurf'),
          recordedAt: '2026-10-22T00:00:00.000Z',
        },
      },
    }),
  );
  await mkdir(join(f.home, 'last-hook'));
  await writeFile(join(f.home, 'last-hook/windsurf'), '2026-10-23T05:00:00.000Z\n');
  await mkdir(join(f.home, 'live'));
  await writeFile(
    join(f.home, 'live/windsurf.json'),
    JSON.stringify(historicalResult({ agent: 'windsurf' })),
  );
  const response = await f.service.read();
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.agents.map((agent) => agent.id),
    ['claude-code', 'cursor', 'codex'],
  );
  assert(!JSON.stringify(response).includes('windsurf'));
});

test('all three exact current configurations are recognized per scope', async (t) => {
  const f = await fixture(t);
  for (const agent of ['claude-code', 'cursor', 'codex']) {
    await f.write(agent, 'project', adapter.expectedConfiguration(agent, f.command(agent)));
    const row = await f.get(agent);
    assert.equal(row.scopes[0].state, 'present');
    assert.equal(row.scopes[0].reason, 'matches-current-install');
    assert(row.scopes[0].events.every((event) => event.state === 'present'));
    assert.equal(row.scopes[1].state, 'missing');
    assert.equal(row.scopes[0].approval, agent === 'codex' ? 'required' : 'not-required');
  }
});

test('a forged suffix, note containing the right command and narrowed matcher are changed', async (t) => {
  const f = await fixture(t);
  const config = adapter.expectedConfiguration('claude-code', f.command('claude-code'));
  config.note = f.command('claude-code');
  config.hooks.PreToolUse[0].hooks[0].command = 'echo hook claude-code';
  await f.write('claude-code', 'project', config);
  let scope = (await f.get('claude-code')).scopes[0];
  assert.equal(scope.state, 'changed');
  assert.equal(scope.reason, 'hook-command-changed');
  config.hooks.PreToolUse[0].hooks[0].command = f.command('claude-code');
  config.hooks.PreToolUse[0].matcher = 'Bash';
  await f.write('claude-code', 'project', config);
  scope = (await f.get('claude-code')).scopes[0];
  assert.equal(scope.state, 'changed');
  assert.equal(scope.reason, 'hook-options-changed');
});

test('Cursor failClosed, timeouts, duplicate entries and missing event matter', async (t) => {
  const f = await fixture(t);
  for (const change of [
    (config) => {
      config.hooks.beforeShellExecution[0].failClosed = false;
    },
    (config) => {
      config.hooks.beforeShellExecution[0].timeout = 2;
    },
    (config) => {
      config.hooks.beforeShellExecution.push(config.hooks.beforeShellExecution[0]);
    },
    (config) => {
      delete config.hooks.beforeMCPExecution;
    },
    (config) => {
      delete config.version;
    },
  ]) {
    const config = adapter.expectedConfiguration('cursor', f.command('cursor'));
    change(config);
    await f.write('cursor', 'project', config);
    assert.equal((await f.get('cursor')).scopes[0].state, 'changed');
  }
});

test('invalid JSON, unsafe links and disabled hooks are not missing or protected', async (t) => {
  const f = await fixture(t);
  await f.write('claude-code', 'project', '{"token":"sensitive-broken-json');
  assert.equal((await f.get('claude-code')).scopes[0].state, 'invalid');
  const config = adapter.expectedConfiguration('claude-code', f.command('claude-code'));
  config.disableAllHooks = true;
  await f.write('claude-code', 'project', config);
  assert.equal((await f.get('claude-code')).scopes[0].reason, 'hooks-disabled');
  const secret = join(f.userHome, 'secret.txt');
  await writeFile(secret, 'sensitive-target-content');
  const file = await f.write('cursor', 'project', {});
  await rm(file);
  await symlink(secret, file);
  const response = await f.service.read();
  assert.equal(
    response.body.agents.find((agent) => agent.id === 'cursor').scopes[0].state,
    'unknown',
  );
  assert(!JSON.stringify(response).includes('sensitive'));
  assert(!JSON.stringify(response).includes(f.project));
  assert(!JSON.stringify(response).includes(f.userHome));
});

test('Codex approvals are never inferred from another hook approval', async (t) => {
  const f = await fixture(t);
  await f.write('codex', 'user', adapter.expectedConfiguration('codex', f.command('codex')));
  await writeFile(
    join(f.userHome, '.codex/config.toml'),
    '[hooks.state."other-hook"]\ntrusted_hash = "anything"\n',
  );
  assert.equal((await f.get('codex')).scopes[1].approval, 'unknown');
  assert.equal((await f.get('codex')).scopes[1].state, 'present');
});

test('machine observation is separate, validated, and cannot upgrade the configuration', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'last-hook'));
  await writeFile(join(f.home, 'last-hook/claude-code'), '2026-10-23T05:00:00.000Z\n');
  let row = await f.get('claude-code');
  assert.equal(row.observation.state, 'recorded');
  assert.equal(row.observation.scope, 'machine');
  assert(row.scopes.every((scope) => scope.state === 'missing'));
  await writeFile(join(f.home, 'last-hook/claude-code'), '2026-02-31T05:00:00.000Z\n');
  row = await f.get('claude-code');
  assert.equal(row.observation.state, 'invalid');
  assert.equal(row.observation.lastHookAt, null);
});

test('runtime deletion is re-read and never produces fabricated missing installations', async (t) => {
  const f = await fixture(t);
  await f.write(
    'claude-code',
    'project',
    adapter.expectedConfiguration('claude-code', f.command('claude-code')),
  );
  assert.equal((await f.get('claude-code')).scopes[0].state, 'present');
  await rm(f.paths.cli);
  const row = await f.get('claude-code');
  assert.equal(row.scopes[0].state, 'unknown');
  assert.equal(row.scopes[0].reason, 'runtime-unavailable');
});

function historicalResult(overrides = {}) {
  return {
    version: 1,
    agent: 'claude-code',
    hostVersion: '2.1.271',
    stroqVersion: '0.28.0',
    policySha256: adapter.policyFingerprint(null),
    at: '2026-10-22T00:00:00.000Z',
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
    ...overrides,
  };
}

test('historical proof uses the CLI validator and does not claim a current host version', async (t) => {
  const f = await fixture(t);
  await f.write(
    'claude-code',
    'project',
    adapter.expectedConfiguration('claude-code', f.command('claude-code')),
  );
  await mkdir(join(f.home, 'live'));
  await writeFile(join(f.home, 'live/claude-code.json'), JSON.stringify(historicalResult()));
  let proof = (await f.get('claude-code')).proof;
  assert.equal(proof.state, 'stale');
  assert.equal(proof.freshness, 'host-version-unknown');
  assert.equal(proof.reason, 'host-version-not-checked');
  assert.equal(proof.hostVersion, '2.1.271');
  await writeFile(
    join(f.home, 'live/claude-code.json'),
    JSON.stringify(historicalResult({ policySha256: 'f'.repeat(64) })),
  );
  proof = (await f.get('claude-code')).proof;
  assert.equal(proof.freshness, 'changed');
  assert.equal(proof.reason, 'proof-context-changed');
});

test('a live failure persists across config changes and a stand-in is never a host proof', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'live'));
  const failed = historicalResult({
    state: 'failed',
    probes: [
      {
        id: 'deny',
        kind: 'deny',
        mark: 'failed',
        reason: 'executed-despite-deny',
        evidence: { E1: true, E2: true, E3: false, E4: false },
      },
    ],
  });
  await writeFile(join(f.home, 'live/claude-code.json'), JSON.stringify(failed));
  assert.equal((await f.get('claude-code')).proof.state, 'failed');
  await writeFile(
    join(f.home, 'live/claude-code.json'),
    JSON.stringify(historicalResult({ mode: 'stand-in' })),
  );
  assert.equal((await f.get('claude-code')).proof.state, 'invalid');
  const inconsistent = historicalResult();
  inconsistent.probes[1].evidence.E3 = false;
  await writeFile(join(f.home, 'live/claude-code.json'), JSON.stringify(inconsistent));
  assert.equal((await f.get('claude-code')).proof.state, 'invalid');
});

test('proof metadata never forwards arbitrary strings, paths, details or unsupported versions', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'live'));
  const result = historicalResult({
    hostVersion: 'secret-host-value',
    caveats: ['secret-caveat-text'],
  });
  result.probes[0].detail = 'secret-detail-text';
  await writeFile(join(f.home, 'live/claude-code.json'), JSON.stringify(result));
  const row = await f.get('claude-code');
  assert.equal(row.proof.hostVersion, null);
  assert(!JSON.stringify(row).includes('secret'));
  await writeFile(
    join(f.home, 'live/claude-code.json'),
    JSON.stringify(historicalResult({ at: '2027-10-01T00:00:00.000Z' })),
  );
  assert.equal((await f.get('claude-code')).proof.state, 'invalid');
});
