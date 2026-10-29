import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-baseline-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: {
    baseline: join(repository, 'console/scripts/inventory-baseline.ts'),
    worker: join(repository, 'console/scripts/inventory-worker.ts'),
    schema: join(repository, 'console/lib/inventory-changes.ts'),
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
    js: "import { createRequire as createBaselineRequire } from 'node:module'; const require = createBaselineRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});
const store = await import(pathToFileURL(join(output, 'baseline.mjs')).href);
const schema = await import(pathToFileURL(join(output, 'schema.mjs')).href);
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-inventory-baseline-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    userHome = join(directory, 'user'),
    home = join(userHome, '.stroq');
  await Promise.all([
    mkdir(join(project, '.claude/skills/release-notes'), { recursive: true }),
    mkdir(userHome),
  ]);
  const source = join(project, '.claude/skills/release-notes/SKILL.md');
  await writeFile(source, '# Release notes\nSummarize the changes and test results.');
  async function run(operation, input = {}) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: {
        project,
        userHome,
        home,
        operation,
        deadline: Date.now() + 25_000,
        mcpEnvironment: {},
        ...input,
      },
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
  const initial = await run('read');
  const workspace = initial.workspace.id;
  const file = join(home, 'console', `inventory-${workspace}.json`);
  const item = initial.items[0];
  async function review(expectedReviewedSha256 = null) {
    await mkdir(join(home, 'console'), { recursive: true, mode: 0o700 });
    const value = await run('review', {
      itemId: item.id,
      sha256: item.sha256,
      expectedReviewedSha256,
      reviewLockHeld: true,
    });
    assert.equal(value.error, undefined, JSON.stringify(value));
    return value;
  }
  return { directory, project, userHome, home, source, run, workspace, file, item, review };
}

test('v1 reads stay legacy without migration and strict malformed stores never become empty', async (t) => {
  const f = await fixture(t);
  const missing = await store.readInventoryBaseline(f.home, f.workspace);
  assert.equal(missing.status, 'missing');
  await mkdir(dirname(f.file), { recursive: true, mode: 0o700 });
  const legacy = {
    schema: 'stroq-inventory-baseline/1',
    workspace: f.workspace,
    reviewedAt: new Date().toISOString(),
    entries: [
      {
        id: f.item.id,
        kind: f.item.kind,
        name: f.item.name,
        agent: f.item.agent,
        scope: f.item.scope,
        fileType: f.item.fileType,
        sha256: f.item.sha256,
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(legacy));
  await writeFile(f.file, bytes);
  const read = await store.readInventoryBaseline(f.home, f.workspace);
  assert.equal(read.status, 'ready');
  assert.equal(read.entries[0].evidence, null);
  assert.equal(read.entries[0].reviewedAt, null);
  assert.deepEqual(await readFile(f.file), bytes);
  for (const invalid of [
    '{"schema":"other",' + JSON.stringify(legacy).slice(1),
    '\uFEFF\uFEFF' + JSON.stringify(legacy),
    Buffer.from([0xff]),
    Buffer.alloc(store.MAX_INVENTORY_BASELINE_BYTES + 1, 32),
  ]) {
    await writeFile(f.file, invalid);
    assert.equal((await store.readInventoryBaseline(f.home, f.workspace)).status, 'invalid');
    assert.deepEqual(await readFile(f.file), Buffer.from(invalid));
  }
});

test('review retains validated derived evidence and repeated comparison never advances it', async (t) => {
  const f = await fixture(t);
  const reviewed = await f.review();
  assert.equal(reviewed.items[0].state, 'unchanged');
  const before = await readFile(f.file);
  const saved = JSON.parse(before);
  assert.equal(saved.schema, 'stroq-inventory-baseline/3');
  assert.equal(saved.entries[0].evidence.artifact.sha256, f.item.sha256);
  assert.ok(!before.includes(Buffer.from('# Release notes')));
  await writeFile(f.source, '# Changed release notes\nRun the ordinary test suite.');
  const changed = (await f.run('read')).items[0];
  for (let n = 0; n < 2; n++) {
    const comparison = await f.run('compare', {
      id: changed.id,
      expectedSha256: changed.sha256,
      expectedReviewedSha256: f.item.sha256,
    });
    assert.equal(schema.validateInventoryComparison(comparison), true, JSON.stringify(comparison));
    assert.equal(comparison.baseline.status, 'available');
    assert.equal(comparison.changes.artifactChanged, true);
    assert.equal(comparison.changes.files.rows[0].state, 'modified');
    assert.deepEqual(await readFile(f.file), before);
  }
  assert.deepEqual(
    await f.run('review', {
      itemId: changed.id,
      sha256: changed.sha256,
      expectedReviewedSha256: null,
      reviewLockHeld: true,
    }),
    { error: 'review-conflict' },
  );
  assert.deepEqual(await readFile(f.file), before);
});

test('legacy v2 evidence remains byte-stable and compares with the same direct Claude source', async (t) => {
  const f = await fixture(t);
  await f.review();
  const legacy = JSON.parse(await readFile(f.file, 'utf8'));
  legacy.schema = 'stroq-inventory-baseline/2';
  delete legacy.entries[0].skillSource;
  delete legacy.entries[0].evidence.artifact.skillSource;
  legacy.entries[0].evidence.limitations[5] =
    'Skill discovery covers Claude Code project and user folders only; plugin caches and other agents are outside this inventory.';
  const bytes = JSON.stringify(legacy) + '\n';
  await writeFile(f.file, bytes);
  assert.equal((await store.readInventoryBaseline(f.home, f.workspace)).status, 'ready');
  const state = await f.run('read');
  assert.equal(state.items[0].state, 'unchanged');
  assert.equal(state.items[0].id, f.item.id);
  const comparison = await f.run('compare', {
    id: f.item.id,
    expectedSha256: f.item.sha256,
    expectedReviewedSha256: f.item.sha256,
  });
  assert.equal(schema.validateInventoryComparison(comparison), true, JSON.stringify(comparison));
  assert.equal(comparison.changes.artifactChanged, false);
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('v3 refuses source provenance inconsistent with retained evidence', async (t) => {
  const f = await fixture(t);
  await f.review();
  const baseline = JSON.parse(await readFile(f.file, 'utf8'));
  baseline.entries[0].agent = 'cursor';
  baseline.entries[0].skillSource = 'cursor-skills';
  const bytes = JSON.stringify(baseline);
  await writeFile(f.file, bytes);
  assert.equal((await store.readInventoryBaseline(f.home, f.workspace)).status, 'invalid');
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('review refuses an interposed baseline and never overwrites the external revision', async (t) => {
  const f = await fixture(t);
  await f.review();
  const before = await store.readInventoryBaseline(f.home, f.workspace);
  const external =
    JSON.stringify({
      ...JSON.parse(await readFile(f.file, 'utf8')),
      reviewedAt: '2027-01-01T00:00:00.000Z',
    }) + '\n';
  await assert.rejects(
    store.writeInventoryBaseline(
      f.home,
      f.workspace,
      before,
      before.entries,
      new Date().toISOString(),
      () => writeFile(f.file, external),
    ),
    /review-conflict/,
  );
  assert.equal(await readFile(f.file, 'utf8'), external);
});

test('directory substitution and unsafe v2 permissions stay refused without touching the replacement', async (t) => {
  const f = await fixture(t);
  await f.review();
  await chmod(f.file, 0o644);
  assert.equal((await store.readInventoryBaseline(f.home, f.workspace)).status, 'invalid');
  await chmod(f.file, 0o600);
  const before = await store.readInventoryBaseline(f.home, f.workspace);
  const consolePath = dirname(f.file);
  await assert.rejects(
    store.writeInventoryBaseline(
      f.home,
      f.workspace,
      before,
      before.entries,
      new Date().toISOString(),
      async () => {
        await rename(consolePath, `${consolePath}-retained`);
        await mkdir(consolePath, { mode: 0o700 });
        await writeFile(join(consolePath, 'private-sentinel'), 'untouched');
      },
    ),
    /review-conflict/,
  );
  assert.equal(await readFile(join(consolePath, 'private-sentinel'), 'utf8'), 'untouched');
});

test('same-inode staged-file tampering is refused before replacing the previous baseline', async (t) => {
  const f = await fixture(t);
  await f.review();
  const previousBytes = await readFile(f.file);
  const before = await store.readInventoryBaseline(f.home, f.workspace);
  let tampered = false;
  await assert.rejects(
    store.writeInventoryBaseline(
      f.home,
      f.workspace,
      before,
      before.entries,
      new Date().toISOString(),
      async () => {
        const names = await readdir(dirname(f.file));
        const staged = names.filter((name) => /^\.inventory-[a-f0-9-]+\.tmp$/.test(name));
        assert.equal(staged.length, 1);
        const temporary = join(dirname(f.file), staged[0]);
        const bytes = await readFile(temporary);
        // Truncating/replacing bytes preserves this file's inode, uid and permissions.
        await writeFile(temporary, Buffer.alloc(bytes.length, 0x78));
        tampered = true;
      },
    ),
    /review-conflict/,
  );
  assert.equal(tampered, true);
  assert.ok(
    (await readFile(f.file)).equals(previousBytes),
    'the exact previous baseline must survive the refusal',
  );
});

test('writes refuse group/world-writable store directories before staging or source recheck', async (t) => {
  const f = await fixture(t);
  await f.review();
  const previousBytes = await readFile(f.file);
  for (const directory of [f.home, dirname(f.file)])
    for (const mode of [0o770, 0o707]) {
      await chmod(directory, mode);
      const before = await store.readInventoryBaseline(f.home, f.workspace);
      assert.equal(
        before.status,
        'ready',
        'legacy-compatible read is independent of write permission guards',
      );
      const names = await readdir(dirname(f.file));
      let sourceRechecked = false;
      try {
        await assert.rejects(
          store.writeInventoryBaseline(
            f.home,
            f.workspace,
            before,
            before.entries,
            new Date().toISOString(),
            async () => {
              sourceRechecked = true;
            },
          ),
          /baseline-invalid/,
        );
        assert.equal(sourceRechecked, false);
        assert.deepEqual(await readdir(dirname(f.file)), names);
        assert.ok(
          (await readFile(f.file)).equals(previousBytes),
          'the exact previous baseline must survive the refusal',
        );
      } finally {
        await chmod(directory, 0o700);
      }
    }
});
