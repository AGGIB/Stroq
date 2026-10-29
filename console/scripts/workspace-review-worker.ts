import { parentPort, workerData } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { stableStringify } from '@stroq/core';
import {
  captureWorkspaceSurface,
  recheckWorkspaceSurface,
} from '../../packages/cli/src/exposure/workspace-surface.js';
import { rootIdentity } from './agent-setup-files.mjs';
import { projectWorkspaceCapture, workspaceHash } from './workspace-review-projection.js';
import { readWorkspaceBaseline, writeWorkspaceBaseline } from './workspace-review-store.js';
import { runWorkspaceTaskWorker } from './workspace-task-worker.ts';
import { WORKSPACE_TASK_ERRORS } from '../lib/workspace-task-controls.ts';
import {
  deriveWorkspaceReviewComparison,
  validateWorkspaceReviewCapture,
  WORKSPACE_REVIEW_ERRORS,
  validateWorkspaceReviewReceipt,
  type WorkspaceReviewCapture,
  type WorkspaceReviewResult,
} from '../lib/workspace-review.js';

interface Options {
  project: string;
  userHome: string;
  home: string;
  workspaceId: string;
  storeId: string;
  engineVersion: string;
  runtimeSha256: string;
  now: string;
  deadline?: number;
  configurationLockHeld?: boolean;
  commitGuard?: { runtimePaths: Record<string, string>; expiresAt: number | null };
  roots: {
    project: Awaited<ReturnType<typeof rootIdentity>>;
    user: Awaited<ReturnType<typeof rootIdentity>>;
  };
}
interface Request {
  operation: 'baseline' | 'check' | 'review' | `task-${string}`;
  input?: Record<string, unknown>;
  options: Options;
}
interface Hooks {
  fault?: (
    stage: 'after-capture' | 'before-rename' | 'after-rename',
    details: Record<string, unknown>,
  ) => void | Promise<void>;
}
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never {
  throw new Error(code);
}
async function context(options: Options) {
  if (
    !/^workspace-[a-f0-9]{24}$/.test(options.workspaceId) ||
    !sha(options.storeId) ||
    !sha(options.runtimeSha256) ||
    typeof options.engineVersion !== 'string'
  )
    fail('context-unavailable');
  const roots = {
    project: await rootIdentity(options.project),
    user: await rootIdentity(options.userHome),
  };
  if (
    !isDeepStrictEqual(roots, options.roots) ||
    Object.values(roots).some(
      (r) =>
        (typeof process.getuid === 'function' && r.uid !== process.getuid()) ||
        (r.mode & 0o022) !== 0,
    )
  )
    fail('context-unavailable');
  if (options.deadline !== undefined && Date.now() >= options.deadline) fail('deadline-exceeded');
}
function capture(options: Options) {
  const raw = captureWorkspaceSurface({
    project: options.project,
    workspaceId: options.workspaceId,
    deadline: options.deadline,
    ignoredRoots: [options.home],
  });
  const exclusions = (
    raw as typeof raw & { exclusions: { reason: string; path: string; sha256: string }[] }
  ).exclusions;
  if (!Array.isArray(exclusions)) fail('invalid-report');
  const profile = {
    id: 'stroq-workspace-surface/1' as const,
    engineVersion: options.engineVersion,
    runtimeSha256: options.runtimeSha256,
    scopeSha256: workspaceHash(stableStringify(exclusions)),
  };
  return { raw, public: projectWorkspaceCapture(raw, options.workspaceId, options.now, profile) };
}
function sameEvidence(a: WorkspaceReviewCapture, b: WorkspaceReviewCapture): boolean {
  const { capturedAt: _a, ...left } = a,
    { capturedAt: _b, ...right } = b;
  return isDeepStrictEqual(left, right);
}
export async function runWorkspaceReviewWorker(request: Request, hooks: Hooks = {}) {
  const { operation, options } = request;
  await context(options);
  if (operation.startsWith('task-'))
    return runWorkspaceTaskWorker(request as any, hooks.fault as any);
  const baseline = await readWorkspaceBaseline(options);
  if (operation === 'baseline') return baseline.public;
  if (operation === 'check') {
    if (Object.keys(request.input ?? {}).length) fail('invalid-report');
    const made = capture(options);
    await hooks.fault?.('after-capture', {});
    await context(options);
    made.public = projectWorkspaceCapture(
      made.raw,
      options.workspaceId,
      options.now,
      made.public.profile,
    );
    const result: WorkspaceReviewResult = {
      capture: made.public,
      baseline: baseline.public,
      comparison: deriveWorkspaceReviewComparison(made.public, baseline.public),
      canReview: made.public.complete && baseline.public.status !== 'invalid',
    };
    return result;
  }
  if (operation !== 'review' || options.configurationLockHeld !== true)
    fail('workspace-review-failed');
  const input = request.input ?? {};
  if (
    Object.keys(input).sort().join(',') !== 'capture,expectedReviewedRevision,runId' ||
    !object(input.capture) ||
    !validateWorkspaceReviewCapture(input.capture) ||
    typeof input.runId !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.runId) ||
    !(input.expectedReviewedRevision === null || sha(input.expectedReviewedRevision))
  )
    fail('invalid-report');
  const approved = input.capture;
  if (!approved.complete) fail('incomplete-capture');
  if (baseline.public.status === 'invalid') fail('baseline-unavailable');
  if (baseline.public.revision !== input.expectedReviewedRevision) fail('stale-baseline');
  const made = capture(options);
  if (!made.public.complete || !sameEvidence(approved, made.public)) fail('stale-capture');
  await hooks.fault?.('after-capture', {});
  const assertCurrent = async () => {
    await context(options);
    if (!recheckWorkspaceSurface(made.raw.privateBinding)) fail('stale-capture');
  };
  const reviewedAt = new Date(
    Math.max(Date.parse(options.now), Date.parse(approved.capturedAt)),
  ).toISOString();
  const revision = await writeWorkspaceBaseline(
    options,
    baseline,
    approved,
    reviewedAt,
    assertCurrent,
    (stage, details) => {
      if (stage === 'before-rename' || stage === 'after-rename')
        return hooks.fault?.(stage, details);
    },
  );
  const receipt = {
    schema: 'stroq-workspace-review-receipt/1' as const,
    workspaceId: options.workspaceId,
    runId: input.runId,
    captureSha256: approved.captureSha256,
    revision,
    reviewedAt,
    reviewOnly: true as const,
    hostEnforcement: false as const,
  };
  if (!validateWorkspaceReviewReceipt(receipt)) fail('write-unconfirmed');
  return receipt;
}
if (parentPort)
  void runWorkspaceReviewWorker(workerData as Request).then(
    (result) => parentPort?.postMessage({ type: 'result', result }),
    (error) =>
      parentPort?.postMessage({
        type: 'error',
        error:
          error instanceof Error &&
          [
            ...WORKSPACE_REVIEW_ERRORS,
            ...WORKSPACE_TASK_ERRORS,
            'task-store-unavailable',
            'task-store-full',
            'stale-task-source',
            'task-recovery-required',
            'task-write-unconfirmed',
            'task-preview-expired',
          ].includes(error.message as (typeof WORKSPACE_REVIEW_ERRORS)[number])
            ? error.message
            : 'workspace-review-failed',
      }),
  );
