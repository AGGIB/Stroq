import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import ts from 'typescript';
import { writeRuntimeManifest, workspaceMonitorExternalPlugin } from './build-runtime-manifest.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Build-only parity with the CLI: use the same pure projection, never a second field list. */
export async function createRuntimeRulesPlugin() {
  const source = await readFile(
    resolve(repository, 'packages/core/src/rules/runtime-rule.ts'),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    fileName: 'runtime-rule.ts',
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  if (
    compiled.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  )
    throw new Error('runtime-rules-projection-unavailable');
  const { runtimeBundle } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
  );
  if (typeof runtimeBundle !== 'function') throw new Error('runtime-rules-projection-unavailable');
  return {
    name: 'stroq-runtime-rules',
    setup(engine) {
      engine.onLoad({ filter: /[\\/]core[\\/]src[\\/]rules\.bundle\.json$/ }, async (args) => ({
        contents: JSON.stringify(runtimeBundle(JSON.parse(await readFile(args.path, 'utf8')))),
        loader: 'json',
      }));
    },
  };
}

export async function buildEngine() {
  const output = resolve(repository, 'console/.local-engine');
  const entries = {
    'inventory-worker': resolve(repository, 'console/scripts/inventory-worker.ts'),
    'inventory-schema': resolve(repository, 'console/lib/inventory.ts'),
    'control-schema': resolve(repository, 'console/lib/control.ts'),
    'skill-quarantine-schema': resolve(repository, 'console/lib/skill-quarantine.ts'),
    'credential-filter-schema': resolve(repository, 'console/lib/credential-filters.ts'),
    'mcp-containment-schema': resolve(repository, 'console/lib/mcp-containment.ts'),
    'local-api-schema': resolve(repository, 'console/scripts/local-api-schema.ts'),
  };
  for (const [name, source] of [
    ['credential-filter-worker', 'credential-filter-worker.ts'],
    ['credential-filter-engine', 'credential-filter-engine.ts'],
    ['skill-quarantine-worker', 'skill-quarantine-worker.ts'],
    ['mcp-containment-worker', 'mcp-containment-worker.ts'],
    ['policy-engine', 'policy-engine-entry.ts'],
    ['agent-status-engine', 'agent-status-engine.ts'],
    ['live-proof-engine', 'live-proof-engine.ts'],
    ['hook-check-engine', 'hook-check-engine.ts'],
    ['task-lock-worker', 'task-lock-worker.ts'],
    ['workspace-review-worker', 'workspace-review-worker.ts'],
    ['workspace-monitor-engine', 'workspace-monitor-engine.ts'],
    ['incidents-engine', 'incidents-engine-entry.ts'],
    ['secret-scan-engine', 'secret-scan-engine.ts'],
    ['incident-recheck-engine', 'incident-recheck-engine-entry.ts'],
  ]) {
    const path = resolve(repository, 'console/scripts', source);
    try {
      if ((await stat(path)).isFile()) entries[name] = path;
    } catch {
      /* An unbuilt optional service reports unavailable rather than executing a fallback. */
    }
  }
  await mkdir(output, { recursive: true });
  await build({
    entry: entries,
    outDir: output,
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    config: false,
    noExternal: ['@stroq/core', 'yaml', 'zod', 'smol-toml'],
    removeNodeProtocol: false,
    esbuildPlugins: [await createRuntimeRulesPlugin(), workspaceMonitorExternalPlugin()],
    banner: {
      js: "import { createRequire as createEngineRequire } from 'node:module'; const require = createEngineRequire(import.meta.url);",
    },
    esbuildOptions(options) {
      options.alias = {
        ...options.alias,
        '@stroq/core': resolve(repository, 'packages/core/src/index.ts'),
      };
    },
  });
  await copyFile(
    resolve(repository, 'packages/cli/src/attack/scenarios/corpus.json'),
    resolve(output, 'corpus.json'),
  );
  for (const name of ['atlas', 'scope', 'asi']) {
    await copyFile(
      resolve(repository, `packages/cli/src/coverage/${name}.json`),
      resolve(output, `${name}.json`),
    );
  }
  await writeRuntimeManifest({
    root: repository,
    platform: 'console',
    core: 'packages/core/dist/index.js',
    manifest: resolve(output, 'runtime-manifest.json'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildEngine();
