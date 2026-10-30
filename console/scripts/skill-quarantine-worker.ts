import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import {
  context,
  readState,
  preparePlan,
  publicPreview,
  applyPlan,
} from './skill-quarantine-operations.ts';
import { hash } from './skill-quarantine-paths.mjs';
import { LIMITATIONS } from './skill-quarantine-vault.ts';
import { runtimeDigest } from './runtime-digest.mjs';

const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function commitGuard(value: unknown, deadline: number) {
  if (
    !closed(value, ['runtimeSha256', 'paths', 'expiresAt']) ||
    typeof value.runtimeSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.runtimeSha256) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= 0 ||
    !closed(value.paths, ['cli', 'package', 'manifest', 'manifestRoot']) ||
    Object.values(value.paths).some(
      (path) => typeof path !== 'string' || !path || path.includes('\0'),
    )
  )
    throw new Error('quarantine-preview-stale');
  const expected = value.runtimeSha256,
    paths = value.paths;
  const expiresAt = Math.min(deadline, Number(value.expiresAt));
  return async (strong = true) => {
    if (Date.now() >= expiresAt) throw new Error('quarantine-preview-stale');
    if (!strong) return;
    let actual;
    try {
      actual = await runtimeDigest(paths);
    } catch {
      throw new Error('quarantine-preview-stale');
    }
    if (actual !== expected || Date.now() >= expiresAt) throw new Error('quarantine-preview-stale');
  };
}

const known = new Set([
  'quarantine-conflict',
  'quarantine-unsupported',
  'quarantine-full',
  'quarantine-preview-stale',
  'quarantine-recovery-required',
  'quarantine-unavailable',
  'deadline-exceeded',
]);
async function run() {
  const { operation, project, userHome, deadline } = workerData;
  let ctx;
  try {
    ctx = await context(project, userHome, deadline);
  } catch (error) {
    if (operation !== 'read') throw error;
    return {
      kind: 'result',
      body: {
        schema: 'stroq-skill-quarantine/2',
        source: 'local',
        generatedAt: new Date().toISOString(),
        workspaceId: `workspace-${hash(resolve(project)).slice(0, 24)}`,
        available: false,
        reason: 'context-unavailable',
        records: [],
        gaps: [],
        limitations: LIMITATIONS,
      },
    };
  }
  if (process.platform === 'win32') {
    if (operation !== 'read') throw new Error('quarantine-unsupported');
    return {
      kind: 'result',
      body: {
        schema: 'stroq-skill-quarantine/2',
        source: 'local',
        generatedAt: new Date().toISOString(),
        workspaceId: ctx.workspaceId,
        available: false,
        reason: 'platform-unsupported',
        records: [],
        gaps: [],
        limitations: LIMITATIONS,
      },
    };
  }
  if (operation === 'read') return { kind: 'result', body: await readState(ctx) };
  if (operation === 'preview') {
    const plan = await preparePlan(
      ctx,
      workerData.input,
      workerData.recordId,
      workerData.createdAt,
    );
    return {
      kind: 'plan',
      plan,
      body: publicPreview(ctx, plan, workerData.previewId, workerData.expiresAt),
    };
  }
  if (operation === 'apply') {
    ctx.commitGuard = commitGuard(workerData.commitGuard, deadline);
    return {
      kind: 'result',
      body: await applyPlan(ctx, workerData.plan, workerData.previewId, workerData.fault ?? null),
    };
  }
  throw new Error('quarantine-unavailable');
}
try {
  parentPort?.postMessage(await run());
} catch (error) {
  const message = (error as Error).message;
  parentPort?.postMessage({ error: known.has(message) ? message : 'quarantine-unavailable' });
}
