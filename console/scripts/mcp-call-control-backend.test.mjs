import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-call-backend-loader-'));
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
async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-backend-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq'),
    cli = join(root, 'index.js');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await writeFile(cli, 'fixture', { mode: 0o600 });
  const file = join(project, '.mcp.json'),
    entry = { command: '/never-execute', args: ['hello'], env: { TOKEN: 'private' } };
  await writeFile(file, JSON.stringify({ mcpServers: { notes: entry }, other: { value: 1 } }), {
    mode: 0o600,
  });
  const source = (await discoverMcpSources({ project, userHome, platform: 'darwin' })).find(
    (s) => s.source === 'claude-code-project',
  );
  const selection = {
    id: mcpArtifactId(source, 'notes'),
    expectedSha256: mcpEntryMetadata(entry).sha256,
  };
  const backend = await createMcpCallControlBackend({
    project,
    userHome,
    home,
    cli,
    platform: 'darwin',
    mcpEnvironment: {},
    runtimeDigest: async () => 'a'.repeat(64),
    ...extra,
  });
  t.after(() => backend.close());
  return { root, project, userHome, home, file, entry, selection, backend };
}
const ack = (p) => ({
  previewId: p.id,
  confirm: true,
  acknowledgeScope: true,
  acknowledgeWeakening: true,
  acknowledgeSharedScope: true,
  acknowledgeLocalStorage: true,
});
const request = (f, s, action) => ({
  ...f.selection,
  expectedContextId: s.contextId,
  action,
  expectedRevision: s.revision,
  expectedEventId: s.current?.eventId ?? null,
});
test('inspect is read-only; setup reserves paused authority, preserves config and exact recheck survives old entry SHA', async (t) => {
  const f = await fixture(t);
  const s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.capability, 'setup-required');
  await assert.rejects(access(f.home));
  const p = (await f.backend.preview(request(f, s, 'setup'))).body;
  assert.equal(p.action, 'setup');
  const r = await f.backend.apply(ack(p));
  assert.equal(r.status, 200);
  assert.equal(r.body.authority, 'confirmed');
  assert.equal(r.body.configuration, 'confirmed');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(doc.other, { value: 1 });
  assert.ok(doc.mcpServers.notes.args.includes('--call-control'));
  const re = await f.backend.recheck({
    ...f.selection,
    expectedContextId: s.contextId,
    operationId: p.operationId,
    action: p.action,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: p.expectedEventId,
  });
  assert.equal(re.body.authority, 'recorded');
  assert.equal(re.body.configuration, 'confirmed');
});
test('recognized malformed apply consumes preview and wrong profile never reports absent', async (t) => {
  const f = await fixture(t),
    s = (await f.backend.inspect(f.selection)).body,
    p = (await f.backend.preview(request(f, s, 'setup'))).body;
  assert.equal((await f.backend.apply({ ...ack(p), command: 'bad' })).status, 400);
  assert.equal((await f.backend.apply(ack(p))).body.error, 'mcp-call-control-stale');
  const r = await f.backend.recheck({
    ...f.selection,
    expectedContextId: 'context-' + 'f'.repeat(64),
    operationId: p.operationId,
    action: p.action,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: null,
  });
  assert.equal(r.body.error, 'mcp-call-control-stale');
});
test('failure after paused authority keeps durable candidate and unconfirmed configuration', async (t) => {
  const f = await fixture(t, { fault: 'after-authority' }),
    s = (await f.backend.inspect(f.selection)).body,
    p = (await f.backend.preview(request(f, s, 'setup'))).body,
    r = await f.backend.apply(ack(p));
  assert.equal(r.body.authority, 'confirmed');
  assert.equal(r.body.configuration, 'unconfirmed');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).mcpServers.notes, f.entry);
  const re = await f.backend.recheck({
    ...f.selection,
    expectedContextId: s.contextId,
    operationId: p.operationId,
    action: p.action,
    controlId: p.controlId,
    invocationSha256: p.invocationSha256,
    expectedEventId: null,
  });
  assert.equal(re.body.authority, 'recorded');
  assert.equal(re.body.configuration, 'unconfirmed');
});

async function configuredFixture(t, extra = {}) {
  const f = await fixture(t, extra),
    initial = (await f.backend.inspect(f.selection)).body,
    setup = (await f.backend.preview(request(f, initial, 'setup'))).body,
    result = await f.backend.apply(ack(setup));
  assert.equal(result.body.configuration, 'confirmed');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  f.selection = {
    id: f.selection.id,
    expectedSha256: mcpEntryMetadata(doc.mcpServers.notes).sha256,
  };
  return { ...f, setup };
}
test('resume and pause alter compact authority only; stale parallel preview never grants twice', async (t) => {
  const f = await configuredFixture(t);
  let s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.current.mode, 'paused');
  assert.equal(s.observation.status, 'unobserved');
  const a = (await f.backend.preview(request(f, s, 'resume'))).body,
    b = (await f.backend.preview(request(f, s, 'resume'))).body,
    bytes = await readFile(f.file);
  assert.equal((await f.backend.apply(ack(a))).body.authority, 'confirmed');
  assert.equal((await f.backend.apply(ack(b))).body.error, 'mcp-call-control-stale');
  assert.deepEqual(await readFile(f.file), bytes);
  s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.current.mode, 'enabled');
  const p = (await f.backend.preview(request(f, s, 'pause'))).body;
  assert.equal((await f.backend.apply(ack(p))).body.authority, 'confirmed');
  s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.current.mode, 'paused');
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal(JSON.stringify(s).includes('private'), false);
});
test('preview capacity refuses a ninth and expiry consumes without changing configuration', async (t) => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time }),
    s = (await f.backend.inspect(f.selection)).body,
    plans = [];
  for (let i = 0; i < 8; i++) plans.push((await f.backend.preview(request(f, s, 'setup'))).body);
  assert.equal(
    (await f.backend.preview(request(f, s, 'setup'))).body.error,
    'mcp-call-control-limit',
  );
  time += 120001;
  assert.equal((await f.backend.apply(ack(plans[0]))).body.error, 'mcp-call-control-stale');
  await assert.rejects(access(f.home));
});
test('current invocation drift can be held paused but cannot resume until explicitly rebound', async (t) => {
  const f = await configuredFixture(t);
  let s = (await f.backend.inspect(f.selection)).body,
    p = (await f.backend.preview(request(f, s, 'resume'))).body;
  assert.equal((await f.backend.apply(ack(p))).body.authority, 'confirmed');
  const doc = JSON.parse(await readFile(f.file, 'utf8'));
  doc.mcpServers.notes.args.push('changed-upstream');
  await writeFile(f.file, JSON.stringify(doc), { mode: 0o600 });
  f.selection.expectedSha256 = mcpEntryMetadata(doc.mcpServers.notes).sha256;
  s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.capability, 'drifted');
  p = (await f.backend.preview(request(f, s, 'pause'))).body;
  assert.equal(p.invocationSha256, s.current.invocationSha256);
  assert.equal((await f.backend.apply(ack(p))).body.authority, 'confirmed');
  s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.current.mode, 'paused');
  assert.equal(
    (await f.backend.preview(request(f, s, 'resume'))).body.error,
    'mcp-call-control-unsupported',
  );
  p = (await f.backend.preview(request(f, s, 'rebind-paused'))).body;
  assert.equal(p.invocationSha256, s.invocationSha256);
  assert.equal((await f.backend.apply(ack(p))).body.authority, 'confirmed');
  s = (await f.backend.inspect(f.selection)).body;
  assert.equal(s.capability, 'supported');
  assert.equal(s.current.mode, 'paused');
});

test('a reviewed setup preview remains usable after the scan deadline while its 120s preview is fresh', async (t) => {
  const originalNow = Date.now;
  let advance = 0;
  Date.now = () => originalNow() + advance;
  try {
    const f = await fixture(t, { now: () => originalNow() + advance }),
      s = (await f.backend.inspect(f.selection)).body,
      p = (await f.backend.preview(request(f, s, 'setup'))).body;
    advance = 11000;
    const result = await f.backend.apply(ack(p));
    assert.equal(result.status, 200);
    assert.equal(result.body.configuration, 'confirmed');
  } finally {
    Date.now = originalNow;
  }
});
