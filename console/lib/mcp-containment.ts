export { validateMcpCallControlOverview } from './mcp-call-control-overview';
export {
  validateMcpCallControlInspection,
  validateMcpCallControlPreviewRequest,
  validateMcpCallControlPreview,
  validateMcpCallControlApplyRequest,
  validateMcpCallControlReceipt,
  validateMcpCallControlRecheckRequest,
  validateMcpCallControlRecheck,
  validateMcpCallControlSelection,
} from './mcp-call-controls';
import { closed, count, hash, member, stamp } from './local-guards';
export {
  MCP_TOOL_CONTRACT_LIMITATIONS,
  validateMcpToolContractState,
  validateMcpToolContractPreview,
  validateMcpToolContractReceipt,
} from './mcp-tool-contracts';
export const MCP_CONTAINMENT_LIMITATIONS = Object.freeze([
  'This action changes one registration in one supported JSON configuration source.',
  'Already connected servers and running processes are not stopped; restart or reconnect the client.',
  'Other scopes, plugins or account connectors may still provide a server with the same name.',
  'Complete original and edited configuration files are retained unencrypted in the private user recovery store, including any embedded credentials.',
  'Recovery files have no automatic expiry or deletion and are not a sandbox against another process running as your OS user.',
  'Review baselines and Stroq installation pins are not changed; configuration evidence does not establish host enforcement or credential revocation.',
] as const);
export const MCP_PROXY_LIMITATIONS = Object.freeze([
  'Strict mode withholds server messages the proxy cannot fully read and scan; it can interrupt incompatible servers. It does not sandbox the server or undo its actions.',
  'A policy ask becomes a blocked call because the proxy cannot prompt.',
  'The server receives only its declared environment variables plus process essentials; undeclared credentials may need configuration.',
  'The wrapper uses this Stroq policy and the selected workspace for path and secret-index context. The client still controls the server process working directory.',
  'Configuration and runtime fingerprints do not attest the Node binary, client environment or an already running connection.',
] as const);
export type McpContainmentChange = 'remove-registration' | 'protect-registration';
export type McpContainmentAction = McpContainmentChange | 'restore-registration';
export interface McpProxyConfiguration {
  mode: 'strict';
  toolApproval?: true;
  /** Workspace context accompanying the server-selected Stroq policy home. */
  policyWorkspaceId: string;
}
export type McpConfigSource =
  'claude-code-project' | 'claude-desktop-user' | 'cursor-project' | 'cursor-user';
export interface McpContainmentArtifact {
  id: string;
  kind: 'mcp';
  name: string;
  agent: 'claude-code' | 'claude-desktop' | 'cursor';
  scope: 'project' | 'user';
  sha256: string;
  digestFormat: 'mcp-entry-canonical-json/1';
  configSource: McpConfigSource;
}
export interface McpContainmentRecord {
  id: string;
  artifact: McpContainmentArtifact;
  change: McpContainmentChange;
  changedEntrySha256: string | null;
  proxy: (McpProxyConfiguration & { runtimeMatches: boolean | null }) | null;
  originWorkspaceId: string;
  phase: 'prepared' | 'removed' | 'configured' | 'restored' | 'recovery-required';
  createdAt: string;
  restoredAt: string | null;
  checkedAt: string;
  status:
    | 'removed'
    | 'configured'
    | 'reappeared'
    | 'restored'
    | 'changed'
    | 'config-missing'
    | 'recovery-required'
    | 'unverifiable';
  slot: 'absent' | 'same' | 'guarded' | 'different' | 'unverifiable';
  payload: 'match' | 'changed' | 'missing' | 'unverifiable';
  sourceMatchesChange: boolean | null;
  configSha256: string | null;
}
export interface McpContainmentState {
  schema: 'stroq-mcp-containment/2';
  source: 'local';
  generatedAt: string;
  workspaceId: string;
  available: boolean;
  reason:
    | null
    | 'context-unavailable'
    | 'platform-unsupported'
    | 'storage-unavailable'
    | 'runtime-unavailable';
  records: McpContainmentRecord[];
  gaps: { code: 'vault-unavailable' | 'vault-limit' | 'record-invalid' | 'storage-limit' }[];
  limitations: string[];
}
export interface McpContainmentPreview {
  schema: 'stroq-mcp-containment-preview/2';
  source: 'local';
  id: string;
  recordId: string;
  workspaceId: string;
  action: McpContainmentAction;
  proxy: McpProxyConfiguration | null;
  createdAt: string;
  expiresAt: string;
  artifact: McpContainmentArtifact;
  configSha256: string;
  candidateSha256: string;
  bytes: number;
  siblings: number;
  reformatted: boolean;
  effect: McpContainmentAction;
  evidence: 'configuration';
  hostEnforcement: false;
  requiresAcknowledgement: true;
  retention: { unencrypted: true; maxRecords: 32; maxBytes: 17825792; automaticDeletion: false };
  limitations: string[];
}
export interface McpContainmentReceipt {
  schema: 'stroq-mcp-containment-receipt/2';
  source: 'local';
  previewId: string;
  recordId: string;
  workspaceId: string;
  artifact: McpContainmentArtifact;
  action: McpContainmentAction;
  proxy: McpProxyConfiguration | null;
  status: 'removed' | 'configured' | 'restored';
  effect: McpContainmentAction;
  completedAt: string;
  configSha256: string;
  evidence: 'configuration';
  hostEnforcement: false;
  reviewBaselineChanged: false;
  requiresClientRestart: true;
}
export type McpContainmentPreviewRequest =
  | { action: 'remove-registration'; id: string; expectedSha256: string }
  | { action: 'protect-registration'; id: string; expectedSha256: string; toolApproval?: true }
  | { action: 'restore-registration'; recordId: string };
export interface McpContainmentApplyRequest {
  previewId: string;
  confirm: true;
  acknowledgeSessionLimits: true;
  acknowledgePrivateRetention: true;
  acknowledgeProxyEffects?: true;
  acknowledgeSharedPolicyContext?: true;
  acknowledgeToolContracts?: true;
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const identifier = (v: unknown, prefix: 'workspace' | 'item'): v is string =>
  typeof v === 'string' && new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(v);
const dense = (v: unknown[]): boolean =>
  Reflect.ownKeys(v).length === v.length + 1 &&
  Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
const limitations = (v: unknown): boolean =>
  Array.isArray(v) &&
  dense(v) &&
  v.length === MCP_CONTAINMENT_LIMITATIONS.length &&
  v.every((line, i) => line === MCP_CONTAINMENT_LIMITATIONS[i]);
const action = (v: unknown): v is McpContainmentAction =>
  member(v, ['remove-registration', 'protect-registration', 'restore-registration']);
const nullableHash = (v: unknown) => v === null || hash(v);
export function validateMcpProxyConfiguration(v: unknown): v is McpProxyConfiguration {
  return (
    closed(v, ['mode', 'policyWorkspaceId', 'toolApproval']) &&
    Object.hasOwn(v, 'mode') &&
    Object.hasOwn(v, 'policyWorkspaceId') &&
    (!Object.hasOwn(v, 'toolApproval') || v.toolApproval === true) &&
    v.mode === 'strict' &&
    identifier(v.policyWorkspaceId, 'workspace')
  );
}
function proxyForAction(v: Record<string, unknown>) {
  if (v.action === 'remove-registration') return v.proxy === null;
  if (v.proxy === null) return v.action === 'restore-registration';
  return (
    validateMcpProxyConfiguration(v.proxy) &&
    (v.action !== 'protect-registration' || v.proxy.policyWorkspaceId === v.workspaceId)
  );
}
function recordChange(v: Record<string, unknown>) {
  if (v.change === 'remove-registration')
    return (
      v.proxy === null &&
      v.changedEntrySha256 === null &&
      v.phase !== 'configured' &&
      v.status !== 'configured' &&
      v.slot !== 'guarded'
    );
  if (
    v.change !== 'protect-registration' ||
    !hash(v.changedEntrySha256) ||
    !validateMcpContainmentArtifact(v.artifact) ||
    v.changedEntrySha256 === v.artifact.sha256 ||
    !closed(v.proxy, ['mode', 'policyWorkspaceId', 'runtimeMatches', 'toolApproval']) ||
    !Object.hasOwn(v.proxy, 'runtimeMatches') ||
    !validateMcpProxyConfiguration(
      Object.fromEntries(Object.entries(v.proxy).filter(([key]) => key !== 'runtimeMatches')),
    )
  )
    return false;
  return (
    v.phase !== 'removed' &&
    v.status !== 'removed' &&
    v.proxy.mode === 'strict' &&
    v.proxy.policyWorkspaceId === v.originWorkspaceId &&
    (v.proxy.runtimeMatches === null || typeof v.proxy.runtimeMatches === 'boolean')
  );
}
export function validateMcpContainmentArtifact(v: unknown): v is McpContainmentArtifact {
  if (
    !exact(v, ['id', 'kind', 'name', 'agent', 'scope', 'sha256', 'digestFormat', 'configSource']) ||
    !identifier(v.id, 'item') ||
    v.kind !== 'mcp' ||
    !hash(v.sha256) ||
    v.digestFormat !== 'mcp-entry-canonical-json/1' ||
    typeof v.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(v.name) ||
    /(?:^|[ ._-])(?:secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ ._-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
      v.name,
    ) ||
    /(?:^|[ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[ .-])/.test(v.name)
  )
    return false;
  return (
    (v.configSource === 'claude-code-project' &&
      v.agent === 'claude-code' &&
      v.scope === 'project') ||
    (v.configSource === 'claude-desktop-user' &&
      v.agent === 'claude-desktop' &&
      v.scope === 'user') ||
    (v.configSource === 'cursor-project' && v.agent === 'cursor' && v.scope === 'project') ||
    (v.configSource === 'cursor-user' && v.agent === 'cursor' && v.scope === 'user')
  );
}
export function validateMcpContainmentRecord(v: unknown): v is McpContainmentRecord {
  if (
    !exact(v, [
      'id',
      'artifact',
      'change',
      'changedEntrySha256',
      'proxy',
      'originWorkspaceId',
      'phase',
      'createdAt',
      'restoredAt',
      'checkedAt',
      'status',
      'slot',
      'payload',
      'sourceMatchesChange',
      'configSha256',
    ]) ||
    !uuid(v.id) ||
    !validateMcpContainmentArtifact(v.artifact) ||
    !identifier(v.originWorkspaceId, 'workspace') ||
    !member(v.phase, ['prepared', 'removed', 'configured', 'restored', 'recovery-required']) ||
    !stamp(v.createdAt) ||
    !stamp(v.checkedAt) ||
    v.checkedAt < v.createdAt ||
    !(v.restoredAt === null || (stamp(v.restoredAt) && v.restoredAt >= v.createdAt)) ||
    !member(v.status, [
      'removed',
      'configured',
      'reappeared',
      'restored',
      'changed',
      'config-missing',
      'recovery-required',
      'unverifiable',
    ]) ||
    !member(v.slot, ['absent', 'same', 'guarded', 'different', 'unverifiable']) ||
    !member(v.payload, ['match', 'changed', 'missing', 'unverifiable']) ||
    !(v.sourceMatchesChange === null || typeof v.sourceMatchesChange === 'boolean') ||
    !nullableHash(v.configSha256) ||
    !recordChange(v)
  )
    return false;
  if (v.status === 'removed')
    return (
      v.phase === 'removed' && v.slot === 'absent' && v.payload === 'match' && hash(v.configSha256)
    );
  if (v.status === 'configured')
    return (
      v.phase === 'configured' &&
      v.slot === 'guarded' &&
      v.payload === 'match' &&
      v.restoredAt === null &&
      hash(v.configSha256)
    );
  if (v.status === 'restored')
    return (
      v.phase === 'restored' &&
      v.slot === 'same' &&
      v.payload === 'match' &&
      v.restoredAt !== null &&
      hash(v.configSha256)
    );
  return v.phase !== 'restored' || v.restoredAt !== null;
}
export function validateMcpContainment(v: unknown): v is McpContainmentState {
  return (
    exact(v, [
      'schema',
      'source',
      'generatedAt',
      'workspaceId',
      'available',
      'reason',
      'records',
      'gaps',
      'limitations',
    ]) &&
    v.schema === 'stroq-mcp-containment/2' &&
    v.source === 'local' &&
    stamp(v.generatedAt) &&
    identifier(v.workspaceId, 'workspace') &&
    typeof v.available === 'boolean' &&
    (v.available
      ? v.reason === null
      : member(v.reason, [
          'context-unavailable',
          'platform-unsupported',
          'storage-unavailable',
          'runtime-unavailable',
        ])) &&
    Array.isArray(v.records) &&
    dense(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateMcpContainmentRecord) &&
    new Set(v.records.map((r) => r.id)).size === v.records.length &&
    Array.isArray(v.gaps) &&
    dense(v.gaps) &&
    v.gaps.length <= 32 &&
    v.gaps.every(
      (g) =>
        exact(g, ['code']) &&
        member(g.code, ['vault-unavailable', 'vault-limit', 'record-invalid', 'storage-limit']),
    ) &&
    limitations(v.limitations)
  );
}
export const validateMcpContainmentState = validateMcpContainment;
export function validateMcpContainmentPreview(v: unknown): v is McpContainmentPreview {
  return (
    exact(v, [
      'schema',
      'source',
      'id',
      'recordId',
      'workspaceId',
      'action',
      'proxy',
      'createdAt',
      'expiresAt',
      'artifact',
      'configSha256',
      'candidateSha256',
      'bytes',
      'siblings',
      'reformatted',
      'effect',
      'evidence',
      'hostEnforcement',
      'requiresAcknowledgement',
      'retention',
      'limitations',
    ]) &&
    v.schema === 'stroq-mcp-containment-preview/2' &&
    v.source === 'local' &&
    uuid(v.id) &&
    uuid(v.recordId) &&
    identifier(v.workspaceId, 'workspace') &&
    action(v.action) &&
    proxyForAction(v) &&
    v.effect === v.action &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    v.expiresAt > v.createdAt &&
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 120000 &&
    validateMcpContainmentArtifact(v.artifact) &&
    hash(v.configSha256) &&
    hash(v.candidateSha256) &&
    v.configSha256 !== v.candidateSha256 &&
    count(v.bytes, 262144) &&
    v.bytes > 0 &&
    count(v.siblings, 512) &&
    typeof v.reformatted === 'boolean' &&
    v.evidence === 'configuration' &&
    v.hostEnforcement === false &&
    v.requiresAcknowledgement === true &&
    exact(v.retention, ['unencrypted', 'maxRecords', 'maxBytes', 'automaticDeletion']) &&
    v.retention.unencrypted === true &&
    v.retention.maxRecords === 32 &&
    v.retention.maxBytes === 17825792 &&
    v.retention.automaticDeletion === false &&
    limitations(v.limitations)
  );
}
export function validateMcpContainmentReceipt(v: unknown): v is McpContainmentReceipt {
  return (
    exact(v, [
      'schema',
      'source',
      'previewId',
      'recordId',
      'workspaceId',
      'artifact',
      'action',
      'proxy',
      'status',
      'effect',
      'completedAt',
      'configSha256',
      'evidence',
      'hostEnforcement',
      'reviewBaselineChanged',
      'requiresClientRestart',
    ]) &&
    v.schema === 'stroq-mcp-containment-receipt/2' &&
    v.source === 'local' &&
    uuid(v.previewId) &&
    uuid(v.recordId) &&
    identifier(v.workspaceId, 'workspace') &&
    validateMcpContainmentArtifact(v.artifact) &&
    action(v.action) &&
    proxyForAction(v) &&
    v.status ===
      (v.action === 'remove-registration'
        ? 'removed'
        : v.action === 'protect-registration'
          ? 'configured'
          : 'restored') &&
    v.effect === v.action &&
    stamp(v.completedAt) &&
    hash(v.configSha256) &&
    v.evidence === 'configuration' &&
    v.hostEnforcement === false &&
    v.reviewBaselineChanged === false &&
    v.requiresClientRestart === true
  );
}
