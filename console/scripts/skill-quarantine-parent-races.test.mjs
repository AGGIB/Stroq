import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const require = createRequire(import.meta.url);
const filesystem = require('node:fs/promises');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-parent-race-engine-')));
after(() => rm(output, { recursive: true, force: true }));
// CJS keeps the built-in filesystem seam local to this test process. Production is unchanged.
await build({
  entry: { source: join(repository, 'console/scripts/skill-quarantine-source.ts') },
  outDir: output,
  outExtension: () => ({ js: '.cjs' }),
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
  noExternal: ['@stroq/core', 'yaml', 'zod'],
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const source = require(join(output, 'source.cjs'));

async function fixture(t, groupExists = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-parent-race-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  const container = join(project, '.cursor');
  const group = join(container, 'skills/group');
  await mkdir(groupExists ? group : dirname(group), { recursive: true });
  const stat = await filesystem.lstat(project);
  const root = { path: project, dev: stat.dev, ino: stat.ino };
  const selected = { skillSource: 'cursor-skills', locator: 'group/notes' };
  const deadline = Date.now() + 25_000;
  const expected = await source.inspectSourceParents(root, 'project', selected, deadline, true);
  return { directory, project, container, group, root, selected, deadline, expected };
}

const restoreParents = (fixture) =>
  source.restoreSourceParents(
    fixture.root,
    'project',
    fixture.selected,
    fixture.expected,
    fixture.deadline,
  );

test('restore refuses an existing source parent replaced after its initial preview check', async (t) => {
  const f = await fixture(t);
  const original = filesystem.lstat;
  let finalParentReads = 0;
  let replaced = false;
  filesystem.lstat = async (...args) => {
    if (args[0] === f.group) finalParentReads++;
    // inspectSourceParents reads the final container and then checks its markers.
    // Replace the earlier parent only after that entire initial pin check finished.
    if (args[0] === f.container && finalParentReads >= 2 && !replaced) {
      replaced = true;
      await rename(f.container, join(f.directory, 'original-cursor'));
      await mkdir(f.container);
    }
    return original(...args);
  };
  try {
    await assert.rejects(restoreParents(f), /quarantine-preview-stale/);
    assert.equal(replaced, true);
  } finally {
    filesystem.lstat = original;
  }
});

test('restore keeps a newly created parent pinned through the final expanded parent check', async (t) => {
  const f = await fixture(t, false);
  const originalLstat = filesystem.lstat;
  const originalMkdir = filesystem.mkdir;
  let created = false;
  let captured = false;
  let replaced = false;
  filesystem.mkdir = async (...args) => {
    const result = await originalMkdir(...args);
    if (args[0] === f.group) created = true;
    return result;
  };
  filesystem.lstat = async (...args) => {
    if (args[0] === f.group && created) {
      if (captured && !replaced) {
        replaced = true;
        await rename(f.group, join(f.directory, 'original-group'));
        await originalMkdir(f.group);
      }
      captured = true;
    }
    return originalLstat(...args);
  };
  try {
    await assert.rejects(restoreParents(f), /quarantine-preview-stale/);
    assert.equal(created, true);
    assert.equal(replaced, true);
  } finally {
    filesystem.lstat = originalLstat;
    filesystem.mkdir = originalMkdir;
  }
});

test('restore never adopts an outside parent that wins the exclusive creation race', async (t) => {
  const f = await fixture(t, false);
  const original = filesystem.mkdir;
  let appeared = false;
  filesystem.mkdir = async (...args) => {
    if (args[0] === f.group && !appeared) {
      appeared = true;
      await original(f.group);
    }
    return original(...args);
  };
  try {
    await assert.rejects(restoreParents(f), /quarantine-preview-stale/);
    assert.equal(appeared, true);
  } finally {
    filesystem.mkdir = original;
  }
});

test('restore extends its original parent pins when missing containers are created normally', async (t) => {
  const f = await fixture(t, false);
  const current = await restoreParents(f);
  assert.deepEqual(current.slice(0, f.expected.length), f.expected);
  assert.equal(current.length, f.expected.length + 1);
  assert.equal(current.at(-1).path, f.group);
  const actual = await filesystem.lstat(f.group);
  assert.equal(current.at(-1).ino, actual.ino);
  assert.equal(current.at(-1).dev, actual.dev);
});

test('restore checks its commit guard before each missing parent is published', async (t) => {
  const f = await fixture(t, false);
  await rm(f.container, { recursive: true });
  const expected = await source.inspectSourceParents(
    f.root,
    'project',
    f.selected,
    f.deadline,
    true,
  );
  let checks = 0;
  await assert.rejects(
    source.restoreSourceParents(f.root, 'project', f.selected, expected, f.deadline, async () => {
      if (++checks === 2) throw new Error('quarantine-preview-stale');
    }),
    /quarantine-preview-stale/,
  );
  assert.equal(checks, 2);
  await access(f.container);
  await assert.rejects(access(join(f.container, 'skills')));
});
