import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-discovery-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    operations: join(repository, 'console/scripts/skill-quarantine-operations.ts'),
    capture: join(repository, 'console/scripts/skill-quarantine-capture.ts'),
    schema: join(repository, 'console/lib/skill-quarantine.ts'),
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
    js: "import { createRequire as createQuarantineDiscoveryRequire } from 'node:module'; const require = createQuarantineDiscoveryRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const operations = await import(pathToFileURL(join(output, 'operations.mjs')).href);
const capture = await import(pathToFileURL(join(output, 'capture.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const clean = '# Release notes\nSummarize the changes and test results.';
const expires = () => new Date(Date.now() + 120_000).toISOString();

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-discovery-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    userHome = join(directory, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const root = (scope) => (scope === 'project' ? project : userHome);
  const skillRoot = (scope) => join(root(scope), '.claude/skills');
  async function skill(name, scope = 'project') {
    const path = join(skillRoot(scope), name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), clean);
    return path;
  }
  const context = (selectedProject = project) =>
    operations.context(selectedProject, userHome, Date.now() + 25_000);
  async function request(name, scope = 'project', selectedProject = project) {
    const ctx = await context(selectedProject);
    const selected = await capture.captureSkill(
      ctx.roots[scope],
      join(skillRoot(scope), name),
      ctx.deadline,
    );
    return {
      action: 'quarantine',
      id: capture.artifactId(scope, name),
      expectedSha256: selected.sha256,
    };
  }
  const prepare = async (input, selectedProject = project) =>
    operations.preparePlan(
      await context(selectedProject),
      input,
      randomUUID(),
      new Date().toISOString(),
    );
  const vault = (scope = 'project') => join(root(scope), '.claude/.stroq-quarantine');
  return { directory, project, userHome, skillRoot, skill, context, request, prepare, vault };
}

test('153 direct sibling skills support exact preview, quarantine, recheck and guarded restore', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 153; index++)
    await f.skill(`notes-${String(index).padStart(3, '0')}`);
  for (let index = 0; index < 20; index++)
    await writeFile(join(f.skillRoot('project'), `unrelated-${index}.txt`), 'Unrelated bytes');
  const source = join(f.skillRoot('project'), 'notes-152');
  const input = await f.request('notes-152');
  const plan = await f.prepare(input);
  const ctx = await f.context();
  const preview = operations.publicPreview(ctx, plan, randomUUID(), expires());
  assert.equal(schema.validateSkillQuarantinePreview(preview), true);
  assert.equal(preview.artifact.id, input.id);
  await access(source);
  await assert.rejects(access(f.vault()));
  const receipt = await operations.applyPlan(await f.context(), plan, preview.id);
  assert.equal(schema.validateSkillQuarantineReceipt(receipt), true);
  await assert.rejects(access(source));
  const state = await operations.readState(await f.context());
  assert.equal(schema.validateSkillQuarantine(state), true);
  assert.equal(state.records[0].status, 'quarantined');
  assert.equal(state.records[0].payload, 'match');
  const restorePlan = await f.prepare({ action: 'restore', recordId: receipt.recordId });
  const restored = await operations.applyPlan(await f.context(), restorePlan, randomUUID());
  assert.equal(restored.status, 'restored');
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), clean);
  assert.equal(
    await readFile(join(f.vault(), receipt.recordId, 'payload/SKILL.md'), 'utf8'),
    clean,
  );
  assert.equal(await readFile(join(f.skillRoot('project'), 'notes-000/SKILL.md'), 'utf8'), clean);
  assert.equal((await readdir(f.skillRoot('project'))).length, 173);
  assert.equal((await operations.readState(await f.context())).records[0].status, 'restored');
});

test('unknown and foreign source opaque IDs cannot select a direct Claude path', async (t) => {
  const f = await fixture(t);
  const source = await f.skill('notes');
  const foreign =
    'item-' +
    createHash('sha256')
      .update('skill\0source\0agents-skills\0project\0notes')
      .digest('hex')
      .slice(0, 24);
  for (const id of ['item-' + '0'.repeat(24), '../notes', foreign])
    await assert.rejects(
      f.prepare({ action: 'quarantine', id, expectedSha256: 'a'.repeat(64) }),
      /quarantine-conflict/,
    );
  await access(source);
  await assert.rejects(access(f.vault()));
});

test('linked selections and unsafe discovery parents are refused without moving outside bytes', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), 'PRIVATE_OUTSIDE_SENTINEL');
  await mkdir(f.skillRoot('project'), { recursive: true });
  await symlink(outside, join(f.skillRoot('project'), 'linked'));
  await assert.rejects(
    f.prepare({
      action: 'quarantine',
      id: capture.artifactId('project', 'linked'),
      expectedSha256: 'a'.repeat(64),
    }),
    /quarantine-conflict/,
  );
  await rm(join(f.project, '.claude'), { recursive: true });
  await symlink(outside, join(f.project, '.claude'));
  await assert.rejects(
    f.prepare({
      action: 'quarantine',
      id: capture.artifactId('project', 'notes'),
      expectedSha256: 'a'.repeat(64),
    }),
    /quarantine-unavailable/,
  );
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'PRIVATE_OUTSIDE_SENTINEL');
  await assert.rejects(access(join(outside, '.stroq-quarantine')));
});

test('all directory entries count toward the explicit bound and an over-limit match is refused', async (t) => {
  const f = await fixture(t);
  const source = await f.skill('notes');
  const input = await f.request('notes');
  for (let first = 0; first < 4095; first += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, 4095 - first) }, (_, offset) =>
        writeFile(
          join(f.skillRoot('project'), `unrelated-${first + offset}.txt`),
          'Unrelated bytes',
        ),
      ),
    );
  const selected = await capture.findSource(
    (await f.context()).roots,
    input.id,
    Date.now() + 25_000,
  );
  assert.equal(selected.path, source);
  await writeFile(join(f.skillRoot('project'), 'one-over-the-bound.txt'), 'Unrelated bytes');
  await assert.rejects(f.prepare(input), /quarantine-unsupported/);
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(f.vault()));
});

test('expired lookup refuses even an absent directory without creating a vault', async (t) => {
  const f = await fixture(t);
  const ctx = await f.context();
  await assert.rejects(
    capture.findSource(ctx.roots, capture.artifactId('project', 'notes'), Date.now() - 1),
    /deadline-exceeded/,
  );
  await assert.rejects(access(f.vault()));
});

test('synced names and home-as-workspace project IDs remain unsupported', async (t) => {
  const f = await fixture(t);
  await f.skill('Synced');
  await assert.rejects(f.prepare(await f.request('Synced')), /quarantine-unsupported/);
  for (let index = 0; index < 40; index++) await f.skill(`notes-${index}`, 'user');
  const ctx = await f.context(f.userHome),
    input = await f.request('notes-39', 'user', f.userHome);
  assert.equal((await capture.findSource(ctx.roots, input.id, ctx.deadline)).scope, 'user');
  await assert.rejects(
    capture.findSource(ctx.roots, capture.artifactId('project', 'notes-39'), ctx.deadline),
    /quarantine-conflict/,
  );
  await access(join(f.skillRoot('user'), 'notes-39'));
  await assert.rejects(access(f.vault('user')));
});

test('replacing a selected folder after preview still refuses apply before a move', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 40; index++) await f.skill(`notes-${index}`);
  const input = await f.request('notes-39'),
    plan = await f.prepare(input);
  const source = join(f.skillRoot('project'), 'notes-39');
  await rename(source, join(f.directory, 'retained-original'));
  await f.skill('notes-39');
  await assert.rejects(
    operations.applyPlan(await f.context(), plan, randomUUID()),
    /quarantine-preview-stale/,
  );
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(f.vault()));
});
