import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, config, preview, apply, vault } from './mcp-containment-test-helpers.mjs';

const protect = (service, installed) =>
  service.preview({
    action: 'protect-registration',
    id: installed.id,
    expectedSha256: installed.expectedSha256,
  });
const commit = (service, plan, extra = {}) =>
  service.apply({
    previewId: plan.id,
    confirm: true,
    acknowledgeSessionLimits: true,
    acknowledgePrivateRetention: true,
    acknowledgeProxyEffects: true,
    ...(plan.artifact.scope === 'user' && plan.action === 'protect-registration'
      ? { acknowledgeSharedPolicyContext: true }
      : {}),
    ...extra,
  });

test('strict proxy protects one exact entry without executing it and restores exact bytes', async (t) => {
  const f = await fixture(t);
  const entry = {
    command: '/do-not-execute-stroq-mcp',
    args: ['--server', 'untouched'],
    env: { DECLARED_TOKEN: 'private-fixture-value' },
    cwd: '/server-cwd-preserved',
    custom: true,
  };
  const installed = await config(f, {
    entry,
    doc: {
      header: 7,
      mcpServers: {
        notes: entry,
        sibling: { command: '/untouched', args: [] },
      },
    },
  });
  const plan = await protect(f.containment, installed);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.proxy.mode, 'strict');
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  await assert.rejects(access(join(f.userHome, '.stroq')));
  const result = await commit(f.containment, plan.body);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'configured');
  assert.equal(result.body.hostEnforcement, false);
  const changed = JSON.parse(await readFile(installed.file, 'utf8'));
  assert.equal(changed.header, 7);
  assert.equal(changed.mcpServers.sibling.command, '/untouched');
  const guarded = changed.mcpServers.notes;
  assert.equal(guarded.command, process.execPath);
  assert.equal(guarded.cwd, entry.cwd);
  assert.deepEqual(guarded.env, {
    ...entry.env,
    STROQ_HOME: join(f.userHome, '.stroq'),
    HOME: f.userHome,
    USERPROFILE: f.userHome,
  });
  assert.deepEqual(guarded.args.slice(-3), [entry.command, ...entry.args]);
  assert.ok(guarded.args.includes('--strict'));
  assert.equal(guarded.args[guarded.args.indexOf('--cwd') + 1], f.project);
  assert.equal(guarded.args[guarded.args.indexOf('--pass-env') + 1], 'DECLARED_TOKEN');
  const state = await f.containment.state();
  const record = state.body.records[0];
  assert.equal(record.change, 'protect-registration');
  assert.equal(record.status, 'configured');
  assert.equal(record.slot, 'guarded');
  assert.equal(record.proxy.runtimeMatches, true);
  assert.ok(
    !JSON.stringify([plan.body, result.body, state.body]).includes('private-fixture-value'),
  );
  assert.notEqual(record.changedEntrySha256, installed.expectedSha256);
  assert.deepEqual(await readFile(join(vault(f, record.id), 'before.json')), installed.bytes);
  const undo = await f.containment.preview({ action: 'restore-registration', recordId: record.id });
  assert.equal(undo.status, 200);
  assert.equal((await commit(f.containment, undo.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('tool review is an explicit strict wrapper opt-in with separate metadata consent and exact undo', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const plan = await f.containment.preview({
    action: 'protect-registration',
    id: installed.id,
    expectedSha256: installed.expectedSha256,
    toolApproval: true,
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.proxy.toolApproval, true);
  assert.equal((await commit(f.containment, plan.body)).status, 400);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  const result = await commit(f.containment, plan.body, { acknowledgeToolContracts: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.proxy.toolApproval, true);
  const entry = JSON.parse(await readFile(installed.file, 'utf8')).mcpServers.notes;
  assert.ok(entry.args.includes('--tool-approval'));
  assert.ok(entry.args.includes('--strict'));
  const state = await f.containment.state();
  assert.equal(state.body.records[0].proxy.toolApproval, true);
  const undo = await f.containment.preview({
    action: 'restore-registration',
    recordId: result.body.recordId,
  });
  assert.equal(undo.status, 200);
  assert.equal((await commit(f.containment, undo.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('proxy undo preserves newer siblings and refuses every changed installed wrapper', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const plan = await protect(f.containment, installed);
  assert.equal(plan.status, 200);
  const result = await commit(f.containment, plan.body);
  assert.equal(result.status, 200);
  const doc = JSON.parse(await readFile(installed.file, 'utf8'));
  doc.mcpServers.newer = { command: '/new', env: { KEEP: 'yes' } };
  await writeFile(installed.file, `${JSON.stringify(doc)}\n`);
  const undo = await f.containment.preview({
    action: 'restore-registration',
    recordId: result.body.recordId,
  });
  assert.equal(undo.status, 200);
  doc.mcpServers.notes.args.push('outside-edit');
  const edited = `${JSON.stringify(doc)}\n`;
  await writeFile(installed.file, edited);
  assert.equal((await commit(f.containment, undo.body)).status, 409);
  assert.equal(
    (
      await f.containment.preview({
        action: 'restore-registration',
        recordId: result.body.recordId,
      })
    ).status,
    409,
  );
  assert.equal(await readFile(installed.file, 'utf8'), edited);
  doc.mcpServers.notes.args.pop();
  await writeFile(installed.file, `${JSON.stringify(doc)}\n`);
  const fresh = await f.containment.preview({
    action: 'restore-registration',
    recordId: result.body.recordId,
  });
  assert.equal((await commit(f.containment, fresh.body)).status, 200);
  const restored = JSON.parse(await readFile(installed.file, 'utf8'));
  assert.deepEqual(restored.mcpServers.notes, installed.entry);
  assert.deepEqual(restored.mcpServers.newer, doc.mcpServers.newer);
});

test('user proxy requires distinct acknowledgements, retains policy context and permits guarded undo elsewhere', async (t) => {
  const f = await fixture(t),
    installed = await config(f, { agent: 'cursor', scope: 'user' });
  const plan = await protect(f.containment, installed);
  assert.equal(plan.status, 200);
  const base = {
    previewId: plan.body.id,
    confirm: true,
    acknowledgeSessionLimits: true,
    acknowledgePrivateRetention: true,
  };
  assert.equal((await f.containment.apply(base)).status, 400);
  assert.equal((await f.containment.apply({ ...base, acknowledgeProxyEffects: true })).status, 400);
  assert.equal((await commit(f.containment, plan.body)).status, 200);
  const other = join(f.dir, 'other');
  await mkdir(other);
  const service = f.service({ project: other });
  const state = await service.state();
  assert.equal(state.body.records[0].proxy.policyWorkspaceId, plan.body.workspaceId);
  assert.equal(state.body.records[0].status, 'configured');
  const undo = await service.preview({
    action: 'restore-registration',
    recordId: plan.body.recordId,
  });
  assert.equal(undo.status, 200);
  assert.equal((await commit(service, undo.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('runtime drift is visible, stale protect is refused, existing proxy can still be undone', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const plan = await protect(f.containment, installed);
  assert.equal(plan.status, 200);
  assert.equal((await commit(f.containment, plan.body)).status, 200);
  const changed = f.service({ runtimeDigest: async () => 'b'.repeat(64) });
  const state = await changed.state();
  assert.equal(state.body.records[0].proxy.runtimeMatches, false);
  const undo = await changed.preview({
    action: 'restore-registration',
    recordId: plan.body.recordId,
  });
  assert.equal(undo.status, 200);
  assert.equal((await commit(changed, undo.body)).status, 200);
  let runtime = 'c'.repeat(64);
  const moving = f.service({ runtimeDigest: async () => runtime });
  const stale = await protect(moving, installed);
  assert.equal(stale.status, 200);
  runtime = 'd'.repeat(64);
  assert.equal((await commit(moving, stale.body)).status, 409);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('unsupported transports, malformed env and existing wrappers are left untouched', async (t) => {
  const f = await fixture(t);
  for (const entry of [
    { command: '/server', url: null },
    { command: '/server', serverUrl: 4 },
    { command: '/server', type: 'http' },
    { command: '/server', args: [7] },
    { command: '/server', env: { BAD: 3 } },
    { command: '/server', env: { 'A,B': 'x' } },
    ...[
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_COMPILE_CACHE',
      'STROQ_HOME',
      'HOME',
      'USERPROFILE',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
    ].map((name) => ({ command: '/server', env: { [name]: 'x' } })),
    { command: 'stroq', args: ['mcp', '--server', 'notes', '--', '/server'] },
    { command: 'npx', args: ['@stroq/cli', 'mcp', '--server', 'notes', '--', '/server'] },
    {
      command: process.execPath,
      args: [
        '/old/stroq/dist/index.js',
        'mcp',
        '--server',
        'notes',
        '--client',
        'cursor',
        '--pin',
        `sha256:${'a'.repeat(64)}`,
        '--',
        '/server',
      ],
    },
  ]) {
    const installed = await config(f, { entry });
    assert.notEqual((await protect(f.containment, installed)).status, 200, JSON.stringify(entry));
    assert.deepEqual(await readFile(installed.file), installed.bytes);
  }
});

test('GET, preview and apply never execute the configured server command', async (t) => {
  const f = await fixture(t),
    sentinel = join(f.dir, 'never-started');
  const installed = await config(f, {
    entry: {
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`],
    },
  });
  assert.equal((await f.containment.state()).status, 200);
  const plan = await protect(f.containment, installed);
  assert.equal(plan.status, 200);
  assert.equal((await commit(f.containment, plan.body)).status, 200);
  assert.equal((await f.containment.state()).body.records[0].status, 'configured');
  await assert.rejects(access(sentinel));
});

test('reordered, client-less and pinned Stroq wrappers are explicitly unsupported', async (t) => {
  const f = await fixture(t);
  for (const flags of [
    ['--strict', '--server', 'notes', '--client', 'cursor', '--cloak'],
    ['--server', 'notes', '--strict'],
    ['--pin', `sha256:${'a'.repeat(64)}`, '--client', 'cursor', '--server', 'notes'],
  ]) {
    const installed = await config(f, {
      entry: {
        command: process.execPath,
        args: ['/old/stroq/dist/index.js', 'mcp', ...flags, '--', '/server'],
      },
    });
    const result = await protect(f.containment, installed);
    assert.equal(result.body.error, 'mcp-containment-unsupported');
    assert.deepEqual(await readFile(installed.file), installed.bytes);
  }
});

test('legacy v1 records remain byte-identical on reads and restore without migration', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  assert.equal(removed.status, 200);
  const directory = vault(f, removed.body.recordId),
    path = join(directory, 'manifest.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  const { change, proxy, changedEntrySha256, changedSha256, changedBytes, ...common } = current;
  const legacy = {
    ...common,
    schema: 'stroq-mcp-containment-record/1',
    removedSha256: changedSha256,
    removedBytes: changedBytes,
  };
  const raw = `${JSON.stringify(legacy, null, '\t')}\n`;
  await writeFile(path, raw);
  await rename(join(directory, 'changed.json'), join(directory, 'removed.json'));
  const state = await f.containment.state();
  assert.equal(state.body.records[0].change, 'remove-registration');
  assert.equal(state.body.records[0].proxy, null);
  assert.equal(state.body.records[0].status, 'removed');
  assert.equal(await readFile(path, 'utf8'), raw);
  const undo = await f.containment.preview({
    action: 'restore-registration',
    recordId: removed.body.recordId,
  });
  assert.equal(undo.status, 200);
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.equal((await apply(f.containment, undo.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schema, 'stroq-mcp-containment-record/1');
  await access(join(directory, 'removed.json'));
  await assert.rejects(access(join(directory, 'changed.json')));
});

test('interrupted protection retains prepared recovery and guarded undo is possible', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const interrupted = f.service({ fault: 'after-rename' });
  const plan = await protect(interrupted, installed);
  assert.equal(plan.status, 200);
  assert.equal((await commit(interrupted, plan.body)).status, 422);
  const state = await f.containment.state();
  assert.equal(state.body.records[0].status, 'recovery-required');
  assert.equal(state.body.records[0].slot, 'guarded');
  const undo = await f.containment.preview({
    action: 'restore-registration',
    recordId: plan.body.recordId,
  });
  assert.equal(undo.status, 200);
  assert.equal((await commit(f.containment, undo.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});
