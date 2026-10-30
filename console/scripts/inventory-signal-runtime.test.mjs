import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { runtimeDigest } from './agent-setup-cli.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function appliesCapture() {
  const generatedAt = new Date().toISOString(),
    workspaceId = `workspace-${'a'.repeat(24)}`;
  const itemId = `item-${'b'.repeat(24)}`,
    artifactSha256 = 'c'.repeat(64);
  return {
    schema: 'stroq-inventory/1',
    source: 'local',
    generatedAt,
    workspace: { id: workspaceId, label: 'Fixture workspace' },
    baseline: { status: 'missing', reviewedAt: null },
    items: [
      {
        id: itemId,
        kind: 'skill',
        name: 'notes',
        agent: 'claude-code',
        scope: 'project',
        skillSource: 'claude-skills',
        fileType: 'skill-tree',
        sha256: artifactSha256,
        reviewedSha256: null,
        state: 'unreviewed',
        scan: { status: 'suspect', findings: 1 },
        capabilities: [],
        signalDecision: {
          standing: 'applies',
          record: {
            id: '11111111-1111-4111-8111-111111111111',
            binding: {
              workspaceId,
              itemId,
              agent: 'claude-code',
              skillSource: 'claude-skills',
              scope: 'project',
              artifactSha256,
              sourceSha256: 'd'.repeat(64),
              analysisSha256: 'e'.repeat(64),
            },
            decision: 'accepted-risk',
            reason: 'required-use',
            recordedAt: generatedAt,
          },
        },
      },
    ],
    gaps: [],
    limitations: [],
    signalDecisions: { status: 'ready' },
    skillSources: [{ id: 'claude-skills', scope: 'project', status: 'complete', candidates: 1 }],
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-signal-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    'platform/scripts',
    'platform/.local-engine',
    'platform/core',
    'dist',
    'project',
    'user',
  ])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  await writeFile(join(root, 'dist/index.js'), 'export const fixture = true;');
  await writeFile(join(root, 'platform/core/index.js'), 'export const fixture = true;');
  // The production parent and browser schema are bundled only into this fixture installation.
  for (const [entry, target] of [
    ['console/scripts/inventory.mjs', 'platform/scripts/inventory.mjs'],
    ['console/lib/inventory.ts', 'platform/.local-engine/inventory-schema.js'],
  ])
    await build({
      entry: {
        [target.slice(target.lastIndexOf('/') + 1).replace(/\.(?:mjs|js)$/, '')]: join(
          repository,
          entry,
        ),
      },
      outDir: dirname(join(root, target)),
      outExtension: () => ({ js: target.endsWith('.mjs') ? '.mjs' : '.js' }),
      format: ['esm'],
      platform: 'node',
      target: 'node22',
      splitting: false,
      config: false,
      dts: false,
      silent: true,
    });
  const worker = join(root, 'platform/.local-engine/inventory-worker.js');
  const capture = appliesCapture();
  await writeFile(
    worker,
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { access, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    await writeFile(join(workerData.userHome, 'worker-started'), 'ready');
    for (;;) {
      try { await access(join(workerData.userHome, 'release-worker')); break; }
      catch { await delay(5); }
    }
    parentPort.postMessage(${JSON.stringify(capture)});
  `,
  );
  const paths = {
    cli: join(root, 'dist/index.js'),
    package: join(root, 'package.json'),
    manifest: join(root, 'platform/runtime-manifest.json'),
    manifestRoot: root,
  };
  const names = [
    'platform/scripts/inventory.mjs',
    'platform/.local-engine/inventory-schema.js',
    'platform/.local-engine/inventory-worker.js',
    'platform/core/index.js',
  ];
  async function manifest() {
    const files = await Promise.all(
      names.map(async (path) => {
        const bytes = await readFile(join(root, path));
        return { path, size: bytes.length, sha256: sha256(bytes) };
      }),
    );
    await writeFile(paths.manifest, JSON.stringify({ schema: 'stroq-runtime/1', files }));
  }
  await manifest();
  const copied = await import(pathToFileURL(join(root, 'platform/scripts/inventory.mjs')).href);
  const schema = await import(
    pathToFileURL(join(root, 'platform/.local-engine/inventory-schema.js')).href
  );
  assert.equal(schema.validateInventory(capture), true);
  const inventory = copied.createInventory({
    project: join(root, 'project'),
    userHome: join(root, 'user'),
    timeoutMs: 5000,
  });
  t.after(() => inventory.close());
  async function started() {
    for (let count = 0; count < 200; count++) {
      try {
        await access(join(root, 'user/worker-started'));
        return;
      } catch {
        await delay(5);
      }
    }
    throw new Error('Fixture worker did not start');
  }
  const release = () => writeFile(join(root, 'user/release-worker'), 'ready');
  return { root, worker, paths, manifest, inventory, started, release };
}

test('an unchanged runtime accepts an ordinary complete applies capture even when the worker exits immediately', async (t) => {
  const f = await fixture(t),
    response = f.inventory.read();
  await f.started();
  await f.release();
  const result = await response;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.items[0].signalDecision.standing, 'applies');
});

test('a valid adapter rebuild during capture refuses the applies response before it can become current', async (t) => {
  const f = await fixture(t),
    initial = await runtimeDigest(f.paths);
  const response = f.inventory.read();
  await f.started();
  await writeFile(f.worker, (await readFile(f.worker, 'utf8')) + '\n// rebuilt adapter revision\n');
  await f.manifest();
  assert.notEqual(await runtimeDigest(f.paths), initial, 'the replacement is a valid new runtime');
  await f.release();
  assert.deepEqual(await response, { status: 503, body: { error: 'engine-unavailable' } });
  await assert.rejects(access(join(f.root, 'user/.stroq')));
});
