import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import { atomicWrite, rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { workspaceHash } from './workspace-review-projection.js';
import {
  validateWorkspaceReviewCapture,
  type WorkspaceReviewBaseline,
  type WorkspaceReviewCapture,
} from '../lib/workspace-review.js';

interface StoreOptions {
  home: string;
  storeId: string;
  workspaceId: string;
}
export interface BaselineSnapshot {
  public: WorkspaceReviewBaseline;
  location: {
    root: Awaited<ReturnType<typeof rootIdentity>>;
    path: string;
    before: Awaited<ReturnType<typeof snapshotFile>>;
  } | null;
}
const absent = (): WorkspaceReviewBaseline => ({
  status: 'missing',
  revision: null,
  reviewedAt: null,
  capture: null,
});
const invalid = (): WorkspaceReviewBaseline => ({
  status: 'invalid',
  revision: null,
  reviewedAt: null,
  capture: null,
});
const owned = (info: { uid: number }) =>
  typeof process.getuid !== 'function' || info.uid === process.getuid();
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never {
  throw new Error(code);
}

/** Read without mkdir; malformed or unsafe baselines stay visible and cannot be replaced. */
export async function readWorkspaceBaseline(options: StoreOptions): Promise<BaselineSnapshot> {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(options.storeId) ||
      !/^workspace-[a-f0-9]{24}$/.test(options.workspaceId)
    )
      fail('baseline-unavailable');
    let at = resolve(options.home);
    for (;;) {
      try {
        await lstat(at);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
        at = dirname(at);
      }
    }
    const root = await rootIdentity(at),
      path = join(
        resolve(options.home),
        'console',
        `workspace-review-baseline-${options.storeId}.json`,
      );
    const before = await snapshotFile(root, path, 1048576 + 4096);
    if (
      before.directories.some((d) => !owned(d) || (d.mode & 0o022) !== 0) ||
      before.directories.some(
        (d) =>
          (d.path === resolve(options.home) || d.path === dirname(path)) &&
          (d.mode & 0o777) !== 0o700,
      ) ||
      (before.file && (!owned(before.file) || (before.file.mode & 0o777) !== 0o600))
    )
      fail('baseline-unavailable');
    const location = { root, path, before };
    if (before.bytes === null) return { public: absent(), location };
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(before.bytes));
    if (!parsed.ok || !object(parsed.value)) fail('baseline-unavailable');
    const value = parsed.value;
    if (
      Object.keys(value).sort().join(',') !== 'capture,reviewedAt,schema,workspaceId' ||
      value.schema !== 'stroq-workspace-baseline/1' ||
      value.workspaceId !== options.workspaceId ||
      typeof value.reviewedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.reviewedAt)) ||
      new Date(value.reviewedAt).toISOString() !== value.reviewedAt ||
      !validateWorkspaceReviewCapture(value.capture) ||
      !value.capture.complete ||
      value.capture.workspaceId !== options.workspaceId ||
      value.capture.capturedAt > value.reviewedAt
    )
      fail('baseline-unavailable');
    return {
      public: {
        status: 'available',
        revision: workspaceHash(before.bytes),
        reviewedAt: value.reviewedAt,
        capture: value.capture,
      },
      location,
    };
  } catch {
    return { public: invalid(), location: null };
  }
}

/** Caller holds the real shared configuration lock until worker termination and readback. */
export async function writeWorkspaceBaseline(
  options: StoreOptions,
  before: BaselineSnapshot,
  capture: WorkspaceReviewCapture,
  reviewedAt: string,
  assertCurrent: () => void | Promise<void>,
  fault?: (stage: string, details: Record<string, unknown>) => void | Promise<void>,
): Promise<string> {
  if (
    before.location === null ||
    before.public.status === 'invalid' ||
    !validateWorkspaceReviewCapture(capture) ||
    !capture.complete
  )
    fail('baseline-unavailable');
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 'stroq-workspace-baseline/1',
      workspaceId: options.workspaceId,
      reviewedAt,
      capture,
    }) + '\n',
  );
  if (bytes.length > 1048576 + 4096) fail('baseline-unavailable');
  let committed = false;
  try {
    await assertCurrent();
    await atomicWrite(
      before.location.root,
      before.location.path,
      bytes,
      before.location.before,
      0o600,
      {
        fault: async (stage?: string, details: Record<string, unknown> = {}) => {
          if (stage === undefined) fail('baseline-unavailable');
          if (stage === 'after-rename') committed = true;
          await fault?.(stage, details);
          if (stage === 'before-rename') await assertCurrent();
        },
      },
    );
    await assertCurrent();
    const after = await readWorkspaceBaseline(options),
      revision = workspaceHash(bytes);
    if (after.public.status !== 'available' || after.public.revision !== revision)
      fail('write-unconfirmed');
    return revision;
  } catch (error) {
    if (committed) fail('write-unconfirmed');
    if (
      error instanceof Error &&
      ['stale-capture', 'stale-baseline', 'baseline-unavailable'].includes(error.message)
    )
      throw error;
    if (error instanceof Error && error.message === 'preview-stale') fail('stale-baseline');
    fail('baseline-unavailable');
  }
}
