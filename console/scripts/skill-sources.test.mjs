import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-skill-sources-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    sources: join(repository, 'console/scripts/skill-sources.ts'),
    worker: join(repository, 'console/scripts/inventory-worker.ts'),
    schema: join(repository, 'console/lib/inventory.ts'),
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
    js: "import { createRequire as createSkillRequire } from 'node:module'; const require = createSkillRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const sources = await import(pathToFileURL(join(output, 'sources.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = '# Release notes\nSummarize the changes and test results.';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-skill-sources-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    userHome = join(directory, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project);
  await mkdir(userHome);
  async function skill(root, relative, text = clean) {
    const folder = join(root, relative);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), text);
    return folder;
  }
  async function run(operation, input = {}) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: { project, userHome, home, operation, deadline: Date.now() + 25_000, ...input },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return new Promise((resolveRun, reject) => {
      worker.once('message', async (value) => {
        await worker.terminate();
        resolveRun(value);
      });
      worker.once('error', reject);
    });
  }
  const discover = (options = {}) =>
    sources.discoverSkillArtifacts({
      project,
      userHome,
      deadline: Date.now() + 25_000,
      ...options,
    });
  return { directory, project, userHome, home, skill, run, discover };
}

test('fixed skill roots keep separate source identities and discover recursive SKILL files', async (t) => {
  const f = await fixture(t);
  const roots = [
    ['claude-skills', '.claude/skills'],
    ['agents-skills', '.agents/skills'],
    ['codex-skills', '.codex/skills'],
    ['cursor-skills', '.cursor/skills'],
    ['windsurf-skills', '.windsurf/skills'],
    ['devin-skills', '.devin/skills'],
  ];
  for (const [, root] of roots) await f.skill(f.project, `${root}/notes`);
  await f.skill(f.userHome, '.codeium/windsurf/skills/notes');
  await f.skill(f.userHome, '.config/devin/skills/notes');
  await f.skill(f.project, '.cursor/skills/group/nested');
  await f.skill(f.project, 'unrelated/skills/hidden');
  const result = await f.discover();
  assert.equal(result.artifacts.length, 9);
  assert.equal(new Set(result.artifacts.map((item) => item.id)).size, 9);
  for (const [id] of roots) assert.ok(result.artifacts.some((item) => item.skillSource === id));
  assert.equal(
    result.artifacts.find((item) => item.skillSource === 'claude-skills').id,
    `item-${hash('skill\0claude-code\0project\0notes').slice(0, 24)}`,
  );
  assert.equal(
    result.artifacts.find((item) => item.skillSource === 'agents-skills').agent,
    'shared',
  );
  assert.equal(result.sources.length, 12);
  assert.ok(result.sources.every((source) => ['complete', 'absent'].includes(source.status)));
  assert.equal(result.gaps.length, 0);
  const state = await f.run('read');
  assert.equal(
    state.items.find((item) => item.skillSource === 'claude-skills').quarantineSupported,
    true,
  );
  assert.ok(
    state.items
      .filter((item) => item.skillSource !== 'claude-skills')
      .every((item) => item.quarantineSupported === true && item.quarantineReason === 'supported'),
  );
  await f.skill(f.project, '.claude/skills/group/nested');
  const nested = (await f.run('read')).items.find(
    (item) => item.agent === 'claude-code' && item.name === 'nested',
  );
  assert.ok(nested?.sha256);
  assert.equal(nested.quarantineSupported, true);
  assert.equal(nested.quarantineReason, 'supported');
  assert.deepEqual(nested.location, { label: 'group/nested', redacted: false });
});

test('catalog explains source roots, overlapping skills and managed folders without enabling a move', async (t) => {
  const f = await fixture(t);
  await f.skill(f.project, '.cursor/skills');
  await f.skill(f.project, '.agents/skills/group');
  await f.skill(f.project, '.agents/skills/group/nested');
  await f.skill(f.project, '.codex/skills/.system/notes');
  const state = await f.run('read');
  assert.equal(schema.validateInventory(state), true, JSON.stringify(state));
  const selected = (source, label) =>
    state.items.find((item) => item.skillSource === source && item.location?.label === label);
  for (const [source, label, reason] of [
    ['cursor-skills', '.', 'source-root'],
    ['agents-skills', 'group', 'overlapping-skill'],
    ['agents-skills', 'group/nested', 'overlapping-skill'],
    ['codex-skills', 'Folder name withheld', 'managed-source'],
  ]) {
    const item = selected(source, label);
    assert.ok(item?.sha256, `${source}:${label}`);
    assert.equal(item.quarantineSupported, false);
    assert.equal(item.quarantineReason, reason);
    if (reason === 'managed-source') assert.equal(item.location.redacted, true);
  }
});

test('153 small skills remain usable within the global candidate bound', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 153; index++)
    await f.skill(f.userHome, `.claude/skills/notes-${index}`);
  const discovered = await f.discover();
  assert.equal(discovered.artifacts.length, 153);
  assert.deepEqual(
    discovered.sources.find((source) => source.id === 'claude-skills' && source.scope === 'user'),
    { id: 'claude-skills', scope: 'user', status: 'complete', candidates: 153 },
  );
  const state = await f.run('read');
  assert.equal(state.error, undefined);
  assert.equal(schema.validateInventory(state), true);
  assert.equal(state.items.filter((item) => item.kind === 'skill').length, 153);
  assert.ok(state.items.every((item) => item.sha256 !== null));
  await assert.rejects(access(f.home));
});

test('symlinked directories and hardlinked instruction files remain explicit partial coverage', async (t) => {
  const f = await fixture(t);
  const outside = await f.skill(f.directory, 'outside', 'PRIVATE_SOURCE_SENTINEL');
  const root = join(f.project, '.agents/skills');
  await mkdir(root, { recursive: true });
  await symlink(outside, join(root, 'linked'));
  const hard = join(root, 'hard');
  await mkdir(hard);
  await link(join(outside, 'SKILL.md'), join(hard, 'SKILL.md'));
  const result = await f.discover();
  assert.equal(
    result.sources.find((source) => source.id === 'agents-skills' && source.scope === 'project')
      .status,
    'partial',
  );
  assert.ok(
    result.gaps.some((gap) => gap.skillSource === 'agents-skills' && gap.code === 'path-refused'),
  );
  const state = await f.run('read');
  assert.equal(schema.validateInventory(state), true);
  assert.ok(!JSON.stringify(state).includes('PRIVATE_SOURCE_SENTINEL'));
  assert.ok(!JSON.stringify(state).includes(f.directory));
});

test('new sources inspect, review and compare exact captured trees without exposing source paths', async (t) => {
  const f = await fixture(t);
  const folder = await f.skill(f.project, '.codex/skills/notes');
  let state = await f.run('read');
  const item = state.items.find((row) => row.skillSource === 'codex-skills');
  assert.ok(item?.sha256);
  const evidence = await f.run('inspect', { id: item.id, expectedSha256: item.sha256 });
  assert.equal(schema.validateInventoryEvidence(evidence), true, JSON.stringify(evidence));
  assert.equal(evidence.artifact.skillSource, 'codex-skills');
  await mkdir(join(f.home, 'console'), { recursive: true, mode: 0o700 });
  state = await f.run('review', {
    itemId: item.id,
    sha256: item.sha256,
    expectedReviewedSha256: null,
    reviewLockHeld: true,
  });
  assert.equal(state.error, undefined, JSON.stringify(state));
  assert.equal(state.items.find((row) => row.id === item.id).state, 'unchanged');
  const baseline = join(f.home, 'console', `inventory-${state.workspace.id}.json`);
  const saved = await readFile(baseline, 'utf8');
  assert.equal(JSON.parse(saved).schema, 'stroq-inventory-baseline/3');
  assert.ok(!saved.includes(f.directory));
  await writeFile(join(folder, 'SKILL.md'), '# Changed release notes\nSummarize the next release.');
  const changed = (await f.run('read')).items.find((row) => row.id === item.id);
  const comparison = await f.run('compare', {
    id: changed.id,
    expectedSha256: changed.sha256,
    expectedReviewedSha256: item.sha256,
  });
  assert.equal(schema.validateInventoryComparison(comparison), true, JSON.stringify(comparison));
  assert.equal(comparison.changes.files.rows[0].state, 'modified');
  assert.equal(await readFile(baseline, 'utf8'), saved);
  assert.ok(!JSON.stringify(comparison).includes(f.directory));
});

test('partial discovery never turns a reviewed unseen source into missing', async (t) => {
  const f = await fixture(t);
  const folder = await f.skill(f.project, '.cursor/skills/notes');
  const state = await f.run('read'),
    item = state.items.find((row) => row.skillSource === 'cursor-skills');
  await mkdir(join(f.home, 'console'), { recursive: true, mode: 0o700 });
  const reviewed = await f.run('review', {
    itemId: item.id,
    sha256: item.sha256,
    expectedReviewedSha256: null,
    reviewLockHeld: true,
  });
  assert.equal(reviewed.error, undefined);
  await rm(folder, { recursive: true });
  await rm(join(f.project, '.cursor/skills'), { recursive: true });
  await symlink(join(f.directory, 'nonexistent'), join(f.project, '.cursor/skills'));
  const fresh = await f.run('read');
  assert.equal(fresh.items.find((row) => row.id === item.id).state, 'unverifiable');
  assert.equal(
    fresh.skillSources.find((source) => source.id === 'cursor-skills' && source.scope === 'project')
      .status,
    'partial',
  );
});

test('expired and candidate-limited discovery records coverage for every selected source', async (t) => {
  const f = await fixture(t);
  const expired = await f.discover({ deadline: Date.now() - 1 });
  assert.equal(expired.sources.length, 12);
  assert.ok(expired.sources.every((source) => source.status === 'partial'));
  for (let index = 0; index < 257; index++)
    await f.skill(f.project, `.agents/skills/notes-${index}`);
  const bounded = await f.discover();
  assert.equal(bounded.artifacts.length, 256);
  assert.equal(
    bounded.sources.find((source) => source.id === 'agents-skills' && source.scope === 'project')
      .status,
    'partial',
  );
  assert.ok(bounded.gaps.some((gap) => gap.code === 'limit'));
});

test('home opened as workspace keeps only user source identities', async (t) => {
  const f = await fixture(t);
  await f.skill(f.userHome, '.agents/skills/notes');
  const result = await f.discover({ project: f.userHome });
  assert.equal(result.sources.length, 6);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].scope, 'user');
});

test('legacy home-as-workspace project identity stays unverified without adopting the user revision', async (t) => {
  const f = await fixture(t);
  await f.skill(f.userHome, '.claude/skills/notes');
  const state = await f.run('read', { project: f.userHome });
  const current = state.items.find((item) => item.kind === 'skill');
  const id = `item-${hash('skill\0claude-code\0project\0notes').slice(0, 24)}`;
  const file = join(f.home, 'console', `inventory-${state.workspace.id}.json`);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    JSON.stringify({
      schema: 'stroq-inventory-baseline/1',
      workspace: state.workspace.id,
      reviewedAt: new Date().toISOString(),
      entries: [
        {
          id,
          kind: 'skill',
          name: 'notes',
          agent: 'claude-code',
          scope: 'project',
          fileType: 'skill-tree',
          sha256: current.sha256,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const retained = await readFile(file, 'utf8');
  const fresh = await f.run('read', { project: f.userHome });
  assert.equal(fresh.items.find((item) => item.id === current.id).state, 'unreviewed');
  assert.equal(fresh.items.find((item) => item.id === id).state, 'unverifiable');
  assert.equal(await readFile(file, 'utf8'), retained);
});

test('aggregate captured bytes stay bounded and skipped skills remain explicit incomplete rows', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 9; index++) {
    const folder = await f.skill(f.project, `.agents/skills/notes-${index}`);
    await writeFile(join(folder, 'first.txt'), 'a\n'.repeat(100_000));
    await writeFile(join(folder, 'second.txt'), 'b\n'.repeat(100_000));
    await writeFile(join(folder, 'third.txt'), 'c\n'.repeat(60_000));
  }
  const state = await f.run('read');
  assert.equal(schema.validateInventory(state), true);
  assert.equal(state.items.length, 9);
  assert.ok(state.items.some((item) => item.sha256 === null && item.state === 'unverifiable'));
  assert.ok(state.gaps.some((gap) => gap.code === 'limit' && gap.skillSource === 'agents-skills'));
  assert.equal(
    state.skillSources.find((source) => source.id === 'agents-skills' && source.scope === 'project')
      .status,
    'partial',
  );
});

test('retained baseline output truncation is an explicit coverage limit', async (t) => {
  const f = await fixture(t);
  await f.skill(f.project, '.agents/skills/notes');
  const state = await f.run('read');
  const file = join(f.home, 'console', `inventory-${state.workspace.id}.json`);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    JSON.stringify({
      schema: 'stroq-inventory-baseline/1',
      workspace: state.workspace.id,
      reviewedAt: new Date().toISOString(),
      entries: Array.from({ length: 512 }, (_, index) => ({
        id: `item-${hash(String(index)).slice(0, 24)}`,
        kind: 'skill',
        name: `old-${index}`,
        agent: 'claude-code',
        scope: 'project',
        fileType: 'skill-tree',
        sha256: 'a'.repeat(64),
      })),
    }),
    { mode: 0o600 },
  );
  const limited = await f.run('read');
  assert.equal(schema.validateInventory(limited), true);
  assert.equal(limited.items.length, 512);
  assert.ok(
    limited.gaps.some((gap) => gap.code === 'limit' && gap.skillSource === 'claude-skills'),
  );
  assert.equal(
    limited.skillSources.find(
      (source) => source.id === 'claude-skills' && source.scope === 'project',
    ).status,
    'partial',
  );
});
