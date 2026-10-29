/** Server/main-worker boundary. Raw config and credential metadata never reach HTTP. */
import {
  validateCodexPathGuardPreview,
  validateCodexPathGuardSelection,
  validateCodexPathGuardRestoreSelection,
  type CodexPathGuardPreview,
  type CodexPathGuardSelection,
  type CodexPathGuardRestoreSelection,
  type CodexPathGuardCapture,
  type CodexPathGuardBinding,
  type CodexPathGuardPresetId,
} from './codex-path-guard';
import type {
  GuardPrivateContext,
  GuardPrivateSource,
  GuardPrivateNative,
  GuardPrivateCapture,
} from './codex-network-guard-private';
import type {
  PrivateControlSnapshot,
  PrivateControlPin,
  PrivateControlRoot,
} from './codex-skill-controls-private';
import {
  exact,
  privateBytes,
  privateContext,
  privateName,
  privatePathCapture,
  privateSnapshot,
  privateTargetPath,
  samePrivate,
  samePrivateBytes,
} from './codex-path-guard-private-guards';
export type PathPrivateOwnership = {
  schema: 'stroq-codex-path-guard-transform/1';
  kind: 'profile-path-deny';
  operationId: string;
  profileName: string;
  targetPath: string;
  before: Uint8Array;
  candidate: Uint8Array;
};
export type PathPrivateCapture = {
  public: CodexPathGuardCapture;
  context: GuardPrivateContext;
  before: PrivateControlSnapshot;
  sources: GuardPrivateSource[];
  native: GuardPrivateNative;
  binding: CodexPathGuardBinding;
  profileName: string | null;
  targets: {
    targets: {
      id: CodexPathGuardPresetId;
      path: string;
      status: 'regular' | 'absent' | 'unsafe' | 'unavailable';
      directories: PrivateControlRoot[];
      file: PrivateControlPin | null;
    }[];
    sha256: string;
  };
  base: GuardPrivateCapture;
  dependencySha256: string;
};
export type CodexPathGuardPrivatePlan = {
  schema: 'stroq-codex-path-private-plan/1';
  preview: CodexPathGuardPreview;
  request: CodexPathGuardSelection | CodexPathGuardRestoreSelection;
  context: GuardPrivateContext;
  before: PrivateControlSnapshot;
  candidate: Uint8Array;
  owned: PathPrivateOwnership;
  capture: PathPrivateCapture;
};
export function validateCodexPathGuardPrivatePlan(v: unknown): v is CodexPathGuardPrivatePlan {
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
    v.schema !== 'stroq-codex-path-private-plan/1' ||
    !validateCodexPathGuardPreview(v.preview) ||
    !(
      validateCodexPathGuardSelection(v.request) ||
      validateCodexPathGuardRestoreSelection(v.request)
    ) ||
    !privateContext(v.context) ||
    v.context.id !== v.preview.controlContextId ||
    v.context.id !== v.request.controlContextId ||
    !privateSnapshot(v.before) ||
    !privateBytes(v.before.bytes) ||
    !privateBytes(v.candidate) ||
    !exact(v.owned, [
      'schema',
      'operationId',
      'kind',
      'profileName',
      'targetPath',
      'before',
      'candidate',
    ]) ||
    v.owned.schema !== 'stroq-codex-path-guard-transform/1' ||
    v.owned.kind !== 'profile-path-deny' ||
    v.owned.operationId !== v.preview.recordId ||
    !privateName(v.owned.profileName) ||
    v.owned.profileName === 'filesystem' ||
    v.owned.profileName.startsWith(':') ||
    v.owned.targetPath !== privateTargetPath(v.context.user.path, v.preview.presetId) ||
    !privateBytes(v.owned.before) ||
    !privateBytes(v.owned.candidate) ||
    !privatePathCapture(v.capture) ||
    !samePrivate(v.capture.context, v.context) ||
    v.before.sha256 !== v.preview.beforeSha256 ||
    v.capture.before.sha256 !== v.before.sha256 ||
    !samePrivateBytes(v.capture.before.bytes, v.before.bytes)
  )
    return false;
  if (v.request.operation === 'guard')
    return (
      v.preview.operation === 'guard' &&
      v.preview.presetId === v.request.presetId &&
      v.capture.profileName === v.owned.profileName &&
      v.capture.public.presets.some(
        (p: { id: string; canGuard: boolean }) => p.id === v.request.presetId && p.canGuard,
      ) &&
      samePrivate(v.preview.binding, v.capture.binding) &&
      v.capture.binding.captureSha256 === v.request.captureSha256 &&
      samePrivateBytes(v.before.bytes, v.owned.before) &&
      samePrivateBytes(v.candidate, v.owned.candidate)
    );
  return (
    v.preview.operation === 'restore' &&
    v.preview.recordId === v.request.recordId &&
    v.preview.recordRevision === v.request.recordRevision
  );
}
export function codexPathGuardPrivatePlanBytes(v: unknown): number {
  if (!validateCodexPathGuardPrivatePlan(v)) return Infinity;
  let total = 0;
  const visit = (value: unknown): void => {
    if (total > 8 * 1024 * 1024) return;
    if (value instanceof Uint8Array) {
      total += value.byteLength;
      return;
    }
    if (typeof value === 'string') {
      total += value.length * 2 + 16;
      return;
    }
    if (value === null || typeof value !== 'object') {
      total += 8;
      return;
    }
    total += 32;
    for (const [key, child] of Object.entries(value)) {
      total += key.length * 2 + 16;
      visit(child);
      if (total > 8 * 1024 * 1024) return;
    }
  };
  visit(v);
  return total > 8 * 1024 * 1024 ? Infinity : total;
}
