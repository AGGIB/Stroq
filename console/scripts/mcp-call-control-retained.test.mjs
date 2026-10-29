import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-call-retained-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const imported = (p) => tsImport(p, { parentURL: import.meta.url, tsconfig });
const { createMcpCallControlBackend } = await imported('./mcp-call-control-backend.ts');
const { mcpArtifactId, mcpEntryMetadata, discoverMcpSources } = await imported('./mcp-sources.ts');
const { validateMcpCallControlOverview } = await imported('../lib/mcp-call-control-overview.ts');
const ack = (p) => ({
  previewId: p.id,
  confirm: true,
  acknowledgeScope: true,
  acknowledgeWeakening: true,
  acknowledgeSharedScope: true,
  acknowledgeLocalStorage: true,
});
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-retained-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq'),
    cli = join(root, 'index.js');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await writeFile(cli, 'fixture', { mode: 0o600 });
  const file = join(project, '.mcp.json'),
    entry = { command: '/never-execute', args: ['hello'] };
  await writeFile(file, JSON.stringify({ mcpServers: { notes: entry } }), { mode: 0o600 });
  const source = (await discoverMcpSources({ project, userHome, platform: 'darwin' })).find(
    (s) => s.source === 'claude-code-project',
  );
  const selection = {
    id: mcpArtifactId(source, 'notes'),
    expectedSha256: mcpEntryMetadata(entry).sha256,
  };
  let reads = 0;
  const options = {
    project,
    userHome,
    home,
    cli,
    platform: 'darwin',
    mcpEnvironment: {},
    runtimeDigest: async () => {
      reads++;
      return 'a'.repeat(64);
    },
  };
  const backend = await createMcpCallControlBackend(options);
  t.after(() => backend.close());
  return { root, project, userHome, home, file, selection, backend, options, reads: () => reads };
}
const request = (selection, s, action) => ({
  ...selection,
  expectedContextId: s.contextId,
  action,
  expectedRevision: s.revision,
  expectedEventId: s.current?.eventId ?? null,
});
test('initial setup does not rewrite a pinned launch whose separate confirmation cannot adopt the new flag', async (t) => {
  const f = await fixture(t);
  const entry = {
    command: process.execPath,
    args: [
      f.options.cli,
      'mcp',
      '--server',
      'notes',
      '--client',
      'claude-code',
      '--cwd',
      f.project,
      '--pass-env',
      '',
      '--pin',
      'sha256:' + 'b'.repeat(64),
      '--',
      '/never-execute',
    ],
    env: { STROQ_HOME: f.home, HOME: f.userHome, USERPROFILE: f.userHome },
  };
  const bytes = JSON.stringify({ mcpServers: { notes: entry } });
  await writeFile(f.file, bytes, { mode: 0o600 });
  const selection = { ...f.selection, expectedSha256: mcpEntryMetadata(entry).sha256 },
    i = (await f.backend.inspect(selection)).body;
  assert.equal(i.modes.pinned, true);
  assert.equal(i.capability, 'unsupported');
  assert.equal(
    (await f.backend.preview(request(selection, i, 'setup'))).body.error,
    'mcp-call-control-unsupported',
  );
  assert.equal(await readFile(f.file, 'utf8'), bytes);
  await assert.rejects(access(f.home));
});
async function configured(f) {
  const i = (await f.backend.inspect(f.selection)).body;
  const p = (await f.backend.preview(request(f.selection, i, 'setup'))).body;
  const receipt = await f.backend.apply(ack(p));
  assert.equal(receipt.body.authority, 'confirmed');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  const selection = {
    ...f.selection,
    expectedSha256: mcpEntryMetadata(doc.mcpServers.notes).sha256,
  };
  const s = (await f.backend.inspect(selection)).body;
  const resume = (await f.backend.preview(request(selection, s, 'resume'))).body;
  assert.equal((await f.backend.apply(ack(resume))).body.authority, 'confirmed');
  return { p, selection };
}
test('passive overview does not initialize storage and captures runtime once', async (t) => {
  const f = await fixture(t),
    before = f.reads();
  const result = await f.backend.state();
  assert.equal(result.status, 200);
  assert.equal(validateMcpCallControlOverview(result.body), true);
  assert.equal(result.body.authority, 'missing');
  assert.deepEqual(result.body.controls, []);
  assert.equal(f.reads() - before, 1);
  await assert.rejects(access(f.home));
});
test('retained exact setup can pause an enabled slot after registration removal without recreating it', async (t) => {
  const f = await fixture(t),
    { p } = await configured(f);
  await rm(f.file);
  const state = (await f.backend.state()).body;
  assert.equal(validateMcpCallControlOverview(state), true);
  const row = state.controls.find((c) => c.controlId === p.controlId);
  assert.equal(row.capability, 'missing-registration');
  assert.equal(row.retainedSetupId, p.operationId);
  assert.equal(row.current.mode, 'enabled');
  assert.equal(row.proxyWorkspaceId, p.proxyWorkspaceId);
  const target = {
    retainedSetupId: p.operationId,
    expectedContextId: state.contextId,
    action: 'pause',
    expectedRevision: state.revision,
    expectedEventId: row.current.eventId,
  };
  assert.equal((await f.backend.preview({ ...target, action: 'resume' })).status, 400);
  assert.equal(
    (await f.backend.preview({ ...target, expectedContextId: 'context-' + 'f'.repeat(64) })).status,
    409,
  );
  const pause = await f.backend.preview(target);
  assert.equal(pause.status, 200);
  const applied = await f.backend.apply(ack(pause.body));
  assert.equal(applied.body.authority, 'confirmed');
  assert.equal(applied.body.configuration, 'unchanged');
  assert.equal(applied.body.requiresReconnect, false);
  await assert.rejects(access(f.file));
  const recheck = await f.backend.recheck({
    ...f.selection,
    expectedContextId: state.contextId,
    operationId: pause.body.operationId,
    action: 'pause',
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: target.expectedEventId,
  });
  assert.equal(recheck.body.authority, 'recorded');
  assert.equal(recheck.body.recordedEventId, pause.body.operationId);
  assert.equal(recheck.body.currentMode, 'paused');
  const other = await createMcpCallControlBackend(f.options);
  t.after(() => other.close());
  assert.equal((await other.state()).body.controls[0].current.mode, 'paused');
});
test('retained pause fails closed on changed authority, mismatched record and corrupted recovery payload', async (t) => {
  const f = await fixture(t),
    { p } = await configured(f),
    state = (await f.backend.state()).body;
  const row = state.controls[0],
    target = {
      retainedSetupId: p.operationId,
      expectedContextId: state.contextId,
      action: 'pause',
      expectedRevision: state.revision,
      expectedEventId: row.current.eventId,
    };
  const stale = await f.backend.preview({
    ...target,
    expectedEventId: '00000000-0000-4000-8000-000000000099',
  });
  assert.equal(stale.status, 409);
  const missing = await f.backend.preview({
    ...target,
    retainedSetupId: '00000000-0000-4000-8000-000000000099',
  });
  assert.equal(missing.status, 409);
  const preview = await f.backend.preview(target);
  assert.equal(preview.status, 200);
  const vault = join(f.userHome, '.stroq', 'console', 'mcp-call-control-setup', p.operationId);
  await writeFile(join(vault, 'candidate.json'), 'corrupt', { mode: 0o600 });
  assert.notEqual((await f.backend.apply(ack(preview.body))).status, 200);
  const now = (await f.backend.state()).body;
  assert.ok(now.gaps.includes('setup-unavailable'));
  assert.equal(now.controls[0].retainedSetupId, null);
  assert.equal(now.controls[0].current.mode, 'enabled');
});
test('overview boundary rejects duplicate slots, private fields, impossible authority and stale refusal evidence', async (t) => {
  const f = await fixture(t);
  await configured(f);
  const state = (await f.backend.state()).body;
  const check = (mutate) => {
    const value = structuredClone(state);
    mutate(value);
    assert.equal(validateMcpCallControlOverview(value), false);
  };
  check((v) => v.controls.push(v.controls[0]));
  check((v) => (v.controls[0].command = '/private/never'));
  check((v) => {
    v.authority = 'missing';
    v.revision = null;
  });
  check((v) => {
    v.authority = 'unavailable';
    v.revision = null;
  });
  check((v) => (v.gaps = ['source-limit', 'source-limit']));
  check((v) => {
    const row = v.controls[0];
    row.observation = {
      status: 'observed',
      at: '2000-01-01T00:00:00.000Z',
      eventId: row.current.eventId,
      invocationSha256: row.current.invocationSha256,
      reason: 'busy',
    };
  });
});
test('unfinished setup exposes only its exact durable recheck candidate after service restart', async (t) => {
  const f = await fixture(t);
  const faulted = await createMcpCallControlBackend({ ...f.options, fault: 'after-authority' });
  t.after(() => faulted.close());
  const inspection = (await faulted.inspect(f.selection)).body;
  const preview = (await faulted.preview(request(f.selection, inspection, 'setup'))).body;
  assert.equal((await faulted.apply(ack(preview))).body.configuration, 'unconfirmed');
  const state = (await f.backend.state()).body,
    row = state.controls[0];
  assert.equal(row.setupConfiguration, 'unconfirmed');
  assert.deepEqual(row.setupCandidate, {
    operationId: preview.operationId,
    artifact: preview.artifact,
    invocationSha256: preview.invocationSha256,
  });
  assert.equal(validateMcpCallControlOverview(state), true);
  const candidate = await readFile(
    join(
      f.userHome,
      '.stroq',
      'console',
      'mcp-call-control-setup',
      preview.operationId,
      'candidate.json',
    ),
  );
  await writeFile(f.file, candidate, { mode: 0o600 });
  const checked = (await f.backend.state()).body.controls[0];
  assert.equal(checked.setup, 'configuration-unconfirmed');
  assert.equal(checked.setupConfiguration, 'confirmed');
  assert.deepEqual(checked.setupCandidate, row.setupCandidate);
});
