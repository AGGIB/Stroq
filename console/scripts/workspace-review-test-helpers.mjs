import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { build } from 'tsup';
import { createWorkspaceReviewService } from './workspace-review-service.mjs';
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function buildWorkspaceFixture() {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-workspace-build-')));
  await writeFile(
    join(output, 'lock.ts'),
    `export {withManifestLock} from '${repository}/packages/cli/src/harden/manifest.ts';`,
  );
  await writeFile(
    join(output, 'schema.ts'),
    `export * from '${repository}/console/lib/workspace-review.ts';export * from '${repository}/console/lib/workspace-monitor.ts';export {parseStrictJson as parseWorkspaceReviewHistoryJson} from '${repository}/packages/core/src/scope/strict-json.ts';`,
  );
  await build({
    entry: {
      worker: join(repository, 'console/scripts/workspace-review-worker.ts'),
      schema: join(output, 'schema.ts'),
      lock: join(output, 'lock.ts'),
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
      js: "import {createRequire as createFixtureRequire} from 'node:module';const require=createFixtureRequire(import.meta.url);",
    },
    esbuildOptions(o) {
      o.alias = { '@stroq/core': join(repository, 'packages/core/src/index.ts') };
    },
  });
  return {
    output,
    schema: await import(pathToFileURL(join(output, 'schema.mjs')).href),
    engine: await import(pathToFileURL(join(output, 'worker.mjs')).href),
    lock: await import(pathToFileURL(join(output, 'lock.mjs')).href),
  };
}
export async function workspaceFixture(t, built, extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-workspace-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const userHome = join(base, 'user');
  await mkdir(userHome, { mode: 0o700 });
  const project = extra.homeWorkspace ? userHome : join(base, 'project');
  if (project !== userHome) await mkdir(project, { mode: 0o700 });
  const home = join(userHome, '.stroq');
  let runtime = 'a'.repeat(64);
  const options = {
    project,
    userHome,
    home,
    workerPath: join(built.output, 'worker.mjs'),
    loadValidator: async () => built.schema,
    available: () => ({ available: true, version: '0.28.0' }),
    runtimeDigest: async () => runtime,
    withLock: ({ home, version }, action, options) =>
      built.lock.withManifestLock({ home, version, now: () => new Date() }, action, options),
    ...extra.options,
  };
  const service = await createWorkspaceReviewService(options);
  t.after(() => service.close());
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  return {
    base,
    userHome,
    project,
    home,
    service,
    options,
    workspaceId,
    setRuntime: (value) => {
      runtime = value;
    },
  };
}
export async function completed(service) {
  const started = await service.check({});
  assertStatus(started, 202);
  for (let i = 0; i < 150; i++) {
    const state = await service.getState(),
      run = state.runs.find((r) => r.id === started.body.id);
    if (run?.status !== 'running') return run;
    await setTimeout(20);
  }
  throw new Error('fixture-deadline');
}
function assertStatus(reply, status) {
  if (reply.status !== status)
    throw new Error(`fixture status ${reply.status}: ${reply.body.error}`);
}
export const reviewInput = (run) => ({
  runId: run.id,
  expectedCaptureSha256: run.result.capture.captureSha256,
  expectedReviewedRevision: run.result.baseline.revision,
  acknowledgeReviewOnly: true,
});
