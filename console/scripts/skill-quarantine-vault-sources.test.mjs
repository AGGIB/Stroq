import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-vault-sources-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    vault: join(repository, 'console/scripts/skill-quarantine-vault.ts'),
    capture: join(repository, 'console/scripts/skill-quarantine-capture.ts'),
    sources: join(repository, 'console/scripts/skill-sources.ts'),
    operations: join(repository, 'console/scripts/skill-quarantine-operations.ts'),
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
    js: "import { createRequire as createVaultRequire } from 'node:module'; const require = createVaultRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const load = (name) => import(pathToFileURL(join(output, `${name}.mjs`)).href);
const vault = await load('vault'),
  capture = await load('capture'),
  sources = await load('sources');
const operations = await load('operations');

async function fixture(t, version = 2, nestedPayload = false) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stroq-vault-source-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const stat = await lstat(path),
    root = { path, dev: stat.dev, ino: stat.ino };
  const id = randomUUID(),
    directory = vault.recordPath(root, id);
  await mkdir(join(directory, 'payload'), { recursive: true, mode: 0o700 });
  await writeFile(join(vault.vaultPath(root), '.gitignore'), '*\n', { mode: 0o600 });
  await writeFile(join(directory, 'payload/SKILL.md'), '# Notes\nSummarize a release.');
  if (nestedPayload) {
    await mkdir(join(directory, 'payload/reference'));
    await writeFile(
      join(
        directory,
        `payload/reference/${nestedPayload === 'managed' ? 'plugin.json' : 'SKILL.md'}`,
      ),
      '# Legacy nested instructions',
    );
  }
  const captured = await capture.captureSkill(
    root,
    join(directory, 'payload'),
    Date.now() + 10_000,
  );
  const selected = {
    skillSource: version === 1 ? 'claude-skills' : 'codex-skills',
    locator: version === 1 ? 'notes' : 'group/notes',
  };
  const legacyArtifact = {
    id: sources.skillArtifactId('claude-skills', 'project', 'notes'),
    name: 'notes',
    agent: 'claude-code',
    scope: 'project',
    sha256: captured.sha256,
  };
  const artifact =
    version === 1
      ? legacyArtifact
      : {
          id: sources.skillArtifactId(selected.skillSource, 'project', selected.locator),
          name: 'notes',
          agent: 'codex',
          skillSource: selected.skillSource,
          scope: 'project',
          sha256: captured.sha256,
          location: { label: selected.locator, redacted: false },
        };
  const manifest = {
    schema: `stroq-skill-quarantine-record/${version}`,
    id,
    scope: 'project',
    name: 'notes',
    artifact,
    createdAt: new Date().toISOString(),
    restoredAt: null,
    phase: 'quarantined',
    files: captured.files,
    bytes: captured.bytes,
    rootBinding: vault.rootBinding(root),
    ...(version === 2 ? selected : {}),
  };
  const manifestPath = join(directory, 'manifest.json');
  const save = (value = manifest) =>
    writeFile(manifestPath, JSON.stringify(value) + '\n', { mode: 0o600 });
  await save();
  return { root, id, manifest, manifestPath, selected, save };
}

test('v2 source manifests are exact and project normalized source identity in read-only evidence', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.manifestPath);
  const record = await vault.loadRecord(f.root, 'project', f.id);
  assert.deepEqual(vault.manifestSource(record.manifest), f.selected);
  const evidence = await vault.recordEvidence(record, Date.now() + 10_000);
  assert.deepEqual(evidence.artifact, f.manifest.artifact);
  assert.equal(evidence.status, 'quarantined');
  assert.deepEqual(await readFile(f.manifestPath), before);
});

test('legacy manifests and captured nested payloads remain unchanged while public evidence adds fixed Claude source identity', async (t) => {
  const f = await fixture(t, 1, true),
    before = await readFile(f.manifestPath);
  const record = await vault.loadRecord(f.root, 'project', f.id);
  assert.deepEqual(vault.manifestSource(record.manifest), f.selected);
  const evidence = await vault.recordEvidence(record, Date.now() + 10_000);
  assert.equal(evidence.artifact.skillSource, 'claude-skills');
  assert.deepEqual(evidence.artifact.location, { label: 'notes', redacted: false });
  assert.equal(evidence.files, 2);
  assert.equal(evidence.payload, 'match');
  assert.equal(evidence.restoreBlock, 'overlapping-skill');
  assert.deepEqual(await readFile(f.manifestPath), before);
  assert.deepEqual(record.manifest.artifact, f.manifest.artifact);
  const userHome = join(f.root.path, 'user');
  await mkdir(userHome);
  const ctx = await operations.context(f.root.path, userHome, Date.now() + 10_000);
  await assert.rejects(
    operations.preparePlan(
      ctx,
      { action: 'restore', recordId: f.id },
      randomUUID(),
      new Date().toISOString(),
    ),
    /quarantine-unsupported/,
  );
  assert.deepEqual(await readFile(f.manifestPath), before);
});

test('source, locator, legacy extension and canonical artifact tampering invalidate records', async (t) => {
  const f = await fixture(t),
    legacy = await fixture(t, 1);
  for (const value of [
    { ...f.manifest, skillSource: 'arbitrary-skills' },
    { ...f.manifest, locator: '../outside' },
    { ...f.manifest, locator: 'other/notes' },
    { ...f.manifest, name: 'another' },
    { ...f.manifest, artifact: { ...f.manifest.artifact, agent: 'claude-code' } },
    {
      ...f.manifest,
      artifact: { ...f.manifest.artifact, location: { label: '/private/path', redacted: false } },
    },
  ]) {
    await f.save(value);
    await assert.rejects(vault.loadRecord(f.root, 'project', f.id), /record-invalid/);
  }
  await legacy.save({ ...legacy.manifest, skillSource: 'claude-skills', locator: 'notes' });
  await assert.rejects(vault.loadRecord(legacy.root, 'project', legacy.id), /record-invalid/);
});

test('legacy managed payload remains readable with an explicit restore block and no metadata migration', async (t) => {
  const f = await fixture(t, 1, 'managed'),
    before = await readFile(f.manifestPath);
  const record = await vault.loadRecord(f.root, 'project', f.id);
  const evidence = await vault.recordEvidence(record, Date.now() + 10_000);
  assert.equal(evidence.payload, 'match');
  assert.equal(evidence.restoreBlock, 'managed-source');
  const userHome = join(f.root.path, 'user');
  await mkdir(userHome);
  const ctx = await operations.context(f.root.path, userHome, Date.now() + 10_000);
  await assert.rejects(
    operations.preparePlan(
      ctx,
      { action: 'restore', recordId: f.id },
      randomUUID(),
      new Date().toISOString(),
    ),
    /quarantine-unsupported/,
  );
  assert.deepEqual(await readFile(f.manifestPath), before);
});

test('new ancestor instructions make original source unverifiable rather than safely absent', async (t) => {
  const f = await fixture(t),
    parent = join(f.root.path, '.codex/skills/group');
  await mkdir(parent, { recursive: true });
  await writeFile(join(parent, 'SKILL.md'), '# A separate ancestor skill');
  const record = await vault.loadRecord(f.root, 'project', f.id);
  const evidence = await vault.recordEvidence(record, Date.now() + 10_000);
  assert.equal(evidence.original, 'unverifiable');
  assert.equal(evidence.status, 'unverifiable');
  assert.equal(evidence.payload, 'match');
});
