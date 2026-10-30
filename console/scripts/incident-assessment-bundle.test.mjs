import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';
import { runtimeServiceNames, workspaceMonitorExternalPlugin } from './build-runtime-manifest.mjs';

test('production incident bundle loads using only the shipped service graph and preserves an absent home', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-assessment-bundle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = join(root, 'platform'),
    scripts = join(platform, 'scripts');
  await mkdir(scripts, { recursive: true });
  await mkdir(join(platform, 'core'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const names = await runtimeServiceNames(await rootIdentity(import.meta.dirname));
  for (const name of names) await copyFile(join(import.meta.dirname, name), join(scripts, name));
  await copyFile(
    join(import.meta.dirname, '../../packages/core/dist/index.js'),
    join(platform, 'core/index.js'),
  );
  await build({
    entry: { 'incidents-engine': join(import.meta.dirname, 'incidents-engine-entry.ts') },
    outDir: join(platform, '.local-engine'),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    config: false,
    dts: false,
    silent: true,
    noExternal: ['@stroq/core', 'yaml', 'zod', 'smol-toml'],
    esbuildPlugins: [workspaceMonitorExternalPlugin()],
    banner: {
      js: "import { createRequire as createEngineRequire } from 'node:module'; const require = createEngineRequire(import.meta.url);",
    },
  });
  const file = join(platform, '.local-engine/incidents-engine.js'),
    body = await readFile(file, 'utf8');
  for (const match of body.matchAll(/from\s*["']\.\.\/scripts\/([^"']+)["']/g))
    assert(
      names.includes(match[1]),
      `Adapter dependency is absent from shipped graph: ${match[1]}`,
    );
  const engine = await import(pathToFileURL(file).href);
  const home = join(root, 'missing-home'),
    service = await engine.createIncidentAssessmentService({ home });
  t.after(() => service.close());
  const state = await service.getState();
  assert.equal(state.status, 200);
  assert.equal(state.body.history, 'missing');
  assert.equal(state.body.canRecord, true);
  await assert.rejects(lstat(home), (error) => error.code === 'ENOENT');
});
