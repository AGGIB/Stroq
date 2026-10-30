import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-sources-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    operations: join(repository, 'console/scripts/skill-quarantine-operations.ts'),
    capture: join(repository, 'console/scripts/skill-quarantine-capture.ts'),
    sources: join(repository, 'console/scripts/skill-sources.ts'),
    vault: join(repository, 'console/scripts/skill-quarantine-vault.ts'),
    eligibility: join(repository, 'console/scripts/skill-quarantine-source.ts'),
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
    js: "import { createRequire as createSourcesRequire } from 'node:module'; const require = createSourcesRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const load = (name) => import(pathToFileURL(join(output, `${name}.mjs`)).href);
const operations = await load('operations'),
  capture = await load('capture');
const sources = await load('sources'),
  vault = await load('vault');
const eligibility = await load('eligibility');
const clean = '# Release notes\nSummarize the changes and test results.';
const families = [
  ['claude-skills', '.claude/skills', '.claude/skills', 'claude-code'],
  ['agents-skills', '.agents/skills', '.agents/skills', 'shared'],
  ['codex-skills', '.codex/skills', '.codex/skills', 'codex'],
  ['cursor-skills', '.cursor/skills', '.cursor/skills', 'cursor'],
  ['windsurf-skills', '.windsurf/skills', '.codeium/windsurf/skills', 'windsurf'],
  ['devin-skills', '.devin/skills', '.config/devin/skills', 'windsurf'],
];
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-quarantine-sources-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    userHome = join(directory, 'user');
  await mkdir(project);
  await mkdir(userHome);
  const ctx = () => operations.context(project, userHome, Date.now() + 25_000);
  const base = (family, scope) =>
    join(scope === 'project' ? project : userHome, family[scope === 'project' ? 1 : 2]);
  async function skill(family = families[0], scope = 'project', locator = 'group/notes') {
    const folder = join(base(family, scope), locator);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), clean);
    await mkdir(join(folder, 'empty'));
    await writeFile(join(folder, 'reference.md'), 'Reference text');
    return folder;
  }
  async function request(family, scope, locator) {
    const context = await ctx();
    const selected = await capture.captureSkill(
      context.roots[scope],
      join(base(family, scope), locator),
      context.deadline,
    );
    return {
      action: 'quarantine',
      id: sources.skillArtifactId(family[0], scope, locator),
      expectedSha256: selected.sha256,
    };
  }
  const prepare = async (input) =>
    operations.preparePlan(await ctx(), input, randomUUID(), new Date().toISOString());
  const apply = async (plan) => operations.applyPlan(await ctx(), plan, randomUUID());
  return { directory, project, userHome, ctx, base, skill, request, prepare, apply };
}

test('all six fixed source families in both scopes support exact nested quarantine, recheck and restore', async (t) => {
  const f = await fixture(t);
  for (const family of families)
    for (const scope of ['project', 'user']) await f.skill(family, scope);
  for (const family of families)
    for (const scope of ['project', 'user']) {
      const input = await f.request(family, scope, 'group/notes');
      const plan = await f.prepare(input);
      assert.equal(plan.artifact.id, input.id);
      assert.equal(plan.artifact.skillSource, family[0]);
      assert.equal(plan.artifact.agent, family[3]);
      assert.deepEqual(plan.artifact.location, { label: 'group/notes', redacted: false });
      const receipt = await f.apply(plan);
      const original = join(f.base(family, scope), 'group/notes');
      await assert.rejects(access(original));
      const state = await operations.readState(await f.ctx());
      assert.equal(
        state.records.find((record) => record.id === receipt.recordId).status,
        'quarantined',
      );
      const privateRecord = join(
        scope === 'project' ? f.project : f.userHome,
        '.claude/.stroq-quarantine',
        receipt.recordId,
        'manifest.json',
      );
      const manifest = JSON.parse(await readFile(privateRecord, 'utf8'));
      assert.equal(manifest.schema, 'stroq-skill-quarantine-record/2');
      assert.equal(manifest.skillSource, family[0]);
      assert.equal(manifest.locator, 'group/notes');
      const restore = await f.prepare({ action: 'restore', recordId: receipt.recordId });
      const restored = await f.apply(restore);
      assert.equal(restored.status, 'restored');
      assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), clean);
      await access(join(original, 'empty'));
      for (const other of families)
        for (const otherScope of ['project', 'user'])
          assert.equal(
            await readFile(join(f.base(other, otherScope), 'group/notes/SKILL.md'), 'utf8'),
            clean,
          );
    }
});

test('overlapping skills and discovery-root skills cannot move another inventory artifact', async (t) => {
  const f = await fixture(t),
    family = families[3];
  const child = await f.skill(family);
  await writeFile(join(f.base(family, 'project'), 'group/SKILL.md'), clean);
  for (const locator of ['group', 'group/notes'])
    await assert.rejects(
      f.prepare({
        action: 'quarantine',
        id: sources.skillArtifactId(family[0], 'project', locator),
        expectedSha256: 'a'.repeat(64),
      }),
      /quarantine-unsupported/,
    );
  await writeFile(join(f.base(family, 'project'), 'SKILL.md'), clean);
  await assert.rejects(
    f.prepare({
      action: 'quarantine',
      id: sources.skillArtifactId(family[0], 'project', ''),
      expectedSha256: 'a'.repeat(64),
    }),
    /quarantine-unsupported/,
  );
  assert.equal(await readFile(join(child, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(join(f.project, '.claude/.stroq-quarantine')));
});

test('source container incarnation and new ancestor instructions invalidate an outstanding move', async (t) => {
  const f = await fixture(t),
    family = families[2];
  const child = await f.skill(family),
    input = await f.request(family, 'project', 'group/notes');
  const plan = await f.prepare(input),
    group = dirname(child),
    saved = join(f.directory, 'saved-group');
  await rename(group, saved);
  await mkdir(group);
  await rename(join(saved, 'notes'), child);
  await assert.rejects(f.apply(plan), /quarantine-preview-stale/);
  const next = await f.prepare(input);
  await writeFile(join(group, 'SKILL.md'), clean);
  await assert.rejects(f.apply(next), /quarantine-preview-stale/);
  assert.equal(await readFile(join(child, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(join(f.project, '.claude/.stroq-quarantine')));
});

test('restore recreates only fixed source parents and refuses an active skill ancestor', async (t) => {
  const f = await fixture(t),
    family = families[5];
  await f.skill(family, 'user');
  const removed = await f.apply(await f.prepare(await f.request(family, 'user', 'group/notes')));
  await rm(join(f.base(family, 'user'), 'group'), { recursive: true });
  const plan = await f.prepare({ action: 'restore', recordId: removed.recordId });
  await f.apply(plan);
  assert.equal(await readFile(join(f.base(family, 'user'), 'group/notes/SKILL.md'), 'utf8'), clean);
  const second = await f.apply(await f.prepare(await f.request(family, 'user', 'group/notes')));
  const next = await f.prepare({ action: 'restore', recordId: second.recordId });
  await writeFile(join(f.base(family, 'user'), 'group/SKILL.md'), clean);
  await assert.rejects(
    f.apply(next),
    /quarantine-preview-stale|quarantine-conflict|quarantine-recovery-required/,
  );
  await assert.rejects(access(join(f.base(family, 'user'), 'group/notes')));
});

test('legacy v1 direct Claude records remain readable without migration and retain v1 on restore', async (t) => {
  const f = await fixture(t),
    folder = await f.skill(families[0], 'project', 'notes');
  const context = await f.ctx(),
    captured = await capture.captureSkill(context.roots.project, folder, context.deadline);
  const recordId = randomUUID(),
    directory = join(f.project, '.claude/.stroq-quarantine', recordId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(dirname(directory), '.gitignore'), '*\n', { mode: 0o600 });
  const legacy = {
    schema: 'stroq-skill-quarantine-record/1',
    id: recordId,
    scope: 'project',
    name: 'notes',
    artifact: {
      id: capture.artifactId('project', 'notes'),
      name: 'notes',
      agent: 'claude-code',
      scope: 'project',
      sha256: captured.sha256,
    },
    createdAt: new Date().toISOString(),
    restoredAt: null,
    phase: 'quarantined',
    files: captured.files,
    bytes: captured.bytes,
    rootBinding: vault.rootBinding(context.roots.project),
  };
  const bytes = JSON.stringify(legacy) + '\n';
  await writeFile(join(directory, 'manifest.json'), bytes, { mode: 0o600 });
  await rename(folder, join(directory, 'payload'));
  const state = await operations.readState(await f.ctx());
  assert.equal(state.records[0].artifact.skillSource, 'claude-skills');
  assert.deepEqual(state.records[0].artifact.location, { label: 'notes', redacted: false });
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), bytes);
  const restored = await f.apply(await f.prepare({ action: 'restore', recordId }));
  assert.equal(restored.status, 'restored');
  const after = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(after.schema, legacy.schema);
  assert.equal(Object.hasOwn(after, 'skillSource'), false);
  assert.deepEqual(after.artifact, legacy.artifact);
});

test('advisory eligibility names each structural refusal without recapturing a tree', async (t) => {
  const f = await fixture(t),
    family = families[1];
  await f.skill(family);
  const root = f.base(family, 'project'),
    deadline = Date.now() + 25_000;
  const allowed = [
    { path: 'SKILL.md', kind: 'file' },
    { path: 'reference.md', kind: 'file' },
  ];
  assert.equal(
    await eligibility.quarantineEligibility(root, 'group/notes', allowed, deadline),
    'supported',
  );
  assert.equal(await eligibility.quarantineEligibility(root, '', allowed, deadline), 'source-root');
  assert.equal(
    await eligibility.quarantineEligibility(root, '../notes', allowed, deadline),
    'unsafe-location',
  );
  assert.equal(
    await eligibility.quarantineEligibility(root, 'Synced/notes', allowed, deadline),
    'managed-source',
  );
  assert.equal(
    await eligibility.quarantineEligibility(root, '.system/notes', allowed, deadline),
    'managed-source',
  );
  assert.equal(
    await eligibility.quarantineEligibility(
      root,
      'group/notes',
      [...allowed, { path: 'nested/SKILL.md' }],
      deadline,
    ),
    'overlapping-skill',
  );
  assert.equal(
    await eligibility.quarantineEligibility(
      root,
      'group/notes',
      [...allowed, { path: 'nested/skill.md' }],
      deadline,
    ),
    'overlapping-skill',
  );
  await writeFile(join(root, 'group/plugin.json'), '{}');
  assert.equal(
    await eligibility.quarantineEligibility(root, 'group/notes', allowed, deadline),
    'managed-source',
  );
  await rm(join(root, 'group/plugin.json'));
  await writeFile(join(root, 'SKILL.md'), clean);
  assert.equal(
    await eligibility.quarantineEligibility(root, 'group/notes', allowed, deadline),
    'overlapping-skill',
  );
});

test('same bytes restored after outside edits do not reactivate an old move or restore plan', async (t) => {
  const f = await fixture(t),
    family = families[3],
    folder = await f.skill(family);
  const input = await f.request(family, 'project', 'group/notes'),
    old = await f.prepare(input);
  await writeFile(join(folder, 'SKILL.md'), 'Changed content');
  await writeFile(join(folder, 'SKILL.md'), clean);
  await assert.rejects(f.apply(old), /quarantine-preview-stale/);
  await assert.rejects(access(join(f.project, '.claude/.stroq-quarantine')));
  const removed = await f.apply(await f.prepare(input));
  const restore = await f.prepare({ action: 'restore', recordId: removed.recordId });
  const payload = join(
    f.project,
    '.claude/.stroq-quarantine',
    removed.recordId,
    'payload/SKILL.md',
  );
  await writeFile(payload, 'Changed retained content');
  await writeFile(payload, clean);
  await assert.rejects(f.apply(restore), /quarantine-preview-stale/);
  await assert.rejects(access(folder));
});

test('same leaf names stay bound to exact source containers and private locator text is withheld', async (t) => {
  const f = await fixture(t),
    family = families[2];
  const left = await f.skill(family, 'project', 'alpha/notes');
  const right = await f.skill(family, 'project', 'ACME_API_TOKEN/notes');
  const selected = await f.prepare(await f.request(family, 'project', 'ACME_API_TOKEN/notes'));
  const other = await f.prepare(await f.request(family, 'project', 'alpha/notes'));
  assert.notEqual(selected.artifact.id, other.artifact.id);
  assert.equal(selected.artifact.location.redacted, true);
  const preview = operations.publicPreview(
    await f.ctx(),
    selected,
    randomUUID(),
    new Date(Date.now() + 120_000).toISOString(),
  );
  assert.equal(JSON.stringify(preview).includes('ACME_API_TOKEN'), false);
  const receipt = await f.apply(selected);
  assert.equal(JSON.stringify(receipt).includes('ACME_API_TOKEN'), false);
  assert.equal(
    JSON.stringify(await operations.readState(await f.ctx())).includes('ACME_API_TOKEN'),
    false,
  );
  assert.equal(await readFile(join(left, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(right));
  await f.apply(await f.prepare({ action: 'restore', recordId: receipt.recordId }));
  assert.equal(await readFile(join(right, 'SKILL.md'), 'utf8'), clean);
});

test('linked or managed nested parents and a replaced workspace cannot move outside captured scope', async (t) => {
  const f = await fixture(t),
    family = families[4],
    folder = await f.skill(family);
  const input = await f.request(family, 'project', 'group/notes');
  await writeFile(join(dirname(folder), 'plugin.json'), '{}');
  await assert.rejects(f.prepare(input), /quarantine-unsupported/);
  await rm(join(dirname(folder), 'plugin.json'));
  const plan = await f.prepare(input);
  const outside = join(f.directory, 'outside');
  await rename(dirname(folder), outside);
  await symlink(outside, dirname(folder));
  await assert.rejects(f.apply(plan), /quarantine-preview-stale/);
  assert.equal(await readFile(join(outside, 'notes/SKILL.md'), 'utf8'), clean);
  await rm(dirname(folder));
  await rename(outside, dirname(folder));
  const latest = await f.prepare(input),
    retained = join(f.directory, 'retained-workspace');
  await rename(f.project, retained);
  await mkdir(f.project);
  await assert.rejects(f.apply(latest), /quarantine-preview-stale/);
  assert.equal(await readFile(join(retained, family[1], 'group/notes/SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(join(f.project, '.claude/.stroq-quarantine')));
});

test('bundled Codex .system skills remain inspectable and cannot create a quarantine plan or vault', async (t) => {
  const f = await fixture(t),
    family = families[2],
    folder = await f.skill(family, 'user', '.system/notes');
  const input = await f.request(family, 'user', '.system/notes');
  await assert.rejects(f.prepare(input), /quarantine-unsupported/);
  assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), clean);
  await assert.rejects(access(join(f.userHome, '.claude/.stroq-quarantine')));
});

test('an unrelated linked Claude discovery root cannot disable a safe Cursor skill control', async (t) => {
  const f = await fixture(t),
    family = families[3],
    folder = await f.skill(family);
  const input = await f.request(family, 'project', 'group/notes');
  const outside = join(f.directory, 'outside-claude');
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), 'UNRELATED_OUTSIDE_BYTES');
  await mkdir(join(f.project, '.claude'));
  await symlink(outside, join(f.project, '.claude/skills'));
  const removed = await f.apply(await f.prepare(input));
  await assert.rejects(access(folder));
  await f.apply(await f.prepare({ action: 'restore', recordId: removed.recordId }));
  assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), clean);
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'UNRELATED_OUTSIDE_BYTES');
});
