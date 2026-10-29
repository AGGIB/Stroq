import { closed, count, hash, member, stamp } from './local-guards';
import {
  CODEX_NETWORK_GUARD_ERRORS,
  CODEX_NETWORK_GUARD_GAPS,
  type CodexNetworkGuardBinding,
  type CodexNetworkGuardCapture,
  type CodexNetworkGuardSelection,
  type CodexNetworkGuardRestoreSelection,
  type CodexNetworkGuardRecheckSelection,
  type CodexNetworkGuardPreview,
  type CodexNetworkGuardRecord,
  type CodexNetworkGuardLayer,
  type CodexNetworkGuardState,
  type CodexNetworkGuardReceipt,
} from './codex-network-guard-types';
export * from './codex-network-guard-types';
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const context = (v: unknown): v is string =>
  typeof v === 'string' && /^codex-context-[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const kind = (v: unknown) =>
  member(v, [
    'profile-network-off',
    'profile-child',
    'legacy-network-off',
    'legacy-enable-workspace',
  ]);
const nullableHash = (v: unknown) => v === null || hash(v);
export function validateCodexNetworkGuardBinding(v: unknown): v is CodexNetworkGuardBinding {
  return (
    exact(v, [
      'controlContextId',
      'captureSha256',
      'configSha256',
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
    ]) &&
    context(v.controlContextId) &&
    hash(v.captureSha256) &&
    nullableHash(v.configSha256) &&
    hash(v.runtimeSha256) &&
    hash(v.nativeBinarySha256) &&
    hash(v.sourceGraphSha256)
  );
}
export function validateCodexNetworkGuardSelection(v: unknown): v is CodexNetworkGuardSelection {
  return (
    exact(v, ['operation', 'controlContextId', 'captureSha256']) &&
    v.operation === 'guard' &&
    context(v.controlContextId) &&
    hash(v.captureSha256)
  );
}
export function validateCodexNetworkGuardRestoreSelection(
  v: unknown,
): v is CodexNetworkGuardRestoreSelection {
  return (
    exact(v, ['operation', 'controlContextId', 'recordId', 'recordRevision']) &&
    v.operation === 'restore' &&
    context(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision)
  );
}
export function validateCodexNetworkGuardRecheckSelection(
  v: unknown,
): v is CodexNetworkGuardRecheckSelection {
  return (
    exact(v, ['controlContextId', 'recordId', 'recordRevision', 'operationId']) &&
    context(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision) &&
    uuid(v.operationId)
  );
}
export function validateCodexNetworkGuardCapture(v: unknown): v is CodexNetworkGuardCapture {
  if (
    !exact(v, [
      'schema',
      'capturedAt',
      'binding',
      'compatibility',
      'baseline',
      'actionKind',
      'filesystemEffect',
      'canGuard',
      'canCheck',
      'reason',
      'layers',
      'gaps',
    ]) ||
    v.schema !== 'stroq-codex-network-capture/1' ||
    !stamp(v.capturedAt) ||
    (v.binding !== null && !validateCodexNetworkGuardBinding(v.binding)) ||
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
    !member(v.filesystemEffect, ['unchanged', 'workspace-restricted', 'unavailable']) ||
    typeof v.canGuard !== 'boolean' ||
    typeof v.canCheck !== 'boolean' ||
    !(v.reason === null || member(v.reason, CODEX_NETWORK_GUARD_ERRORS)) ||
    !Array.isArray(v.layers) ||
    v.layers.length > 64 ||
    !v.layers.every(
      (l: unknown) =>
        exact(l, ['id', 'scope', 'status', 'effect']) &&
        /^config-source-[a-f0-9]{24}$/.test(l.id) &&
        member(l.scope, ['user', 'system', 'project', 'managed']) &&
        member(l.status, ['captured', 'absent', 'unsupported']) &&
        member(l.effect, [
          'none',
          'parent-edit',
          'selector-override',
          'network-override',
          'mixed',
          'unknown',
        ]),
    ) ||
    new Set(v.layers.map((l: CodexNetworkGuardLayer) => l.id)).size !== v.layers.length ||
    !Array.isArray(v.gaps) ||
    v.gaps.length > 32 ||
    !v.gaps.every((g: unknown) => member(g, CODEX_NETWORK_GUARD_GAPS)) ||
    new Set(v.gaps).size !== v.gaps.length
  )
    return false;
  if (
    v.canCheck &&
    (v.binding === null ||
      v.compatibility.status !== 'supported' ||
      v.compatibility.platform !== 'darwin' ||
      v.compatibility.binarySha256 !== v.binding.nativeBinarySha256 ||
      v.baseline.network !== 'off')
  )
    return false;
  return (
    !v.canGuard ||
    (v.binding !== null &&
      v.actionKind !== null &&
      v.reason === null &&
      v.compatibility.status === 'supported' &&
      v.compatibility.platform === 'darwin' &&
      v.compatibility.binarySha256 === v.binding.nativeBinarySha256 &&
      v.baseline.network === 'on' &&
      v.filesystemEffect !== 'unavailable')
  );
}
export function validateCodexNetworkGuardPreview(v: unknown): v is CodexNetworkGuardPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'operationId',
      'controlContextId',
      'operation',
      'kind',
      'recordId',
      'recordRevision',
      'createdAt',
      'expiresAt',
      'binding',
      'beforeSha256',
      'afterSha256',
      'filesystemEffect',
      'networkEffect',
      'retainsInactiveProfile',
      'sharedUserConfig',
      'retainsConfigurationCopies',
      'formattingPreserved',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-codex-network-preview/1' &&
    uuid(v.id) &&
    v.operationId === v.id &&
    context(v.controlContextId) &&
    member(v.operation, ['guard', 'restore']) &&
    kind(v.kind) &&
    uuid(v.recordId) &&
    (v.operation === 'guard' ? v.recordRevision === null : hash(v.recordRevision)) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.createdAt &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    (v.operation === 'guard'
      ? validateCodexNetworkGuardBinding(v.binding) &&
        v.binding.controlContextId === v.controlContextId
      : v.binding === null) &&
    nullableHash(v.beforeSha256) &&
    nullableHash(v.afterSha256) &&
    (v.operation === 'guard'
      ? hash(v.afterSha256) &&
        v.networkEffect === 'off' &&
        member(v.filesystemEffect, ['unchanged', 'workspace-restricted'])
      : v.networkEffect === 'prior-settings' && v.filesystemEffect === 'prior-settings') &&
    v.retainsInactiveProfile === (v.operation === 'restore' && v.kind === 'profile-child') &&
    v.sharedUserConfig === true &&
    v.retainsConfigurationCopies === true &&
    v.formattingPreserved === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexNetworkGuardRecord(v: unknown): v is CodexNetworkGuardRecord {
  return (
    exact(v, [
      'id',
      'operationId',
      'revision',
      'controlContextId',
      'kind',
      'createdAt',
      'updatedAt',
      'operationStatus',
      'ownership',
      'standing',
      'originalSha256',
      'candidateSha256',
      'canRestore',
      'retainsInactiveProfile',
      'sharedUserConfig',
      'hostEnforcement',
    ]) &&
    uuid(v.id) &&
    uuid(v.operationId) &&
    hash(v.revision) &&
    context(v.controlContextId) &&
    kind(v.kind) &&
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
    v.retainsInactiveProfile === (v.kind === 'profile-child' && v.operationStatus === 'restored') &&
    v.sharedUserConfig === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexNetworkGuardState(v: unknown): v is CodexNetworkGuardState {
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
    v.schema === 'stroq-codex-network-guard/1' &&
    (v.controlContextId === null || context(v.controlContextId)) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateCodexNetworkGuardRecord) &&
    new Set(v.records.map((r: CodexNetworkGuardRecord) => r.id)).size === v.records.length &&
    v.records.every((r: CodexNetworkGuardRecord) => r.controlContextId === v.controlContextId) &&
    (v.error === null || member(v.error, CODEX_NETWORK_GUARD_ERRORS)) &&
    (!v.available ||
      (v.controlContextId !== null && v.error === null && v.history !== 'unavailable'))
  );
}
export function validateCodexNetworkGuardReceipt(v: unknown): v is CodexNetworkGuardReceipt {
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
    v.schema === 'stroq-codex-network-receipt/1' &&
    uuid(v.operationId) &&
    context(v.controlContextId) &&
    member(v.operation, ['guard', 'restore', 'recheck']) &&
    stamp(v.checkedAt) &&
    typeof v.writeConfirmed === 'boolean' &&
    validateCodexNetworkGuardRecord(v.record) &&
    v.record.operationId === v.operationId &&
    v.record.controlContextId === v.controlContextId &&
    v.record.updatedAt <= v.checkedAt &&
    (!v.writeConfirmed || v.record.operationStatus !== 'unknown') &&
    (v.operation !== 'guard' || !v.writeConfirmed || v.record.operationStatus === 'guarded') &&
    (v.operation !== 'restore' || !v.writeConfirmed || v.record.operationStatus === 'restored')
  );
}
