import { closed, hash, member, stamp } from './local-guards';
import { validateMcpContainmentArtifact, type McpContainmentArtifact } from './mcp-containment';
export type McpCallControlAction = 'setup' | 'pause' | 'resume' | 'rebind-paused';
export interface McpCallControlSelection {
  id: string;
  expectedSha256: string;
}
export interface McpCallControlCurrent {
  controlId: string;
  invocationSha256: string;
  mode: 'paused' | 'enabled';
  eventId: string;
  at: string;
}
export interface McpCallControlInspection {
  schema: 'stroq-mcp-call-control/1';
  workspaceId: string;
  proxyWorkspaceId: string | null;
  contextId: string;
  checkedAt: string;
  artifact: McpContainmentArtifact;
  capability:
    'setup-required' | 'supported' | 'drifted' | 'ambiguous' | 'unsupported' | 'unavailable';
  reason:
    | null
    | 'unsupported-wrapper'
    | 'context-unavailable'
    | 'source-unavailable'
    | 'source-limit'
    | 'duplicate-control'
    | 'storage-unavailable'
    | 'runtime-unavailable'
    | 'invocation-drift';
  configuration: 'plain' | 'wrapper' | 'controlled';
  modes: { strict: boolean; toolApproval: boolean; cloak: boolean; pinned: boolean };
  controlId: string | null;
  invocationSha256: string | null;
  revision: string | null;
  current: McpCallControlCurrent | null;
  observation: {
    status: 'unobserved' | 'observed' | 'unavailable';
    at: string | null;
    eventId: string | null;
    invocationSha256: string | null;
    reason: null | 'paused' | 'unavailable' | 'busy';
  };
  hostEnforcement: false;
}
export interface McpCallControlSourcePreviewRequest extends McpCallControlSelection {
  expectedContextId: string;
  action: McpCallControlAction;
  expectedRevision: string | null;
  expectedEventId: string | null;
}
export interface McpCallControlRetainedPreviewRequest {
  retainedSetupId: string;
  expectedContextId: string;
  action: 'pause';
  expectedRevision: string;
  expectedEventId: string;
}
export type McpCallControlPreviewRequest =
  McpCallControlSourcePreviewRequest | McpCallControlRetainedPreviewRequest;
export interface McpCallControlPreview {
  schema: 'stroq-mcp-call-control-preview/1';
  id: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  proxyWorkspaceId: string;
  contextId: string;
  action: McpCallControlAction;
  artifact: McpContainmentArtifact;
  controlId: string;
  invocationSha256: string;
  expectedRevision: string | null;
  expectedEventId: string | null;
  changesConfiguration: boolean;
  requiresReconnect: boolean;
  sharedUserScope: boolean;
  retention: {
    maxControls: 64;
    maxEvents: 512;
    maxBytes: 1048576;
    setupMaxRecords: 32;
    setupMaxBytes: 17825792;
  };
  hostEnforcement: false;
}
export interface McpCallControlApplyRequest {
  previewId: string;
  confirm: true;
  acknowledgeScope: true;
  acknowledgeWeakening: true;
  acknowledgeSharedScope: true;
  acknowledgeLocalStorage: true;
}
export interface McpCallControlReceipt {
  schema: 'stroq-mcp-call-control-receipt/1';
  previewId: string;
  operationId: string;
  workspaceId: string;
  proxyWorkspaceId: string;
  contextId: string;
  action: McpCallControlAction;
  artifact: McpContainmentArtifact;
  controlId: string;
  invocationSha256: string;
  expectedEventId: string | null;
  completedAt: string;
  authority: 'confirmed' | 'unconfirmed';
  configuration: 'unchanged' | 'confirmed' | 'unconfirmed';
  revision: string | null;
  eventId: string | null;
  requiresReconnect: boolean;
  hostEnforcement: false;
}
export interface McpCallControlRecheckRequest extends McpCallControlSelection {
  expectedContextId: string;
  operationId: string;
  action: McpCallControlAction;
  controlId: string;
  invocationSha256: string;
  expectedEventId: string | null;
}
export interface McpCallControlRecheck {
  schema: 'stroq-mcp-call-control-recheck/1';
  checkedAt: string;
  workspaceId: string;
  contextId: string;
  operationId: string;
  action: McpCallControlAction;
  controlId: string;
  invocationSha256: string;
  authority: 'recorded' | 'absent' | 'unavailable';
  recordedEventId: string | null;
  configuration: 'unchanged' | 'confirmed' | 'unconfirmed' | 'unavailable';
  currentEventId: string | null;
  currentMode: 'paused' | 'enabled' | null;
  hostEnforcement: false;
}
export const MCP_CALL_CONTROL_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'mcp-call-control-invalid': 'The call-control request could not be verified.',
  'mcp-call-control-stale':
    'The registration, profile or decision changed. Refresh and review again.',
  'mcp-call-control-unavailable':
    'Call-control authority is unavailable. No enabled state is inferred.',
  'mcp-call-control-limit':
    'Call-control storage or preview capacity was reached. Retained records were kept.',
  'mcp-call-control-busy': 'Call-control storage is busy. Recheck before another action.',
  'mcp-call-control-write-unconfirmed':
    'The write could not be confirmed. Recheck this exact operation.',
  'mcp-call-control-unsupported': 'This exact registration cannot use call control.',
});
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const context = (v: unknown) => typeof v === 'string' && /^context-[a-f0-9]{64}$/.test(v);
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const item = (v: unknown) => typeof v === 'string' && /^item-[a-f0-9]{24}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v),
  nullableUuid = (v: unknown) => v === null || uuid(v);
const action = (v: unknown) => member(v, ['setup', 'pause', 'resume', 'rebind-paused']);
const selection = (v: Record<string, unknown>) => item(v.id) && hash(v.expectedSha256);
export const validateMcpCallControlSelection = (v: unknown): v is McpCallControlSelection =>
  exact(v, ['id', 'expectedSha256']) && selection(v);
export const validateMcpCallControlPreviewRequest = (
  v: unknown,
): v is McpCallControlPreviewRequest =>
  (exact(v, [
    'retainedSetupId',
    'expectedContextId',
    'action',
    'expectedRevision',
    'expectedEventId',
  ]) &&
    uuid(v.retainedSetupId) &&
    context(v.expectedContextId) &&
    v.action === 'pause' &&
    hash(v.expectedRevision) &&
    uuid(v.expectedEventId)) ||
  (exact(v, [
    'id',
    'expectedSha256',
    'expectedContextId',
    'action',
    'expectedRevision',
    'expectedEventId',
  ]) &&
    selection(v) &&
    context(v.expectedContextId) &&
    action(v.action) &&
    nullableHash(v.expectedRevision) &&
    nullableUuid(v.expectedEventId) &&
    (v.action !== 'setup' || v.expectedEventId === null));
export const validateMcpCallControlApplyRequest = (v: unknown): v is McpCallControlApplyRequest =>
  exact(v, [
    'previewId',
    'confirm',
    'acknowledgeScope',
    'acknowledgeWeakening',
    'acknowledgeSharedScope',
    'acknowledgeLocalStorage',
  ]) &&
  uuid(v.previewId) &&
  [
    'confirm',
    'acknowledgeScope',
    'acknowledgeWeakening',
    'acknowledgeSharedScope',
    'acknowledgeLocalStorage',
  ].every((k) => v[k] === true);
export const validateMcpCallControlRecheckRequest = (
  v: unknown,
): v is McpCallControlRecheckRequest =>
  exact(v, [
    'id',
    'expectedSha256',
    'expectedContextId',
    'operationId',
    'action',
    'controlId',
    'invocationSha256',
    'expectedEventId',
  ]) &&
  selection(v) &&
  context(v.expectedContextId) &&
  uuid(v.operationId) &&
  action(v.action) &&
  uuid(v.controlId) &&
  hash(v.invocationSha256) &&
  nullableUuid(v.expectedEventId);
const current = (v: unknown) =>
  exact(v, ['controlId', 'invocationSha256', 'mode', 'eventId', 'at']) &&
  uuid(v.controlId) &&
  hash(v.invocationSha256) &&
  member(v.mode, ['paused', 'enabled']) &&
  uuid(v.eventId) &&
  stamp(v.at);
const base = (v: Record<string, unknown>) =>
  workspace(v.workspaceId) && context(v.contextId) && v.hostEnforcement === false;
export function validateMcpCallControlInspection(v: unknown): v is McpCallControlInspection {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'proxyWorkspaceId',
      'contextId',
      'checkedAt',
      'artifact',
      'capability',
      'reason',
      'configuration',
      'modes',
      'controlId',
      'invocationSha256',
      'revision',
      'current',
      'observation',
      'hostEnforcement',
    ]) ||
    v.schema !== 'stroq-mcp-call-control/1' ||
    !base(v) ||
    !stamp(v.checkedAt) ||
    (v.proxyWorkspaceId !== null && !workspace(v.proxyWorkspaceId)) ||
    !validateMcpContainmentArtifact(v.artifact)
  )
    return false;
  if (
    !member(v.capability, [
      'setup-required',
      'supported',
      'drifted',
      'ambiguous',
      'unsupported',
      'unavailable',
    ]) ||
    !(
      v.reason === null ||
      member(v.reason, [
        'unsupported-wrapper',
        'context-unavailable',
        'source-unavailable',
        'source-limit',
        'duplicate-control',
        'storage-unavailable',
        'runtime-unavailable',
        'invocation-drift',
      ])
    ) ||
    !member(v.configuration, ['plain', 'wrapper', 'controlled'])
  )
    return false;
  if (
    !exact(v.modes, ['strict', 'toolApproval', 'cloak', 'pinned']) ||
    Object.values(v.modes).some((x) => typeof x !== 'boolean') ||
    (v.modes.toolApproval === true && (v.modes.strict !== true || v.modes.cloak === true)) ||
    !nullableUuid(v.controlId) ||
    !nullableHash(v.invocationSha256) ||
    !nullableHash(v.revision) ||
    (v.current !== null && !current(v.current))
  )
    return false;
  if (
    v.capability === 'supported' &&
    (!current(v.current) ||
      (v.current as McpCallControlCurrent).controlId !== v.controlId ||
      (v.current as McpCallControlCurrent).invocationSha256 !== v.invocationSha256 ||
      v.configuration !== 'controlled' ||
      v.reason !== null)
  )
    return false;
  if (v.current !== null && (v.current as McpCallControlCurrent).controlId !== v.controlId)
    return false;
  const o = v.observation;
  if (
    !exact(o, ['status', 'at', 'eventId', 'invocationSha256', 'reason']) ||
    !member(o.status, ['unobserved', 'observed', 'unavailable'])
  )
    return false;
  if (o.status === 'observed')
    return (
      stamp(o.at) &&
      uuid(o.eventId) &&
      hash(o.invocationSha256) &&
      member(o.reason, ['paused', 'unavailable', 'busy']) &&
      v.current !== null &&
      (o.reason !== 'paused' || (v.current as McpCallControlCurrent).mode === 'paused') &&
      o.eventId === (v.current as McpCallControlCurrent).eventId &&
      o.invocationSha256 === (v.current as McpCallControlCurrent).invocationSha256
    );
  return o.at === null && o.eventId === null && o.invocationSha256 === null && o.reason === null;
}
export function validateMcpCallControlPreview(v: unknown): v is McpCallControlPreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'operationId',
      'createdAt',
      'expiresAt',
      'workspaceId',
      'proxyWorkspaceId',
      'contextId',
      'action',
      'artifact',
      'controlId',
      'invocationSha256',
      'expectedRevision',
      'expectedEventId',
      'changesConfiguration',
      'requiresReconnect',
      'sharedUserScope',
      'retention',
      'hostEnforcement',
    ]) ||
    v.schema !== 'stroq-mcp-call-control-preview/1' ||
    !base(v) ||
    !uuid(v.id) ||
    !uuid(v.operationId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    !action(v.action) ||
    !workspace(v.proxyWorkspaceId) ||
    !validateMcpContainmentArtifact(v.artifact) ||
    !uuid(v.controlId) ||
    !hash(v.invocationSha256) ||
    !nullableHash(v.expectedRevision) ||
    !nullableUuid(v.expectedEventId)
  )
    return false;
  if (
    Date.parse(v.expiresAt as string) <= Date.parse(v.createdAt as string) ||
    Date.parse(v.expiresAt as string) - Date.parse(v.createdAt as string) > 120000 ||
    v.sharedUserScope !== ((v.artifact as McpContainmentArtifact).scope === 'user')
  )
    return false;
  if (
    v.changesConfiguration !== (v.action === 'setup') ||
    v.requiresReconnect !== v.changesConfiguration ||
    typeof v.sharedUserScope !== 'boolean'
  )
    return false;
  return (
    exact(v.retention, [
      'maxControls',
      'maxEvents',
      'maxBytes',
      'setupMaxRecords',
      'setupMaxBytes',
    ]) &&
    v.retention.maxControls === 64 &&
    v.retention.maxEvents === 512 &&
    v.retention.maxBytes === 1048576 &&
    v.retention.setupMaxRecords === 32 &&
    v.retention.setupMaxBytes === 17825792
  );
}
export function validateMcpCallControlReceipt(v: unknown): v is McpCallControlReceipt {
  return (
    exact(v, [
      'schema',
      'previewId',
      'operationId',
      'workspaceId',
      'proxyWorkspaceId',
      'contextId',
      'action',
      'artifact',
      'controlId',
      'invocationSha256',
      'expectedEventId',
      'completedAt',
      'authority',
      'configuration',
      'revision',
      'eventId',
      'requiresReconnect',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-mcp-call-control-receipt/1' &&
    base(v) &&
    uuid(v.previewId) &&
    uuid(v.operationId) &&
    action(v.action) &&
    workspace(v.proxyWorkspaceId) &&
    validateMcpContainmentArtifact(v.artifact) &&
    uuid(v.controlId) &&
    hash(v.invocationSha256) &&
    nullableUuid(v.expectedEventId) &&
    stamp(v.completedAt) &&
    member(v.authority, ['confirmed', 'unconfirmed']) &&
    member(v.configuration, ['unchanged', 'confirmed', 'unconfirmed']) &&
    nullableHash(v.revision) &&
    nullableUuid(v.eventId) &&
    v.requiresReconnect === (v.action === 'setup') &&
    (v.action === 'setup' || v.configuration === 'unchanged') &&
    (v.action !== 'setup' || v.configuration !== 'unchanged') &&
    (v.authority !== 'confirmed' || (v.eventId === v.operationId && hash(v.revision))) &&
    (v.authority !== 'unconfirmed' || (v.eventId === null && v.revision === null))
  );
}
export function validateMcpCallControlRecheck(v: unknown): v is McpCallControlRecheck {
  return (
    exact(v, [
      'schema',
      'checkedAt',
      'workspaceId',
      'contextId',
      'operationId',
      'action',
      'controlId',
      'invocationSha256',
      'authority',
      'recordedEventId',
      'configuration',
      'currentEventId',
      'currentMode',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-mcp-call-control-recheck/1' &&
    base(v) &&
    stamp(v.checkedAt) &&
    uuid(v.operationId) &&
    action(v.action) &&
    uuid(v.controlId) &&
    hash(v.invocationSha256) &&
    member(v.authority, ['recorded', 'absent', 'unavailable']) &&
    (v.authority === 'recorded'
      ? v.recordedEventId === v.operationId
      : v.recordedEventId === null) &&
    member(v.configuration, ['unchanged', 'confirmed', 'unconfirmed', 'unavailable']) &&
    (v.action === 'setup' ? v.configuration !== 'unchanged' : v.configuration === 'unchanged') &&
    nullableUuid(v.currentEventId) &&
    (v.currentMode === null || member(v.currentMode, ['paused', 'enabled'])) &&
    (v.currentEventId === null) === (v.currentMode === null) &&
    (v.authority !== 'unavailable' || v.currentEventId === null) &&
    (v.authority !== 'absent' || v.currentEventId !== v.operationId) &&
    (v.currentEventId !== v.operationId ||
      (v.authority === 'recorded' &&
        v.currentMode === (v.action === 'resume' ? 'enabled' : 'paused')))
  );
}
