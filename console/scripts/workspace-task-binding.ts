import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  validateWorkspaceTaskVerification,
  type WorkspaceTaskVerification,
} from '../lib/workspace-task-controls.ts';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';

export const TASK_BYTES = 256 * 1024,
  TASK_RECORDS = 32,
  TASK_STORE_BYTES = 8 * 1024 * 1024;
export const MANIFEST_BYTES = 32768;
export const taskHash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const TASK_SOURCE_ID = `source-${taskHash('workspace\0.vscode/tasks.json')}`;
export type TaskSnapshot = Awaited<ReturnType<typeof snapshotFile>>;
export type TaskRoot = Awaited<ReturnType<typeof rootIdentity>>;
export interface TaskOptions {
  project: string;
  userHome: string;
  home: string;
  workspaceId: string;
  storeId: string;
  roots: { project: TaskRoot; user: TaskRoot };
  engineVersion: string;
  runtimeSha256: string;
  deadline: number;
}
export interface TaskSource {
  runId: string;
  captureSha256: string;
  sourceId: string;
  sourceSha256: string;
  sourceMode: number;
  capturedAt: string;
  engineVersion: string;
  runtimeSha256: string;
  scopeSha256: string;
  captureComplete: boolean;
}
export type TaskPin = NonNullable<TaskSnapshot['file']>;
export type PublishedPin = Omit<TaskPin, 'ctimeMs'>;
export type TaskParents = { dev: number; ino: number; uid: number; mode: number }[];
export interface TaskManifest {
  schema: 'stroq-workspace-task-record/1';
  id: string;
  storeId: string;
  workspaceId: string;
  rootBinding: string;
  source: TaskSource;
  createdAt: string;
  changedAt: string;
  phase: 'prepared' | 'manual' | 'restoring' | 'restored' | 'not-applied';
  changes: { folderOpen: number; worktreeCreated: number };
  bytes: number;
  manualSha256: string;
  original: TaskPin;
  parents: TaskParents;
  staged: PublishedPin | null;
  publication: TaskPin | null;
  restoreStaged: PublishedPin | null;
  restoredPublication: TaskPin | null;
  verification: WorkspaceTaskVerification | null;
}
export interface TaskRecord {
  manifest: TaskManifest;
  revision: string;
  directory: string;
  path: string;
  backup: Buffer;
}
export const SHA = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const owned = (v: { uid: number }) =>
  typeof process.getuid !== 'function' || v.uid === process.getuid();
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const stamp = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
export function taskFail(code: string): never {
  throw new Error(code);
}
export function checkTaskDeadline(options: TaskOptions) {
  if (Date.now() >= options.deadline) taskFail('deadline-exceeded');
}
export const taskRootBinding = (options: TaskOptions) =>
  taskHash(`${options.project}\0${options.roots.project.dev}\0${options.roots.project.ino}`);
export const taskParents = (snapshot: TaskSnapshot): TaskParents =>
  snapshot.directories.map(({ dev, ino, uid, mode }) => ({ dev, ino, uid, mode }));
export const stagedTaskPin = (pin: TaskPin): PublishedPin => {
  const { ctimeMs, ...rest } = pin;
  return rest;
};
export function validTaskSource(v: unknown): v is TaskSource {
  return (
    closed(v, [
      'runId',
      'captureSha256',
      'sourceId',
      'sourceSha256',
      'sourceMode',
      'capturedAt',
      'engineVersion',
      'runtimeSha256',
      'scopeSha256',
      'captureComplete',
    ]) &&
    typeof v.runId === 'string' &&
    UUID.test(v.runId) &&
    sha(v.captureSha256) &&
    v.sourceId === TASK_SOURCE_ID &&
    sha(v.sourceSha256) &&
    Number.isSafeInteger(v.sourceMode) &&
    Number(v.sourceMode) >= 0 &&
    Number(v.sourceMode) <= 0o777 &&
    typeof v.captureComplete === 'boolean' &&
    stamp(v.capturedAt) &&
    typeof v.engineVersion === 'string' &&
    v.engineVersion.length > 0 &&
    v.engineVersion.length <= 100 &&
    sha(v.runtimeSha256) &&
    sha(v.scopeSha256)
  );
}
function validPin(v: unknown, staged = false): boolean {
  const keys = [
    'dev',
    'ino',
    'uid',
    'mode',
    'nlink',
    'size',
    'mtimeMs',
    ...(staged ? [] : ['ctimeMs']),
  ];
  return (
    closed(v, keys) &&
    keys.every(
      (key) => typeof v[key] === 'number' && Number.isFinite(v[key]) && Number(v[key]) >= 0,
    ) &&
    ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'].every((key) => Number.isSafeInteger(v[key])) &&
    v.nlink === 1 &&
    Number(v.size) <= TASK_BYTES
  );
}
export function validManifest(v: unknown, id: string): v is TaskManifest {
  return (
    closed(v, [
      'schema',
      'id',
      'storeId',
      'workspaceId',
      'rootBinding',
      'source',
      'createdAt',
      'changedAt',
      'phase',
      'changes',
      'bytes',
      'manualSha256',
      'original',
      'parents',
      'staged',
      'publication',
      'restoreStaged',
      'restoredPublication',
      'verification',
    ]) &&
    v.schema === 'stroq-workspace-task-record/1' &&
    v.id === id &&
    UUID.test(id) &&
    sha(v.storeId) &&
    sha(v.rootBinding) &&
    typeof v.workspaceId === 'string' &&
    /^workspace-[a-f0-9]{24}$/.test(v.workspaceId) &&
    validTaskSource(v.source) &&
    stamp(v.createdAt) &&
    v.source.capturedAt <= v.createdAt &&
    stamp(v.changedAt) &&
    v.changedAt >= v.createdAt &&
    ['prepared', 'manual', 'restoring', 'restored', 'not-applied'].includes(String(v.phase)) &&
    closed(v.changes, ['folderOpen', 'worktreeCreated']) &&
    Object.values(v.changes).every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 256,
    ) &&
    Number(v.changes.folderOpen) + Number(v.changes.worktreeCreated) > 0 &&
    Number(v.changes.folderOpen) + Number(v.changes.worktreeCreated) <= 256 &&
    Number.isSafeInteger(v.bytes) &&
    Number(v.bytes) > 0 &&
    Number(v.bytes) <= TASK_BYTES &&
    sha(v.manualSha256) &&
    v.manualSha256 !== v.source.sourceSha256 &&
    validPin(v.original) &&
    (v.original as TaskPin).size === v.bytes &&
    ((v.original as TaskPin).mode & 0o777) === v.source.sourceMode &&
    Array.isArray(v.parents) &&
    v.parents.length === 2 &&
    v.parents.every(
      (p) =>
        closed(p, ['dev', 'ino', 'uid', 'mode']) &&
        Object.values(p).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0),
    ) &&
    (v.staged === null || validPin(v.staged, true)) &&
    (v.publication === null || validPin(v.publication)) &&
    (v.restoreStaged === null || validPin(v.restoreStaged, true)) &&
    (v.restoredPublication === null || validPin(v.restoredPublication)) &&
    (!['manual', 'restoring', 'restored'].includes(String(v.phase)) ||
      (v.staged !== null && v.publication !== null)) &&
    (v.phase !== 'restored' || (v.restoreStaged !== null && v.restoredPublication !== null)) &&
    (v.verification === null ||
      (validateWorkspaceTaskVerification(v.verification) &&
        (v.verification.status !== 'recorded' ||
          (v.verification.capturedAt >= v.createdAt && v.verification.capturedAt <= v.changedAt))))
  );
}
export async function assertTaskContext(options: TaskOptions) {
  checkTaskDeadline(options);
  const roots = {
    project: await rootIdentity(options.project),
    user: await rootIdentity(options.userHome),
  };
  if (
    !isDeepStrictEqual(roots, options.roots) ||
    Object.values(roots).some((r) => !owned(r) || (r.mode & 0o022) !== 0) ||
    !sha(options.storeId) ||
    !sha(options.runtimeSha256) ||
    !/^workspace-[a-f0-9]{24}$/.test(options.workspaceId)
  )
    taskFail('stale-task-source');
}
