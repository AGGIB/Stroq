import { closed, count, hash, member, stamp, text } from './local-guards';
import {
  isSkillSourceId,
  skillSourceOf,
  type SkillAgent,
  type SkillSourceId,
} from './skill-sources';

export const INVENTORY_SIGNAL_LIMITATIONS = [
  'This is a local operator assessment of one captured skill revision and analysis, not a safety verdict.',
  'Only matching static-signal attention is acknowledged; original signals and independent change or coverage items remain visible.',
  'Files, review baselines, agent permissions, detector rules and trust settings are not changed.',
  'Changed source metadata, bytes or analysis make the previous decision historical; incomplete evidence cannot suppress attention.',
  'Decisions are private, unencrypted local records with bounded retention and no automatic eviction.',
] as const;
export type SignalDecision = 'accepted-risk' | 'false-positive' | 'reopened';
export const SIGNAL_REASONS = {
  'required-use': 'Needed for this workflow',
  'controlled-environment': 'Used in a controlled environment',
  'compensating-control': 'Compensating controls are in place',
  'benign-instruction': 'Expected benign instructions',
  'test-or-example': 'Test or example content',
  'incorrect-match': 'The rule does not describe this content',
  reconsidered: 'Reconsider this signal decision',
} as const;
export type SignalReason = keyof typeof SIGNAL_REASONS;
export const SIGNAL_REASON_DECISIONS: Record<SignalReason, SignalDecision> = {
  'required-use': 'accepted-risk',
  'controlled-environment': 'accepted-risk',
  'compensating-control': 'accepted-risk',
  'benign-instruction': 'false-positive',
  'test-or-example': 'false-positive',
  'incorrect-match': 'false-positive',
  reconsidered: 'reopened',
};
export interface InventorySignalBinding {
  workspaceId: string;
  itemId: string;
  agent: SkillAgent;
  skillSource: SkillSourceId;
  scope: 'project' | 'user';
  artifactSha256: string;
  sourceSha256: string;
  analysisSha256: string;
}
export interface InventorySignalRecord {
  id: string;
  binding: InventorySignalBinding;
  decision: SignalDecision;
  reason: SignalReason;
  recordedAt: string;
}
export type SignalStanding = 'unresolved' | 'applies' | 'stale' | 'reopened' | 'unavailable';
export interface InventorySignalProjection {
  standing: SignalStanding;
  record: InventorySignalRecord | null;
}
export interface InventorySignalArtifact {
  id: string;
  name: string;
  agent: SkillAgent;
  skillSource: SkillSourceId;
  scope: 'project' | 'user';
  sha256: string;
}
export interface InventorySignalState {
  schema: 'stroq-inventory-signal-state/1';
  source: 'local';
  generatedAt: string;
  workspaceId: string;
  artifact: InventorySignalArtifact;
  binding: InventorySignalBinding | null;
  eligible: boolean;
  reason: 'ready' | 'not-suspect' | 'incomplete' | 'store-unavailable';
  store: { status: 'missing' | 'ready' | 'unavailable'; revision: string | null };
  standing: SignalStanding;
  decision: InventorySignalRecord | null;
  history: { records: InventorySignalRecord[]; omitted: number };
  findings: number;
  limitations: readonly string[];
}
export interface InventorySignalPreviewRequest {
  id: string;
  expectedSha256: string;
  expectedDecisionId: string | null;
  decision: SignalDecision;
  reason: SignalReason;
}
export interface InventorySignalPreview {
  schema: 'stroq-inventory-signal-preview/1';
  source: 'local';
  workspaceId: string;
  previewId: string;
  expiresAt: string;
  decision: SignalDecision;
  reason: SignalReason;
  expectedDecisionId: string | null;
  state: InventorySignalState;
  limitations: readonly string[];
}
export interface InventorySignalReceipt {
  schema: 'stroq-inventory-signal-receipt/1';
  source: 'local';
  workspaceId: string;
  previewId: string;
  recordId: string;
  decision: SignalDecision;
  recordedAt: string;
  state: InventorySignalState;
  baselineChanged: false;
  permissionsChanged: false;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id = (v: unknown, prefix: string) =>
  typeof v === 'string' && new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(v);
const limitationList = (v: unknown) =>
  Array.isArray(v) &&
  v.length === INVENTORY_SIGNAL_LIMITATIONS.length &&
  v.every((s, i) => s === INVENTORY_SIGNAL_LIMITATIONS[i]);
export const signalReasonMatches = (decision: unknown, reason: unknown): boolean =>
  typeof reason === 'string' &&
  Object.hasOwn(SIGNAL_REASON_DECISIONS, reason) &&
  SIGNAL_REASON_DECISIONS[reason as SignalReason] === decision;
export function signalBindingKey(v: InventorySignalBinding) {
  return [
    v.workspaceId,
    v.itemId,
    v.agent,
    v.skillSource,
    v.scope,
    v.artifactSha256,
    v.sourceSha256,
    v.analysisSha256,
  ].join('\0');
}
export function validateInventorySignalBinding(v: unknown): v is InventorySignalBinding {
  return (
    exact(v, [
      'workspaceId',
      'itemId',
      'agent',
      'skillSource',
      'scope',
      'artifactSha256',
      'sourceSha256',
      'analysisSha256',
    ]) &&
    id(v.workspaceId, 'workspace') &&
    id(v.itemId, 'item') &&
    member(v.scope, ['project', 'user']) &&
    hash(v.artifactSha256) &&
    hash(v.sourceSha256) &&
    hash(v.analysisSha256) &&
    isSkillSourceId(v.skillSource) &&
    typeof v.agent === 'string' &&
    skillSourceOf({ kind: 'skill', agent: v.agent, skillSource: v.skillSource }) === v.skillSource
  );
}
export function validateInventorySignalRecord(v: unknown): v is InventorySignalRecord {
  return (
    exact(v, ['id', 'binding', 'decision', 'reason', 'recordedAt']) &&
    uuid(v.id) &&
    validateInventorySignalBinding(v.binding) &&
    signalReasonMatches(v.decision, v.reason) &&
    stamp(v.recordedAt)
  );
}
export function validateInventorySignalProjection(v: unknown): v is InventorySignalProjection {
  if (
    !exact(v, ['standing', 'record']) ||
    !member(v.standing, ['unresolved', 'applies', 'stale', 'reopened', 'unavailable'])
  )
    return false;
  if (v.standing === 'unresolved' || v.standing === 'unavailable') return v.record === null;
  if (!validateInventorySignalRecord(v.record)) return false;
  return v.standing === 'reopened'
    ? v.record.decision === 'reopened'
    : v.record.decision !== 'reopened';
}
function artifact(v: unknown): v is InventorySignalArtifact {
  return (
    exact(v, ['id', 'name', 'agent', 'skillSource', 'scope', 'sha256']) &&
    id(v.id, 'item') &&
    text(v.name, 80) &&
    member(v.scope, ['project', 'user']) &&
    hash(v.sha256) &&
    isSkillSourceId(v.skillSource) &&
    typeof v.agent === 'string' &&
    skillSourceOf({ kind: 'skill', agent: v.agent, skillSource: v.skillSource }) === v.skillSource
  );
}
export function signalBindingMatchesArtifact(
  b: InventorySignalBinding,
  a: InventorySignalArtifact,
  workspaceId: string,
) {
  return (
    b.workspaceId === workspaceId &&
    b.itemId === a.id &&
    b.agent === a.agent &&
    b.skillSource === a.skillSource &&
    b.scope === a.scope &&
    b.artifactSha256 === a.sha256
  );
}
export function validateInventorySignalState(v: unknown): v is InventorySignalState {
  if (
    !exact(v, [
      'schema',
      'source',
      'generatedAt',
      'workspaceId',
      'artifact',
      'binding',
      'eligible',
      'reason',
      'store',
      'standing',
      'decision',
      'history',
      'findings',
      'limitations',
    ]) ||
    v.schema !== 'stroq-inventory-signal-state/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !id(v.workspaceId, 'workspace') ||
    !artifact(v.artifact) ||
    !(v.binding === null || validateInventorySignalBinding(v.binding)) ||
    typeof v.eligible !== 'boolean' ||
    !member(v.reason, ['ready', 'not-suspect', 'incomplete', 'store-unavailable']) ||
    !exact(v.store, ['status', 'revision']) ||
    !member(v.store.status, ['missing', 'ready', 'unavailable']) ||
    !(v.store.revision === null || hash(v.store.revision)) ||
    !validateInventorySignalProjection({ standing: v.standing, record: v.decision }) ||
    !exact(v.history, ['records', 'omitted']) ||
    !Array.isArray(v.history.records) ||
    v.history.records.length > 32 ||
    Object.keys(v.history.records).length !== v.history.records.length ||
    !v.history.records.every(validateInventorySignalRecord) ||
    !count(v.history.omitted, 512) ||
    !count(v.findings, 100_000) ||
    !limitationList(v.limitations)
  )
    return false;
  const state = v as unknown as InventorySignalState;
  if (
    state.binding &&
    !signalBindingMatchesArtifact(state.binding, state.artifact, state.workspaceId)
  )
    return false;
  if ((state.store.status === 'ready') !== hash(state.store.revision)) return false;
  if (state.eligible !== (state.reason === 'ready')) return false;
  if (
    state.eligible &&
    (!state.binding || state.findings === 0 || state.store.status === 'unavailable')
  )
    return false;
  if (state.store.status === 'unavailable')
    return (
      state.standing === 'unavailable' &&
      state.reason === 'store-unavailable' &&
      state.decision === null &&
      state.history.records.length === 0 &&
      state.history.omitted === 0
    );
  if (state.reason === 'store-unavailable' || state.standing === 'unavailable') return false;
  if (
    state.store.status === 'missing' &&
    (state.decision !== null || state.history.records.length || state.history.omitted)
  )
    return false;
  if (
    state.decision &&
    (state.decision.binding.workspaceId !== state.workspaceId ||
      state.decision.binding.itemId !== state.artifact.id ||
      state.decision.binding.agent !== state.artifact.agent ||
      state.decision.binding.skillSource !== state.artifact.skillSource ||
      state.decision.binding.scope !== state.artifact.scope ||
      state.decision.recordedAt > state.generatedAt)
  )
    return false;
  if (
    state.standing === 'applies' &&
    (!state.eligible ||
      !state.binding ||
      !state.decision ||
      signalBindingKey(state.binding) !== signalBindingKey(state.decision.binding))
  )
    return false;
  const history = state.history.records;
  if (
    history.length + state.history.omitted > 512 ||
    (!history.length && state.history.omitted !== 0) ||
    Object.keys(history).length !== history.length
  )
    return false;
  if (
    new Set(history.map((r) => r.id)).size !== history.length ||
    history.some(
      (r, i) =>
        r.binding.workspaceId !== state.workspaceId ||
        r.binding.itemId !== state.artifact.id ||
        r.binding.agent !== state.artifact.agent ||
        r.binding.skillSource !== state.artifact.skillSource ||
        r.binding.scope !== state.artifact.scope ||
        r.recordedAt > state.generatedAt ||
        (i > 0 && r.recordedAt > history[i - 1]!.recordedAt),
    )
  )
    return false;
  return state.decision
    ? history[0]?.id === state.decision.id &&
        history[0].decision === state.decision.decision &&
        history[0].reason === state.decision.reason &&
        history[0].recordedAt === state.decision.recordedAt &&
        signalBindingKey(history[0].binding) === signalBindingKey(state.decision.binding)
    : history.length === 0;
}
export function validateInventorySignalPreview(v: unknown): v is InventorySignalPreview {
  if (
    !exact(v, [
      'schema',
      'source',
      'workspaceId',
      'previewId',
      'expiresAt',
      'decision',
      'reason',
      'expectedDecisionId',
      'state',
      'limitations',
    ]) ||
    v.schema !== 'stroq-inventory-signal-preview/1' ||
    v.source !== 'local' ||
    !id(v.workspaceId, 'workspace') ||
    !uuid(v.previewId) ||
    !stamp(v.expiresAt) ||
    !signalReasonMatches(v.decision, v.reason) ||
    !(v.expectedDecisionId === null || uuid(v.expectedDecisionId)) ||
    !validateInventorySignalState(v.state) ||
    !limitationList(v.limitations)
  )
    return false;
  const state = v.state;
  return (
    state.workspaceId === v.workspaceId &&
    state.binding !== null &&
    state.store.status !== 'unavailable' &&
    v.expectedDecisionId === (state.decision?.id ?? null) &&
    Date.parse(String(v.expiresAt)) >= Date.parse(state.generatedAt) &&
    Date.parse(String(v.expiresAt)) - Date.parse(state.generatedAt) <= 120000 &&
    (v.decision === 'reopened'
      ? state.decision !== null &&
        state.decision.decision !== 'reopened' &&
        state.reason !== 'incomplete'
      : state.eligible)
  );
}
export function validateInventorySignalReceipt(v: unknown): v is InventorySignalReceipt {
  if (
    !exact(v, [
      'schema',
      'source',
      'workspaceId',
      'previewId',
      'recordId',
      'decision',
      'recordedAt',
      'state',
      'baselineChanged',
      'permissionsChanged',
    ]) ||
    v.schema !== 'stroq-inventory-signal-receipt/1' ||
    v.source !== 'local' ||
    !uuid(v.previewId) ||
    !uuid(v.recordId) ||
    !stamp(v.recordedAt) ||
    !validateInventorySignalState(v.state) ||
    v.baselineChanged !== false ||
    v.permissionsChanged !== false
  )
    return false;
  const record = v.state.decision;
  return (
    v.workspaceId === v.state.workspaceId &&
    record !== null &&
    record.id === v.recordId &&
    record.decision === v.decision &&
    record.recordedAt === v.recordedAt &&
    (v.decision === 'reopened' ? v.state.standing === 'reopened' : v.state.standing === 'applies')
  );
}
