import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';

const ADAPTERS = [
  'inventory-worker.js',
  'skill-quarantine-worker.js',
  'skill-quarantine-schema.js',
  'credential-filter-worker.js',
  'credential-filter-engine.js',
  'credential-filter-schema.js',
  'mcp-containment-worker.js',
  'mcp-containment-schema.js',
  'inventory-schema.js',
  'control-schema.js',
  'local-api-schema.js',
  'policy-engine.js',
  'agent-status-engine.js',
  'live-proof-engine.js',
  'hook-check-engine.js',
  'task-lock-worker.js',
  'workspace-review-worker.js',
  'workspace-monitor-engine.js',
  'incidents-engine.js',
  'secret-scan-engine.js',
  'incident-recheck-engine.js',
  'corpus.json',
  'atlas.json',
  'scope.json',
  'asi.json',
];

/** Keep shared modules at their shipped script URLs; their own relative paths stay meaningful. */
export function workspaceMonitorExternalPlugin() {
  return {
    name: 'workspace-monitor-shared-runtime',
    setup(build) {
      build.onResolve(
        {
          filter:
            /^\.\/(?:workspace-review-context|agent-setup-files|agent-configuration-lock|runtime-layout|control-http|task-lock-runner)\.mjs$/,
        },
        (args) => {
          if (
            !/[\\/](?:workspace-monitor-(?:control|http|service|store|lease)\.mjs|(?:inventory-(?:monitor|observation)|journal-view-|workspace-task-|session-taint-|incident-assessment-)[\w.-]*\.ts)$/.test(
              args.importer,
            )
          )
            return;
          return { path: `../scripts/${args.path.slice(2)}`, external: true };
        },
      );
    },
  };
}

/** Collect the local service graph, including fixed worker entrypoints; tests and build tools never ship. */
export async function runtimeServiceNames(root) {
  const pending = ['launch.mjs', 'serve.mjs'];
  const found = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (found.has(name)) continue;
    if (!/^[a-z][\w.-]*\.mjs$/.test(name) || /(?:\.test|fixtures|^build-)/.test(name))
      throw new Error('unsafe-runtime-file');
    found.add(name);
    if (found.size > 64) throw new Error('runtime-file-limit');
    const file = await snapshotFile(root, join(root.path, name), 1024 * 1024);
    if (file.bytes === null) throw new Error('missing-runtime-file');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    for (const match of source.matchAll(
      /\b(?:from\s*|import\s*\(\s*|new URL\s*\(\s*)['"]\.\/([\w.-]+\.mjs)['"]/g,
    ))
      pending.push(match[1]);
  }
  return [...found].sort();
}

export async function runtimeAdapterNames(root) {
  const actual = (await readdir(root.path))
    .filter((name) => name !== 'runtime-manifest.json')
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...ADAPTERS].sort()))
    throw new Error('unexpected-engine-files');
  return ADAPTERS;
}

export async function writeRuntimeManifest({ root: rootPath, platform, core, manifest }) {
  const root = await rootIdentity(rootPath);
  const scripts = await rootIdentity(join(root.path, platform, 'scripts'));
  const names = await runtimeServiceNames(scripts);
  const adapterRoot = await rootIdentity(join(root.path, platform, '.local-engine'));
  await runtimeAdapterNames(adapterRoot);
  const paths = [
    ...names.map((name) => `${platform}/scripts/${name}`),
    ...ADAPTERS.map((name) => `${platform}/.local-engine/${name}`),
    core,
  ].sort();
  const files = [];
  let total = 0;
  for (const path of paths) {
    const file = await snapshotFile(root, join(root.path, path), 16 * 1024 * 1024);
    if (file.bytes === null || (total += file.bytes.length) > 48 * 1024 * 1024)
      throw new Error('runtime-size-limit');
    files.push({
      path,
      size: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    });
  }
  const target = relative(rootPath, manifest).split(sep).join('/');
  if (
    target !== `${platform}/runtime-manifest.json` &&
    target !== `${platform}/.local-engine/runtime-manifest.json`
  )
    throw new Error('unsafe-runtime-manifest');
  await writeFile(
    join(root.path, target),
    `${JSON.stringify({ schema: 'stroq-runtime/1', files }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return files;
}

export { ADAPTERS };
