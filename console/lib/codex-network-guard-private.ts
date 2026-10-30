import { closed, count, hash } from './local-guards';
import {
  validateCodexNetworkGuardCapture,
  validateCodexNetworkGuardBinding,
  validateCodexNetworkGuardPreview,
  validateCodexNetworkGuardSelection,
  validateCodexNetworkGuardRestoreSelection,
  type CodexNetworkGuardPreview,
  type CodexNetworkGuardCapture,
  type CodexNetworkGuardBinding,
  type CodexNetworkGuardKind,
  type CodexNetworkGuardSelection,
  type CodexNetworkGuardRestoreSelection,
} from './codex-network-guard';
import type {
  PrivateControlRoot as Root,
  PrivateControlPin as Pin,
  PrivateControlSnapshot as Snapshot,
} from './codex-skill-controls-private';
export type GuardPrivateContext = { id: string; user: Root; target: string; rootBinding: string };
export type GuardPrivateNative = {
  path: string;
  sha256: string;
  file: Pin;
  version: string;
  platform: 'darwin';
  parents: Root[];
};
export type GuardPrivateSource = {
  id: string;
  scope: 'user' | 'system' | 'project' | 'managed';
  path: string;
  root: Root;
  snapshot: Snapshot;
};
export type GuardPrivateCapture = {
  public: CodexNetworkGuardCapture;
  context: GuardPrivateContext;
  sources: GuardPrivateSource[];
  native: GuardPrivateNative;
  binding: CodexNetworkGuardBinding;
  kind: CodexNetworkGuardKind | null;
  parentProfile: string | null;
  before: Snapshot;
};
export type GuardPrivateOwnership = {
  schema: 'stroq-codex-network-guard-transform/1';
  operationId: string;
  kind: CodexNetworkGuardKind;
  before: Uint8Array | null;
  candidate: Uint8Array;
  parentProfile: string | null;
  childProfile: string | null;
};
export type CodexNetworkGuardPrivatePlan = {
  schema: 'stroq-codex-network-private-plan/1';
  preview: CodexNetworkGuardPreview;
  request: CodexNetworkGuardSelection | CodexNetworkGuardRestoreSelection;
  context: GuardPrivateContext;
  before: Snapshot;
  candidate: Uint8Array | null;
  owned: GuardPrivateOwnership;
  capture: GuardPrivateCapture;
};
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
const path = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  v.startsWith('/') &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v) &&
  !v.split('/').some((p) => p === '.' || p === '..');
const root = (v: unknown) =>
  exact(v, ['path', 'dev', 'ino', 'uid', 'mode']) &&
  path(v.path) &&
  ['dev', 'ino', 'uid', 'mode'].every((k) => Number.isSafeInteger(v[k]) && v[k] >= 0);
const pin = (v: unknown, max = 256 * 1024) =>
  exact(v, ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, max);
const bytes = (v: unknown) => v instanceof Uint8Array && v.byteLength <= 256 * 1024;
const snapshot = (v: unknown) =>
  exact(v, ['bytes', 'sha256', 'mode', 'file', 'directories']) &&
  (v.sha256 === 'absent'
    ? v.bytes === null && v.file === null
    : bytes(v.bytes) && hash(v.sha256) && pin(v.file)) &&
  count(v.mode, 511) &&
  Array.isArray(v.directories) &&
  v.directories.length > 0 &&
  v.directories.length <= 128 &&
  v.directories.every(root);
const context = (v: unknown) =>
  exact(v, ['id', 'user', 'target', 'rootBinding']) &&
  typeof v.id === 'string' &&
  /^codex-context-[a-f0-9]{64}$/.test(v.id) &&
  root(v.user) &&
  path(v.target) &&
  v.target.startsWith(v.user.path + '/') &&
  v.target.endsWith('/config.toml') &&
  hash(v.rootBinding);
const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null
    ? b === null
    : b !== null && a.byteLength === b.byteLength && a.every((n, i) => n === b[i]);
function capture(v: unknown) {
  if (
    !exact(v, [
      'public',
      'context',
      'sources',
      'native',
      'binding',
      'kind',
      'parentProfile',
      'before',
    ]) ||
    !validateCodexNetworkGuardCapture(v.public) ||
    !context(v.context) ||
    !validateCodexNetworkGuardBinding(v.binding) ||
    v.binding.controlContextId !== v.context.id ||
    !Array.isArray(v.sources) ||
    v.sources.length > 64 ||
    !v.sources.every(
      (s: unknown) =>
        exact(s, ['id', 'scope', 'path', 'root', 'snapshot']) &&
        typeof s.id === 'string' &&
        /^config-source-[a-f0-9]{24}$/.test(s.id) &&
        ['user', 'system', 'project', 'managed'].includes(s.scope) &&
        path(s.path) &&
        root(s.root) &&
        snapshot(s.snapshot),
    ) ||
    !exact(v.native, ['path', 'sha256', 'file', 'version', 'platform', 'parents']) ||
    !path(v.native.path) ||
    !hash(v.native.sha256) ||
    v.native.sha256 !== v.binding.nativeBinarySha256 ||
    !pin(v.native.file, 512 * 1024 * 1024) ||
    v.native.platform !== 'darwin' ||
    typeof v.native.version !== 'string' ||
    !Array.isArray(v.native.parents) ||
    v.native.parents.length < 1 ||
    v.native.parents.length > 128 ||
    !v.native.parents.every(root) ||
    !snapshot(v.before) ||
    ![
      null,
      'profile-network-off',
      'profile-child',
      'legacy-network-off',
      'legacy-enable-workspace',
    ].includes(v.kind) ||
    !(
      v.parentProfile === null ||
      (typeof v.parentProfile === 'string' &&
        v.parentProfile.length > 0 &&
        v.parentProfile.length <= 2048)
    ) ||
    v.public.binding === null ||
    Object.keys(v.binding).some((k) => v.binding[k] !== v.public.binding[k])
  )
    return false;
  return (
    v.sources.reduce(
      (n: number, s: GuardPrivateSource) => n + (s.snapshot.bytes?.byteLength ?? 0),
      0,
    ) <=
    8 * 1024 * 1024
  );
}
export function validateCodexNetworkGuardPrivatePlan(
  v: unknown,
): v is CodexNetworkGuardPrivatePlan {
  if (
    !exact(v, [
      'schema',
      'preview',
      'request',
      'context',
      'before',
      'candidate',
      'owned',
      'capture',
    ]) ||
    v.schema !== 'stroq-codex-network-private-plan/1' ||
    !validateCodexNetworkGuardPreview(v.preview) ||
    !(
      validateCodexNetworkGuardSelection(v.request) ||
      validateCodexNetworkGuardRestoreSelection(v.request)
    ) ||
    !context(v.context) ||
    v.context.id !== v.preview.controlContextId ||
    v.context.id !== v.request.controlContextId ||
    !snapshot(v.before) ||
    (v.candidate !== null && !bytes(v.candidate)) ||
    !exact(v.owned, [
      'schema',
      'operationId',
      'kind',
      'before',
      'candidate',
      'parentProfile',
      'childProfile',
    ]) ||
    v.owned.schema !== 'stroq-codex-network-guard-transform/1' ||
    v.owned.operationId !== v.preview.recordId ||
    v.owned.kind !== v.preview.kind ||
    (v.owned.before !== null && !bytes(v.owned.before)) ||
    !bytes(v.owned.candidate) ||
    ![v.owned.parentProfile, v.owned.childProfile].every(
      (n) =>
        n === null ||
        (typeof n === 'string' &&
          n.length > 0 &&
          n.length <= 2048 &&
          !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(n)),
    ) ||
    !capture(v.capture) ||
    v.capture.context.id !== v.context.id ||
    v.before.sha256 !== (v.preview.beforeSha256 ?? 'absent')
  )
    return false;
  if (v.request.operation === 'guard')
    return (
      v.preview.operation === 'guard' &&
      v.capture.binding.captureSha256 === v.request.captureSha256 &&
      v.preview.binding?.captureSha256 === v.request.captureSha256 &&
      sameBytes(v.before.bytes, v.owned.before) &&
      sameBytes(v.candidate, v.owned.candidate)
    );
  return (
    v.preview.operation === 'restore' &&
    v.preview.recordId === v.request.recordId &&
    v.preview.recordRevision === v.request.recordRevision
  );
}
export function codexNetworkGuardPrivatePlanBytes(v: unknown) {
  if (!validateCodexNetworkGuardPrivatePlan(v)) return Infinity;
  return (
    (v.before.bytes?.byteLength ?? 0) +
    (v.candidate?.byteLength ?? 0) +
    (v.owned.before?.byteLength ?? 0) +
    v.owned.candidate.byteLength +
    v.capture.sources.reduce((n, s) => n + (s.snapshot.bytes?.byteLength ?? 0), 0) +
    65536
  );
}
