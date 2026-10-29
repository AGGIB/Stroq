import { closed, count, hash, member, stamp, text } from './local-guards';
import { validateSkillLocation, type SkillLocation } from './skill-location';
export const CODEX_SKILL_CONTROL_ERRORS = [
  'codex-control-unavailable',
  'codex-control-stale',
  'codex-control-incomplete',
  'codex-control-already-disabled',
  'codex-control-unsupported',
  'codex-control-conflict',
  'codex-control-store-unavailable',
  'codex-control-store-full',
  'codex-control-recovery-required',
  'codex-control-write-unconfirmed',
  'codex-control-runtime-changed',
  'codex-control-consent-required',
  'codex-control-busy',
] as const;
export type CodexSkillControlError = (typeof CODEX_SKILL_CONTROL_ERRORS)[number];
export interface CodexSkillControlSelection {
  operation: 'disable';
  controlContextId: string;
  sourceId: string;
  candidateId: string;
  expectedEntrypointSha256: string;
  expectedConfigSha256: string | null;
  expectedRuntimeSha256: string;
}
export interface CodexSkillControlRestoreSelection {
  operation: 'restore';
  controlContextId: string;
  recordId: string;
  recordRevision: string;
}
export interface CodexSkillControlRecord {
  id: string;
  operationId: string;
  revision: string;
  controlContextId: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  location: SkillLocation;
  operationStatus: 'prepared' | 'disabled' | 'restoring' | 'restored' | 'unknown';
  standing: 'disabled' | 'enabled-or-unspecified' | 'changed' | 'unavailable';
  originalSha256: string | null;
  candidateSha256: string;
  canRestore: boolean;
  sharedUserConfig: true;
  hostEnforcement: false;
}
export interface CodexSkillControlPreview {
  schema: 'stroq-codex-skill-control-preview/1';
  id: string;
  operationId: string;
  binding: {
    controlContextId: string;
    sourceId: string;
    candidateId: string;
    entrypointSha256: string;
    runtimeSha256: string;
  } | null;
  controlContextId: string;
  operation: 'disable' | 'restore';
  recordId: string;
  recordRevision: string | null;
  createdAt: string;
  expiresAt: string;
  name: string;
  location: SkillLocation;
  beforeSha256: string | null;
  afterSha256: string | null;
  sameNameCopies: number;
  sharedUserConfig: true;
  retainsConfigurationCopies: true;
  formattingPreserved: true;
  hostEnforcement: false;
}
export interface CodexSkillControlState {
  schema: 'stroq-codex-skill-controls/1';
  controlContextId: string | null;
  generatedAt: string;
  available: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  records: CodexSkillControlRecord[];
  error: CodexSkillControlError | null;
}
export interface CodexSkillControlReceipt {
  schema: 'stroq-codex-skill-control-receipt/1';
  operationId: string;
  controlContextId: string;
  operation: 'disable' | 'restore' | 'recheck';
  checkedAt: string;
  writeConfirmed: boolean;
  record: CodexSkillControlRecord;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
export const isCodexControlContext = (v: unknown): v is string =>
  typeof v === 'string' && /^codex-context-[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const source = (v: unknown) => typeof v === 'string' && /^source-[a-f0-9]{24}$/.test(v);
const candidate = (v: unknown) => typeof v === 'string' && /^candidate-[a-f0-9]{24}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v);
export function validateCodexSkillControlSelection(v: unknown): v is CodexSkillControlSelection {
  return (
    exact(v, [
      'operation',
      'controlContextId',
      'sourceId',
      'candidateId',
      'expectedEntrypointSha256',
      'expectedConfigSha256',
      'expectedRuntimeSha256',
    ]) &&
    v.operation === 'disable' &&
    isCodexControlContext(v.controlContextId) &&
    source(v.sourceId) &&
    candidate(v.candidateId) &&
    hash(v.expectedEntrypointSha256) &&
    nullableHash(v.expectedConfigSha256) &&
    hash(v.expectedRuntimeSha256)
  );
}
export function validateCodexSkillControlRestoreSelection(
  v: unknown,
): v is CodexSkillControlRestoreSelection {
  return (
    exact(v, ['operation', 'controlContextId', 'recordId', 'recordRevision']) &&
    v.operation === 'restore' &&
    isCodexControlContext(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision)
  );
}
export function validateCodexSkillControlRecord(v: unknown): v is CodexSkillControlRecord {
  return (
    exact(v, [
      'id',
      'operationId',
      'revision',
      'controlContextId',
      'createdAt',
      'updatedAt',
      'name',
      'location',
      'operationStatus',
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
    isCodexControlContext(v.controlContextId) &&
    stamp(v.createdAt) &&
    stamp(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    text(v.name, 200) &&
    validateSkillLocation(v.location) &&
    member(v.operationStatus, ['prepared', 'disabled', 'restoring', 'restored', 'unknown']) &&
    member(v.standing, ['disabled', 'enabled-or-unspecified', 'changed', 'unavailable']) &&
    nullableHash(v.originalSha256) &&
    hash(v.candidateSha256) &&
    typeof v.canRestore === 'boolean' &&
    (!v.canRestore || v.operationStatus === 'disabled') &&
    v.sharedUserConfig === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexSkillControlPreview(v: unknown): v is CodexSkillControlPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'operationId',
      'binding',
      'controlContextId',
      'operation',
      'recordId',
      'recordRevision',
      'createdAt',
      'expiresAt',
      'name',
      'location',
      'beforeSha256',
      'afterSha256',
      'sameNameCopies',
      'sharedUserConfig',
      'retainsConfigurationCopies',
      'formattingPreserved',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-codex-skill-control-preview/1' &&
    uuid(v.id) &&
    v.operationId === v.id &&
    validPreviewBinding(v) &&
    isCodexControlContext(v.controlContextId) &&
    member(v.operation, ['disable', 'restore']) &&
    uuid(v.recordId) &&
    (v.operation === 'disable' ? v.recordRevision === null : hash(v.recordRevision)) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.createdAt &&
    Date.parse(String(v.expiresAt)) - Date.parse(String(v.createdAt)) <= 120000 &&
    text(v.name, 200) &&
    validateSkillLocation(v.location) &&
    nullableHash(v.beforeSha256) &&
    nullableHash(v.afterSha256) &&
    (v.operation !== 'disable' || hash(v.afterSha256)) &&
    count(v.sameNameCopies, 128) &&
    v.sharedUserConfig === true &&
    v.retainsConfigurationCopies === true &&
    v.formattingPreserved === true &&
    v.hostEnforcement === false
  );
}
export function validateCodexSkillControlState(v: unknown): v is CodexSkillControlState {
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
    v.schema === 'stroq-codex-skill-controls/1' &&
    (v.controlContextId === null || isCodexControlContext(v.controlContextId)) &&
    stamp(v.generatedAt) &&
    typeof v.available === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateCodexSkillControlRecord) &&
    new Set(v.records.map((r) => r.id)).size === v.records.length &&
    v.records.every((r) => r.controlContextId === v.controlContextId) &&
    (v.error === null || member(v.error, CODEX_SKILL_CONTROL_ERRORS)) &&
    (!v.available ||
      (v.controlContextId !== null && v.error === null && v.history !== 'unavailable'))
  );
}
export function validateCodexSkillControlReceipt(v: unknown): v is CodexSkillControlReceipt {
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
    v.schema === 'stroq-codex-skill-control-receipt/1' &&
    uuid(v.operationId) &&
    isCodexControlContext(v.controlContextId) &&
    member(v.operation, ['disable', 'restore', 'recheck']) &&
    stamp(v.checkedAt) &&
    typeof v.writeConfirmed === 'boolean' &&
    validateCodexSkillControlRecord(v.record) &&
    v.operationId === v.record.operationId &&
    v.record.controlContextId === v.controlContextId &&
    v.record.updatedAt <= v.checkedAt &&
    (!v.writeConfirmed || ['disabled', 'restored'].includes(v.record.operationStatus))
  );
}

function validPreviewBinding(v: Record<string, unknown>) {
  const b = v.binding;
  return v.operation === 'restore'
    ? b === null
    : exact(b, [
        'controlContextId',
        'sourceId',
        'candidateId',
        'entrypointSha256',
        'runtimeSha256',
      ]) &&
        b.controlContextId === v.controlContextId &&
        source(b.sourceId) &&
        candidate(b.candidateId) &&
        hash(b.entrypointSha256) &&
        hash(b.runtimeSha256);
}
export interface CodexSkillControlRecheckSelection {
  controlContextId: string;
  recordId: string;
  recordRevision: string;
  operationId: string;
}
export function validateCodexSkillControlRecheckSelection(
  v: unknown,
): v is CodexSkillControlRecheckSelection {
  return (
    exact(v, ['controlContextId', 'recordId', 'recordRevision', 'operationId']) &&
    isCodexControlContext(v.controlContextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision) &&
    uuid(v.operationId)
  );
}
