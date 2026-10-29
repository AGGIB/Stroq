import { closed, hash, member, stamp } from './local-guards';
import {
  CODEX_PATH_GUARD_ERRORS,
  CODEX_PATH_GUARD_GAPS,
  CODEX_PATH_GUARD_PRESETS,
  type CodexPathGuardBinding,
  type CodexPathGuardCapture,
  type CodexPathGuardSelection,
  type CodexPathGuardRestoreSelection,
  type CodexPathGuardRecheckSelection,
  type CodexPathGuardPreview,
  type CodexPathGuardRecord,
  type CodexPathGuardState,
  type CodexPathGuardReceipt,
} from './codex-path-guard-types';
export * from './codex-path-guard-types';
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const context = (v: unknown): v is string =>
  typeof v === 'string' && /^codex-context-[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const kind = (v: unknown) => v === 'profile-path-deny';
const preset = (v: unknown) => member(v, CODEX_PATH_GUARD_PRESETS);
const nullableHash = (v: unknown) => v === null || hash(v);
export function validateCodexPathGuardBinding(v: unknown): v is CodexPathGuardBinding {
  return (
    exact(v, [
      'controlContextId',
      'captureSha256',
      'configSha256',
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
      'targetMetadataSha256',
    ]) &&
    context(v.controlContextId) &&
    hash(v.captureSha256) &&
    nullableHash(v.configSha256) &&
    hash(v.runtimeSha256) &&
    hash(v.nativeBinarySha256) &&
    hash(v.sourceGraphSha256) &&
    hash(v.targetMetadataSha256)
  );
}
export function validateCodexPathGuardSelection(v: unknown): v is CodexPathGuardSelection {
  return (
    exact(v, ['operation', 'controlContextId', 'captureSha256', 'presetId']) &&
    v.operation === 'guard' &&
    context(v.controlContextId) &&
    hash(v.captureSha256) &&
    preset(v.presetId)
  );
}
export function validateCodexPathGuardRestoreSelection(
  v: unknown,
): v is CodexPathGuardRestoreSelection {
  return (
    exact(v, ['operation', 'controlContextId', 'recordId', 'recordRevision']) &&
    v.operation === 'restore' &&
    context(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision)
  );
}
export function validateCodexPathGuardRecheckSelection(
  v: unknown,
): v is CodexPathGuardRecheckSelection {
  return (
    exact(v, ['controlContextId', 'recordId', 'recordRevision', 'operationId']) &&
    context(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision) &&
    uuid(v.operationId)
  );
}
export function validateCodexPathGuardCapture(v: unknown): v is CodexPathGuardCapture {
  if (
    !exact(v, [
      'schema',
      'capturedAt',
      'binding',
      'compatibility',
      'baseline',
      'actionKind',
      'reason',
      'presets',
      'gaps',
    ]) ||
    v.schema !== 'stroq-codex-path-capture/1' ||
    !stamp(v.capturedAt) ||
    (v.binding !== null && !validateCodexPathGuardBinding(v.binding)) ||
    !exact(v.compatibility, ['status', 'version', 'platform', 'binarySha256']) ||
    !member(v.compatibility.status, ['supported', 'unsupported', 'unavailable']) ||
    !(
      v.compatibility.version === null ||
      (typeof v.compatibility.version === 'string' &&
        /^codex-cli [0-9A-Za-z.+-]{1,64}$/.test(v.compatibility.version))
    ) ||
    !member(v.compatibility.platform, ['darwin', 'unsupported']) ||
    !nullableHash(v.compatibility.binarySha256) ||
    !exact(v.baseline, ['kind', 'profile', 'network']) ||
    !member(v.baseline.kind, ['implicit', 'profile', 'legacy', 'unavailable']) ||
    !member(v.baseline.profile, ['workspace', 'read-only', 'full-access', 'custom', 'none']) ||
    !member(v.baseline.network, ['on', 'off', 'unknown']) ||
    (v.actionKind !== null && !kind(v.actionKind)) ||
    !(v.reason === null || member(v.reason, CODEX_PATH_GUARD_ERRORS)) ||
    !Array.isArray(v.presets) ||
    v.presets.length !== CODEX_PATH_GUARD_PRESETS.length ||
    !v.presets.every(
      (row: unknown, i: number) =>
        exact(row, ['id', 'target', 'declaration', 'canGuard', 'reason']) &&
        row.id === CODEX_PATH_GUARD_PRESETS[i] &&
        member(row.target, ['regular', 'absent', 'unsafe', 'unavailable']) &&
        member(row.declaration, ['deny', 'read', 'write', 'unknown']) &&
        typeof row.canGuard === 'boolean' &&
        (row.reason === null || member(row.reason, CODEX_PATH_GUARD_ERRORS)) &&
        (!row.canGuard ||
          (member(row.target, ['regular', 'absent']) &&
            member(row.declaration, ['read', 'write']) &&
            row.reason === null)),
    ) ||
    !Array.isArray(v.gaps) ||
    v.gaps.length > 32 ||
    !v.gaps.every((g: unknown) => member(g, CODEX_PATH_GUARD_GAPS)) ||
    new Set(v.gaps).size !== v.gaps.length
  )
    return false;
  return (
    !v.presets.some((p: { canGuard: boolean }) => p.canGuard) ||
    (v.binding !== null &&
      v.actionKind === 'profile-path-deny' &&
      v.reason === null &&
      v.compatibility.status === 'supported' &&
      v.compatibility.platform === 'darwin' &&
      v.compatibility.binarySha256 === v.binding.nativeBinarySha256)
  );
}
export function validateCodexPathGuardPreview(v: unknown): v is CodexPathGuardPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'operationId',
      'controlContextId',
      'operation',
      'kind',
      'presetId',
      'recordId',
      'recordRevision',
      'createdAt',
      'expiresAt',
      'binding',
      'beforeSha256',
      'afterSha256',
      'pathEffect',
      'filesystemEffect',
      'networkEffect',
      'sharedUserConfig',
      'retainsConfigurationCopies',
      'formattingPreserved',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-codex-path-preview/1' &&
    uuid(v.id) &&
    uuid(v.operationId) &&
    context(v.controlContextId) &&
    member(v.operation, ['guard', 'restore']) &&
    kind(v.kind) &&
    preset(v.presetId) &&
    uuid(v.recordId) &&
    (v.operation === 'guard' ? v.recordRevision === null : hash(v.recordRevision)) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.createdAt &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    (v.operation === 'guard'
      ? validateCodexPathGuardBinding(v.binding) &&
        v.binding.controlContextId === v.controlContextId
      : v.binding === null) &&
    nullableHash(v.beforeSha256) &&
    nullableHash(v.afterSha256) &&
    (v.operation === 'guard'
      ? hash(v.afterSha256) &&
        v.pathEffect === 'deny-read-write' &&
        v.filesystemEffect === 'deny-exact-path'
      : v.pathEffect === 'prior-settings' && v.filesystemEffect === 'prior-settings') &&
    v.networkEffect === 'preserved' &&
    v.sharedUserConfig === true &&
    v.retainsConfigurationCopies === true &&
    v.formattingPreserved === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexPathGuardRecord(v: unknown): v is CodexPathGuardRecord {
  return (
    exact(v, [
      'id',
      'operationId',
      'revision',
      'controlContextId',
      'kind',
      'presetId',
      'createdAt',
      'updatedAt',
      'operationStatus',
      'ownership',
      'standing',
      'originalSha256',
      'candidateSha256',
      'canRestore',
      'sharedUserConfig',
      'hostEnforcement',
    ]) &&
    uuid(v.id) &&
    uuid(v.operationId) &&
    hash(v.revision) &&
    context(v.controlContextId) &&
    kind(v.kind) &&
    preset(v.presetId) &&
    stamp(v.createdAt) &&
    stamp(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    member(v.operationStatus, ['unknown', 'guarded', 'restored']) &&
    member(v.ownership, ['current', 'superseded']) &&
    (!v.canRestore || v.ownership === 'current') &&
    member(v.standing, ['selected', 'changed', 'overridden', 'unavailable']) &&
    nullableHash(v.originalSha256) &&
    hash(v.candidateSha256) &&
    typeof v.canRestore === 'boolean' &&
    (!v.canRestore || v.operationStatus === 'guarded') &&
    v.sharedUserConfig === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexPathGuardState(v: unknown): v is CodexPathGuardState {
  return (
    exact(v, [
      'schema',
      'controlContextId',
      'generatedAt',
      'available',
      'history',
      'records',
      'error',
    ]) &&
    v.schema === 'stroq-codex-path-guard/1' &&
    (v.controlContextId === null || context(v.controlContextId)) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateCodexPathGuardRecord) &&
    new Set(v.records.map((r: CodexPathGuardRecord) => r.id)).size === v.records.length &&
    v.records.every((r: CodexPathGuardRecord) => r.controlContextId === v.controlContextId) &&
    (v.error === null || member(v.error, CODEX_PATH_GUARD_ERRORS)) &&
    (!v.available ||
      (v.controlContextId !== null && v.error === null && v.history !== 'unavailable'))
  );
}
export function validateCodexPathGuardReceipt(v: unknown): v is CodexPathGuardReceipt {
  return (
    exact(v, [
      'schema',
      'operationId',
      'controlContextId',
      'operation',
      'checkedAt',
      'writeConfirmed',
      'record',
    ]) &&
    v.schema === 'stroq-codex-path-receipt/1' &&
    uuid(v.operationId) &&
    context(v.controlContextId) &&
    member(v.operation, ['guard', 'restore', 'recheck']) &&
    stamp(v.checkedAt) &&
    typeof v.writeConfirmed === 'boolean' &&
    validateCodexPathGuardRecord(v.record) &&
    v.record.operationId === v.operationId &&
    v.record.controlContextId === v.controlContextId &&
    v.record.updatedAt <= v.checkedAt &&
    (!v.writeConfirmed || v.record.operationStatus !== 'unknown') &&
    (v.operation !== 'guard' || !v.writeConfirmed || v.record.operationStatus === 'guarded') &&
    (v.operation !== 'restore' || !v.writeConfirmed || v.record.operationStatus === 'restored')
  );
}
