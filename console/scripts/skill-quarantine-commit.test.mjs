import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-commit-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    operations: join(repository, 'console/scripts/skill-quarantine-operations.ts'),
    capture: join(repository, 'console/scripts/skill-quarantine-capture.ts'),
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
    js: "import { createRequire as createCommitRequire } from 'node:module'; const require = createCommitRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const load = (name) => import(pathToFileURL(join(output, `${name}.mjs`)).href);
const operations = await load('operations'),
  capture = await load('capture');
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const clean = '# Notes\nSummarize release notes.';
const refuse = () => {
  throw new Error('quarantine-preview-stale');
};
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-commit-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    userHome = join(directory, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const source = join(project, '.codex/skills/group/notes');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), clean);
  await writeFile(join(source, 'reference.md'), 'Reference bytes');
  const ctx = () => operations.context(project, userHome, Date.now() + 25_000);
  const selected = await capture.captureSkill(
    (await ctx()).roots.project,
    source,
    Date.now() + 25_000,
  );
  const itemId = `item-${createHash('sha256').update('skill\0source\0codex-skills\0project\0group/notes').digest('hex').slice(0, 24)}`;
  const prepare = async (input) =>
    operations.preparePlan(await ctx(), input, randomUUID(), new Date().toISOString());
  const plan = await prepare({ action: 'quarantine', id: itemId, expectedSha256: selected.sha256 });
  const apply = async (selectedPlan = plan, commitGuard) =>
    operations.applyPlan({ ...(await ctx()), commitGuard }, selectedPlan, randomUUID());
  const record = join(project, '.claude/.stroq-quarantine', plan.recordId);
  const manifest = () => readFile(join(record, 'manifest.json'), 'utf8').then(JSON.parse);
  return { project, source, plan, prepare, apply, record, manifest };
}

test('a final guard refusal before intent creates no vault and keeps source bytes intact', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.apply(f.plan, refuse), /quarantine-preview-stale/);
  assert.equal(await exists(join(f.project, '.claude/.stroq-quarantine')), false);
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), clean);
});

test('runtime or expiry refusal after intent prevents folder move and reports recovery state', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.apply(f.plan, async () => {
      if (await exists(join(f.record, 'manifest.json'))) refuse();
    }),
    /quarantine-recovery-required/,
  );
  assert.equal((await f.manifest()).phase, 'prepared');
  assert.equal(await exists(join(f.record, 'payload')), false);
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), clean);
});

test('a refusal after move never publishes a successful final quarantine phase', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.apply(f.plan, async () => {
      if (await exists(join(f.record, 'payload'))) refuse();
    }),
    /quarantine-recovery-required/,
  );
  assert.equal((await f.manifest()).phase, 'prepared');
  assert.equal(await exists(f.source), false);
  assert.equal(await readFile(join(f.record, 'payload/SKILL.md'), 'utf8'), clean);
});

test('restore guard refusal before intent preserves the quarantined manifest and retained bytes', async (t) => {
  const f = await fixture(t);
  await f.apply();
  const plan = await f.prepare({ action: 'restore', recordId: f.plan.recordId });
  const before = await readFile(join(f.record, 'manifest.json'));
  await assert.rejects(f.apply(plan, refuse), /quarantine-preview-stale/);
  assert.deepEqual(await readFile(join(f.record, 'manifest.json')), before);
  assert.equal(await exists(f.source), false);
});

test('restore rechecks before publishing every file and never exposes SKILL.md after refusal', async (t) => {
  const f = await fixture(t);
  await f.apply();
  const plan = await f.prepare({ action: 'restore', recordId: f.plan.recordId });
  await assert.rejects(
    f.apply(plan, async () => {
      if (await exists(join(f.source, 'reference.md'))) refuse();
    }),
    /quarantine-recovery-required/,
  );
  assert.equal(await exists(join(f.source, 'SKILL.md')), false);
  assert.equal(await readFile(join(f.source, 'reference.md'), 'utf8'), 'Reference bytes');
  assert.equal((await f.manifest()).phase, 'restoring');
  assert.equal(await readFile(join(f.record, 'payload/SKILL.md'), 'utf8'), clean);
});

test('restore rechecks once more before declaring the restored phase', async (t) => {
  const f = await fixture(t);
  await f.apply();
  const plan = await f.prepare({ action: 'restore', recordId: f.plan.recordId });
  await assert.rejects(
    f.apply(plan, async () => {
      if (await exists(join(f.source, 'SKILL.md'))) refuse();
    }),
    /quarantine-recovery-required/,
  );
  assert.equal((await f.manifest()).phase, 'restoring');
  assert.equal(await readFile(join(f.source, 'SKILL.md'), 'utf8'), clean);
  assert.equal(await readFile(join(f.record, 'payload/SKILL.md'), 'utf8'), clean);
});

test('restore checks again after staging complete SKILL bytes and before its exclusive publication', async (t) => {
  const f = await fixture(t);
  await f.apply();
  const plan = await f.prepare({ action: 'restore', recordId: f.plan.recordId });
  await assert.rejects(
    f.apply(plan, async () => {
      if ((await readdir(f.record)).some((name) => name.startsWith('.restore-'))) refuse();
    }),
    /quarantine-recovery-required/,
  );
  assert.equal(await exists(join(f.source, 'SKILL.md')), false);
  assert.equal((await f.manifest()).phase, 'restoring');
  assert.equal(await readFile(join(f.record, 'payload/SKILL.md'), 'utf8'), clean);
});
