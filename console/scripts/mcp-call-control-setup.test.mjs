import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-call-setup-loader-'));
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
const { callControlProxy } = await imported('./mcp-call-control-proxy.ts');
const { reserveSetup, readSetup, markSetupAuthority, finishSetup, verifySetupConfiguration } =
  await imported('./mcp-call-control-setup.ts');
const { context } = await imported('./mcp-containment-operations.ts');
const { publicArtifact } = await imported('./mcp-containment-vault.ts');
const { discoverMcpSources } = await imported('./mcp-sources.ts');
const { binding, hash } = await imported('./mcp-containment-files.mjs');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    user = join(root, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(user, { mode: 0o700 });
  const ctx = await context(project, user, 'darwin', Date.now() + 60000),
    source = (await discoverMcpSources({ project, userHome: user, platform: 'darwin' })).find(
      (s) => s.source === 'claude-code-project',
    );
  const before = Buffer.from(
      JSON.stringify({ mcpServers: { notes: { command: '/never' } }, sibling: 'kept' }),
    ),
    candidate = Buffer.from('fixture');
  const file = join(project, '.mcp.json');
  await writeFile(file, before, { mode: 0o600 });
  const controlId = randomUUID(),
    home = join(user, '.stroq'),
    proxy = callControlProxy(
      { command: '/never' },
      'notes',
      'claude-code',
      {
        command: process.execPath,
        entry: join(root, 'index.js'),
        home,
        userHome: user,
        fingerprint: '0'.repeat(64),
      },
      project,
      controlId,
    );
  const changed = Buffer.from(
    JSON.stringify({ mcpServers: { notes: proxy.entry }, sibling: 'kept' }),
  );
  const data = {
    operationId: randomUUID(),
    controlId,
    invocationSha256: 'a'.repeat(64),
    contextId: 'context-' + hash(JSON.stringify([home, user])),
    proxyWorkspaceId: ctx.workspaceId,
    createdAt: new Date().toISOString(),
    artifact: publicArtifact(source, 'notes', hash(JSON.stringify({ command: '/never' }))),
    name: 'notes',
    sourceType: source.source,
    relativePath: source.relativePath,
    sourceRootBinding: binding(source.root),
    userBinding: binding(ctx.user),
    configSha256: hash(before),
    mode: 0o600,
    candidateSha256: hash(changed),
    before,
    candidate: changed,
  };
  return {
    root,
    ctx,
    source,
    data,
    file,
    vault: join(user, '.stroq', 'console', 'mcp-call-control-setup'),
  };
}
test('capacity refuses a 33rd setup without preventing existing retained record completion', async (t) => {
  const f = await fixture(t);
  let first;
  for (let i = 0; i < 32; i++) {
    const r = await reserveSetup(f.ctx, { ...f.data, operationId: randomUUID() });
    first ??= r;
  }
  await assert.rejects(
    reserveSetup(f.ctx, { ...f.data, operationId: randomUUID() }),
    /mcp-call-control-limit/,
  );
  const marked = await markSetupAuthority(f.ctx, first, randomUUID(), 'c'.repeat(64));
  const done = await finishSetup(f.ctx, marked, 'unconfirmed');
  assert.equal(done.manifest.phase, 'configuration-unconfirmed');
});
test('read preserves retained bytes and exact source comparison never substitutes old before SHA', async (t) => {
  const f = await fixture(t),
    r = await reserveSetup(f.ctx, f.data);
  const manifest = join(r.directory, 'manifest.json'),
    bytes = await readFile(manifest);
  assert.equal(await verifySetupConfiguration(f.ctx, r), 'unconfirmed');
  await writeFile(f.file, f.data.candidate, { mode: 0o600 });
  assert.equal(await verifySetupConfiguration(f.ctx, r), 'confirmed');
  assert.ok(await readSetup(f.ctx, f.data.operationId));
  assert.deepEqual(await readFile(manifest), bytes);
  await writeFile(join(r.directory, 'foreign'), 'bad', { mode: 0o600 });
  await assert.rejects(readSetup(f.ctx, f.data.operationId), /mcp-call-control-unavailable/);
  assert.equal((await readdir(r.directory)).includes('foreign'), true);
});

test('a malformed retained manifest blocks a new setup without read repair', async (t) => {
  const f = await fixture(t),
    record = await reserveSetup(f.ctx, f.data),
    manifest = join(record.directory, 'manifest.json');
  await writeFile(manifest, '{"schema":"foreign"}\n', { mode: 0o600 });
  await assert.rejects(
    reserveSetup(f.ctx, { ...f.data, operationId: randomUUID() }),
    /mcp-call-control-unavailable/,
  );
  assert.equal(await readFile(manifest, 'utf8'), '{"schema":"foreign"}\n');
});
