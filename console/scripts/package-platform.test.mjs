import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagePlatform } from '../../scripts/package-platform.mjs';
import { ADAPTERS } from './build-runtime-manifest.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stroq-package-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    'console/scripts',
    'console/.local-engine',
    'console/out/agents',
    'packages/core/dist',
    'packages/cli/platform',
  ])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'console/scripts/launch.mjs'), "await import('./serve.mjs');");
  await writeFile(
    join(root, 'console/scripts/serve.mjs'),
    "import { x } from './service.mjs'; const worker = new URL('./worker.mjs', import.meta.url);",
  );
  await writeFile(join(root, 'console/scripts/service.mjs'), 'export const x = 1;');
  await writeFile(join(root, 'console/scripts/worker.mjs'), 'export {};');
  await writeFile(join(root, 'console/scripts/never.test.mjs'), 'throw new Error();');
  await writeFile(join(root, 'console/scripts/build-secret.mjs'), 'throw new Error();');
  await writeFile(join(root, 'console/out/index.html'), '<h1>Stroq</h1>');
  await writeFile(join(root, 'console/out/agents/index.html'), '<h1>Agents</h1>');
  await writeFile(join(root, 'packages/core/dist/index.js'), 'export {};');
  await writeFile(join(root, 'packages/cli/platform/previous'), 'keep-until-ready');
  for (const name of ADAPTERS)
    await writeFile(
      join(root, 'console/.local-engine', name),
      name.endsWith('.json') ? '{}' : 'export {};',
    );
  return root;
}

test('package contains the complete fixed service graph, static export and adapters, without source tests', async (t) => {
  const root = await fixture(t);
  const result = await packagePlatform(root);
  assert.equal(result.runtimeFiles, ADAPTERS.length + 5);
  const target = join(root, 'packages/cli/platform');
  assert.deepEqual(await readdir(join(target, 'scripts')), [
    'launch.mjs',
    'serve.mjs',
    'service.mjs',
    'worker.mjs',
  ]);
  assert.equal(await readFile(join(target, 'out/agents/index.html'), 'utf8'), '<h1>Agents</h1>');
  const manifest = JSON.parse(await readFile(join(target, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, result.runtimeFiles);
  assert.ok(
    manifest.files.every(
      (entry) => entry.path.startsWith('platform/') && /^[a-f0-9]{64}$/.test(entry.sha256),
    ),
  );
  assert.ok(
    (await readdir(join(root, 'packages/cli'))).every(
      (name) => !name.startsWith('.platform-stage-'),
    ),
  );
});

test('unexpected engine files and linked static files fail before replacing the previous packaged platform', async (t) => {
  const root = await fixture(t);
  const extra = join(root, 'console/.local-engine/other.js');
  await writeFile(extra, 'export {};');
  await assert.rejects(packagePlatform(root), /unexpected-engine-files/);
  assert.equal(
    await readFile(join(root, 'packages/cli/platform/previous'), 'utf8'),
    'keep-until-ready',
  );
  await rm(extra);
  await symlink(join(root, 'console/out/index.html'), join(root, 'console/out/linked.html'));
  await assert.rejects(packagePlatform(root), /unsafe-platform-asset/);
  assert.equal(
    await readFile(join(root, 'packages/cli/platform/previous'), 'utf8'),
    'keep-until-ready',
  );
});
