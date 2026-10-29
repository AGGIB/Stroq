import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-observe-worker-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { worker: join(repository, 'console/scripts/inventory-worker.ts') },
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
    js: "import {createRequire as createObserveRequire} from 'node:module';const require=createObserveRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
  },
});

test('private observation reads current sources without adopting invalid or saturated review metadata', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-observe-private-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(join(project, '.agents/skills/notes'), { recursive: true });
  await mkdir(join(home, 'console'), { recursive: true, mode: 0o700 });
  const bytes = '# Notes\nSummarize release changes.';
  await writeFile(join(project, '.agents/skills/notes/SKILL.md'), bytes);
  const workspace = 'workspace-' + createHash('sha256').update(project).digest('hex').slice(0, 24);
  const path = join(home, 'console', `inventory-${workspace}.json`);
  async function run(operation) {
    const worker = new Worker(join(output, 'worker.mjs'), {
      workerData: { project, userHome, home, operation, deadline: Date.now() + 25000 },
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
  // Invalid review history must stay visible in the ordinary workflow, while
  // a separate observation must not derive source coverage from this store.
  const malformed = '{"private-review-marker":true}';
  await writeFile(path, malformed, { mode: 0o600 });
  assert.equal((await run('read')).baseline.status, 'invalid');
  let observed = await run('observe');
  assert.equal(observed.baseline.status, 'missing');
  assert.equal(observed.items.length, 1);
  assert.equal(observed.items[0].reviewedSha256, null);
  assert.equal(observed.items[0].state, 'unreviewed');
  assert.equal(observed.gaps.length, 0);
  assert.equal(await readFile(path, 'utf8'), malformed);
  assert.equal(await readFile(join(project, '.agents/skills/notes/SKILL.md'), 'utf8'), bytes);
  const stored = {
    schema: 'stroq-inventory-baseline/1',
    workspace,
    reviewedAt: '2026-01-01T00:00:00.000Z',
    entries: Array.from({ length: 512 }, (_, n) => ({
      id: 'item-' + n.toString(16).padStart(24, '0'),
      kind: 'skill',
      agent: 'claude-code',
      scope: 'project',
      name: 'Previous ' + n,
      fileType: 'skill-tree',
      sha256: 'a'.repeat(64),
    })),
  };
  await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
  const reviewed = await run('read');
  assert.equal(reviewed.baseline.status, 'ready');
  assert(reviewed.gaps.some((g) => g.code === 'limit'));
  observed = await run('observe');
  assert.equal(observed.items.length, 1);
  assert.equal(observed.gaps.length, 0);
  assert(observed.skillSources.every((s) => s.status !== 'partial'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), stored);
});
