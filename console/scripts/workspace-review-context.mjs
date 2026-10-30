import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { rootIdentity } from './agent-setup-files.mjs';
import { runtimeDigest } from './agent-setup-cli.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import { executeTaskLock } from './task-lock-runner.mjs';

export const workspaceReviewHash = (v) => createHash('sha256').update(v).digest('hex');
export const WORKSPACE_ERRORS = new Set([
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'workspace-review-busy',
  'history-unavailable',
  'baseline-unavailable',
  'stale-capture',
  'stale-baseline',
  'incomplete-capture',
  'deadline-exceeded',
  'output-limit',
  'invalid-report',
  'server-stopped',
  'cancelled',
  'write-unconfirmed',
  'workspace-review-failed',
]);
export const workspaceReviewError = (error) =>
  WORKSPACE_ERRORS.has(error?.message)
    ? error.message
    : error?.message === 'agent-configuration-busy'
      ? 'workspace-review-busy'
      : ['agent-configuration-unavailable', 'engine-unavailable'].includes(error?.message)
        ? 'runtime-unavailable'
        : 'workspace-review-failed';
export const workspaceReviewStatus = (code) =>
  ['stale-capture', 'stale-baseline', 'workspace-review-busy'].includes(code)
    ? 409
    : ['incomplete-capture', 'platform-unsupported', 'write-unconfirmed'].includes(code)
      ? 422
      : code === 'deadline-exceeded'
        ? 504
        : 503;
export const closedWorkspaceInput = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
export async function createWorkspaceReviewContext(configuration = {}) {
  const options = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome: homedir(),
    platform: process.platform,
    ...configuration,
  };
  options.home = resolve(options.home ?? join(options.userHome, '.stroq'));
  let roots = null,
    schema = null;
  try {
    roots = {
      project: await rootIdentity(resolve(options.project)),
      user: await rootIdentity(resolve(options.userHome)),
    };
  } catch {
    /* Explicit unverified context. */
  }
  const project = roots?.project.path ?? resolve(options.project),
    workspaceId = `workspace-${workspaceReviewHash(project).slice(0, 24)}`;
  if (options.workspaceId !== undefined && options.workspaceId !== workspaceId)
    throw new TypeError('workspace-mismatch');
  const storeId = workspaceReviewHash(
    `stroq-workspace/1\0${project}\0${roots?.project.dev ?? 'unknown'}\0${roots?.project.ino ?? 'unknown'}`,
  );
  try {
    schema = await (
      options.loadValidator ??
      (() => import(pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href))
    )();
  } catch {
    /* Unbuilt validators cannot authorize writes. */
  }
  const now = options.now ?? Date.now,
    available = options.available ?? (() => engineAvailability(options.paths)),
    digest = options.runtimeDigest ?? (() => runtimeDigest(options.paths));
  const validate = (kind, value) => schema?.[`validateWorkspaceReview${kind}`]?.(value) === true;
  async function current() {
    if (options.platform === 'win32') throw new Error('platform-unsupported');
    if (!roots) throw new Error('context-unavailable');
    const fromHome = relative(options.home, project);
    if (fromHome === '' || (!fromHome.startsWith('..') && !isAbsolute(fromHome)))
      throw new Error('context-unavailable');
    try {
      if (
        !isDeepStrictEqual(roots, {
          project: await rootIdentity(project),
          user: await rootIdentity(roots.user.path),
        })
      )
        throw new Error();
    } catch {
      throw new Error('context-unavailable');
    }
    if (
      typeof schema?.parseWorkspaceReviewHistoryJson !== 'function' ||
      !['State', 'Run', 'Capture', 'Result', 'Receipt', 'Baseline'].every(
        (kind) => typeof schema?.[`validateWorkspaceReview${kind}`] === 'function',
      )
    )
      throw new Error('runtime-unavailable');
    try {
      const info = await available(),
        runtime = await digest();
      if (
        info?.available !== true ||
        typeof info.version !== 'string' ||
        !info.version.length ||
        info.version.length > 100 ||
        !/^[a-f0-9]{64}$/.test(runtime)
      )
        throw new Error();
      return { engineVersion: info.version, runtimeSha256: runtime };
    } catch {
      throw new Error('runtime-unavailable');
    }
  }
  async function assert(bound, afterWrite = false) {
    try {
      if (!isDeepStrictEqual(await current(), bound)) throw new Error();
    } catch {
      throw new Error(afterWrite ? 'write-unconfirmed' : 'stale-capture');
    }
  }
  const run = (operation, input, bound, extra = {}) =>
    executeTaskLock(operation, input, {
      workerPath: options.workerPath ?? runtimeLayout().adapter('workspace-review-worker.js'),
      timeoutMs: options.timeoutMs,
      signal: extra.signal,
      onStart: extra.onStart,
      context: {
        project,
        userHome: roots.user.path,
        home: options.home,
        workspaceId,
        storeId,
        roots,
        ...bound,
        now: new Date(extra.at ?? now()).toISOString(),
        configurationLockHeld:
          operation === 'review' ||
          ['task-apply', 'task-recheck', 'task-verification'].includes(operation),
        ...(operation.startsWith('task-')
          ? {
              commitGuard: {
                runtimePaths: { ...options.paths },
                expiresAt: extra.expiresAt ?? null,
              },
            }
          : {}),
      },
    });
  return {
    options,
    roots,
    project,
    workspaceId,
    storeId,
    schema,
    now,
    validate,
    current,
    assert,
    run,
  };
}
