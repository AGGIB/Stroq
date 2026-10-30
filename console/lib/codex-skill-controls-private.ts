/** Main/worker boundary only. These values must never be projected to HTTP. */
import { closed, count, hash } from './local-guards';
import {
  validateCodexSkillControlPreview,
  validateCodexSkillControlSelection,
  validateCodexSkillControlRestoreSelection,
} from './codex-skill-controls';
import type {
  CodexSkillControlPreview,
  CodexSkillControlSelection,
  CodexSkillControlRestoreSelection,
} from './codex-skill-controls';
export type PrivateControlRoot = {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
};
export type PrivateControlPin = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
export type PrivateControlSnapshot = {
  bytes: Uint8Array | null;
  sha256: string;
  mode: number;
  file: PrivateControlPin | null;
  directories: PrivateControlRoot[];
};
export type ControlPrivatePlan = {
  schema: 'stroq-codex-skill-control-private-plan/1';
  preview: CodexSkillControlPreview;
  request: CodexSkillControlSelection | CodexSkillControlRestoreSelection;
  context: { id: string; user: PrivateControlRoot; target: string; rootBinding: string };
  before: PrivateControlSnapshot;
  candidate: Uint8Array | null;
  owned: {
    schema: 'stroq-codex-skill-disable-transform/1';
    operationId: string;
    documentPath: string;
    before: Uint8Array | null;
    candidate: Uint8Array;
  };
  candidatePin: { root: PrivateControlRoot; path: string; snapshot: PrivateControlSnapshot } | null;
};
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
const path = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  /^\//.test(v) &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const equalBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null
    ? b === null
    : b !== null && a.byteLength === b.byteLength && a.every((n, i) => n === b[i]);
const bytes = (v: unknown) => v instanceof Uint8Array && v.byteLength <= 256 * 1024;
const root = (v: unknown) =>
  exact(v, ['path', 'dev', 'ino', 'uid', 'mode']) &&
  path(v.path) &&
  ['dev', 'ino', 'uid', 'mode'].every(
    (k) => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && v[k] >= 0,
  );
const pin = (v: unknown) =>
  exact(v, ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, 256 * 1024);
const snapshot = (v: unknown) =>
  exact(v, ['bytes', 'sha256', 'mode', 'file', 'directories']) &&
  (v.bytes === null || bytes(v.bytes)) &&
  (v.sha256 === 'absent'
    ? v.bytes === null && v.file === null
    : hash(v.sha256) && bytes(v.bytes) && pin(v.file)) &&
  count(v.mode, 511) &&
  Array.isArray(v.directories) &&
  v.directories.length > 0 &&
  v.directories.length <= 128 &&
  v.directories.every(root);
export function validateCodexSkillControlPrivatePlan(v: unknown): v is ControlPrivatePlan {
  if (
    !exact(v, [
      'schema',
      'preview',
      'request',
      'context',
      'before',
      'candidate',
      'owned',
      'candidatePin',
    ]) ||
    v.schema !== 'stroq-codex-skill-control-private-plan/1' ||
    !validateCodexSkillControlPreview(v.preview) ||
    !(
      validateCodexSkillControlSelection(v.request) ||
      validateCodexSkillControlRestoreSelection(v.request)
    ) ||
    !exact(v.context, ['id', 'user', 'target', 'rootBinding']) ||
    v.context.id !== v.preview.controlContextId ||
    v.context.id !== v.request.controlContextId ||
    !root(v.context.user) ||
    !path(v.context.target) ||
    !hash(v.context.rootBinding) ||
    !snapshot(v.before) ||
    (v.candidate !== null && !bytes(v.candidate)) ||
    !exact(v.owned, ['schema', 'operationId', 'documentPath', 'before', 'candidate']) ||
    v.owned.schema !== 'stroq-codex-skill-disable-transform/1' ||
    v.owned.operationId !== v.preview.recordId ||
    !path(v.owned.documentPath) ||
    (v.owned.before !== null && !bytes(v.owned.before)) ||
    !bytes(v.owned.candidate)
  )
    return false;
  if (
    v.request.operation !== v.preview.operation ||
    !v.context.target.startsWith(v.context.user.path + '/') ||
    !v.context.target.endsWith('/config.toml') ||
    v.context.target.split('/').some((p: string) => p === '.' || p === '..') ||
    !v.owned.documentPath.endsWith('/SKILL.md') ||
    v.before.sha256 !== (v.preview.beforeSha256 ?? 'absent')
  )
    return false;
  if (v.request.operation === 'disable')
    return (
      equalBytes(v.owned.before, v.before.bytes) &&
      equalBytes(v.owned.candidate, v.candidate) &&
      v.preview.binding !== null &&
      v.preview.binding.sourceId === v.request.sourceId &&
      v.preview.binding.candidateId === v.request.candidateId &&
      v.preview.binding.entrypointSha256 === v.request.expectedEntrypointSha256 &&
      v.preview.binding.runtimeSha256 === v.request.expectedRuntimeSha256 &&
      v.preview.beforeSha256 === v.request.expectedConfigSha256 &&
      v.candidate !== null &&
      exact(v.candidatePin, ['root', 'path', 'snapshot']) &&
      root(v.candidatePin.root) &&
      path(v.candidatePin.path) &&
      v.candidatePin.path === v.owned.documentPath &&
      snapshot(v.candidatePin.snapshot) &&
      v.candidatePin.snapshot.sha256 === v.request.expectedEntrypointSha256
    );
  return (
    v.candidatePin === null &&
    v.request.recordId === v.preview.recordId &&
    v.request.recordRevision === v.preview.recordRevision
  );
}
export function codexSkillControlPrivatePlanBytes(v: unknown): number {
  if (!validateCodexSkillControlPrivatePlan(v)) return Infinity;
  return (
    (v.before.bytes?.byteLength ?? 0) +
    (v.candidate?.byteLength ?? 0) +
    (v.owned.before?.byteLength ?? 0) +
    v.owned.candidate.byteLength +
    (v.candidatePin?.snapshot.bytes?.byteLength ?? 0) +
    32768
  );
}
