import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDigest } from './agent-setup-cli.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stroq-runtime-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['dist', 'platform/scripts', 'platform/.local-engine', 'platform/core'])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'dist/index.js'), 'export {};');
  await writeFile(join(root, 'package.json'), '{"version":"0.28.0"}');
  const files = [];
  for (const path of [
    'platform/scripts/serve.mjs',
    'platform/.local-engine/adapter.js',
    'platform/core/index.js',
  ]) {
    const bytes = Buffer.from('export const value = 1;');
    await writeFile(join(root, path), bytes);
    files.push({
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const paths = {
    cli: join(root, 'dist/index.js'),
    package: join(root, 'package.json'),
    manifestRoot: root,
    manifest: join(root, 'platform/runtime-manifest.json'),
  };
  const manifest = { schema: 'stroq-runtime/1', files };
  await writeFile(paths.manifest, JSON.stringify(manifest));
  return { root, paths, manifest };
}

test('platform executable changes invalidate the exact preview while an updated build changes its digest', async (t) => {
  const { root, paths, manifest } = await fixture(t);
  const first = await runtimeDigest(paths);
  const file = join(root, manifest.files[0].path);
  await writeFile(file, 'export const value = 2;');
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
  const bytes = await readFile(file);
  manifest.files[0].sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(paths.manifest, JSON.stringify(manifest));
  assert.notEqual(first, await runtimeDigest(paths));
});

test('manifest cannot authorize traversal, foreign files, duplicates, links or unbounded runtime lists', async (t) => {
  const { root, paths, manifest } = await fixture(t);
  for (const path of [
    '../outside.js',
    '/tmp/anything.js',
    'platform/scripts/test.ts',
    'platform/out/index.html',
    'package.json',
  ]) {
    await writeFile(
      paths.manifest,
      JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], path }] }),
    );
    await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
  }
  await writeFile(
    paths.manifest,
    JSON.stringify({ ...manifest, files: [manifest.files[0], manifest.files[0]] }),
  );
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
  await writeFile(
    paths.manifest,
    JSON.stringify({ ...manifest, files: Array(129).fill(manifest.files[0]) }),
  );
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
  await writeFile(paths.manifest, JSON.stringify(manifest));
  await rm(join(root, manifest.files[0].path));
  await symlink(join(root, 'dist/index.js'), join(root, manifest.files[0].path));
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
});

test('a sibling platform directory never relaxes the original flat CLI distribution guard', async (t) => {
  const { root, paths } = await fixture(t);
  await mkdir(join(root, 'dist/platform'));
  await assert.rejects(runtimeDigest(paths), /engine-unavailable/);
});
