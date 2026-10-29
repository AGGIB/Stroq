import {
  MCP_GOVERNANCE_AGENTS,
  MCP_GOVERNANCE_SOURCES,
  MCP_GOVERNANCE_REASONS,
  MCP_GOVERNANCE_ERRORS,
  type McpGovernanceBinding,
  type McpGovernanceSourceRef,
  type McpGovernanceChoice,
  type McpGovernanceRecord,
  type McpGovernanceState,
} from './mcp-governance-types';
import {
  exact,
  uuid,
  context,
  workspace,
  choiceId,
  nullableHash,
  unique,
  validateMcpGovernancePairSummary,
  validateMcpGovernanceCurrent,
  hash,
  member,
  stamp,
  text,
} from './mcp-governance-validation';
export function validateMcpGovernanceBinding(v: unknown): v is McpGovernanceBinding {
  return (
    exact(v, [
      'contextId',
      'workspaceId',
      'runtimeSha256',
      'policyRawSha256',
      'policyFingerprint',
      'captureSha256',
    ]) &&
    context(v.contextId) &&
    workspace(v.workspaceId) &&
    hash(v.runtimeSha256) &&
    nullableHash(v.policyRawSha256) &&
    hash(v.policyFingerprint) &&
    hash(v.captureSha256)
  );
}
export function validateMcpGovernanceSourceRef(v: unknown): v is McpGovernanceSourceRef {
  return (
    exact(v, ['id', 'sha', 'agent', 'scope', 'label', 'sourceId']) &&
    typeof v.id === 'string' &&
    /^item-[a-f0-9]{24}$/.test(v.id) &&
    hash(v.sha) &&
    member(v.agent, MCP_GOVERNANCE_AGENTS) &&
    member(v.scope, ['project', 'user']) &&
    text(v.label, 200) &&
    member(v.sourceId, MCP_GOVERNANCE_SOURCES)
  );
}
export function validateMcpGovernanceChoice(v: unknown): v is McpGovernanceChoice {
  return (
    exact(v, [
      'id',
      'expectedSha256',
      'pair',
      'kind',
      'sourceRefs',
      'eligibility',
      'reason',
      'inAllowSet',
    ]) &&
    choiceId(v.id) &&
    hash(v.expectedSha256) &&
    (v.pair === null || validateMcpGovernancePairSummary(v.pair)) &&
    member(v.kind, ['registration', 'retained', 'both']) &&
    Array.isArray(v.sourceRefs) &&
    v.sourceRefs.length <= 8 &&
    v.sourceRefs.every(validateMcpGovernanceSourceRef) &&
    unique(v.sourceRefs, (s: McpGovernanceSourceRef) => s.id) &&
    member(v.eligibility, ['eligible', 'unsupported', 'ambiguous', 'unavailable']) &&
    (v.reason === null || member(v.reason, MCP_GOVERNANCE_REASONS)) &&
    typeof v.inAllowSet === 'boolean' &&
    (v.eligibility === 'eligible' ? v.reason === null && v.pair !== null : v.reason !== null) &&
    (v.pair !== null ||
      (v.kind === 'registration' &&
        v.eligibility !== 'eligible' &&
        v.sourceRefs.length > 0 &&
        v.reason !== null)) &&
    (v.kind === 'retained'
      ? v.inAllowSet && v.sourceRefs.length === 0
      : v.kind === 'both'
        ? v.inAllowSet && v.sourceRefs.length > 0
        : !v.inAllowSet && v.sourceRefs.length > 0)
  );
}
export function validateMcpGovernanceRecord(v: unknown): v is McpGovernanceRecord {
  return (
    exact(v, [
      'id',
      'operationId',
      'revision',
      'binding',
      'createdAt',
      'updatedAt',
      'status',
      'candidateRawSha256',
      'candidateFingerprint',
      'historyRef',
      'current',
      'hostEnforcement',
    ]) &&
    uuid(v.id) &&
    uuid(v.operationId) &&
    hash(v.revision) &&
    validateMcpGovernanceBinding(v.binding) &&
    stamp(v.createdAt) &&
    stamp(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    member(v.status, ['unknown', 'applied', 'not-applied']) &&
    hash(v.candidateRawSha256) &&
    hash(v.candidateFingerprint) &&
    (v.historyRef === null ||
      (exact(v.historyRef, ['entryId', 'recordSha256']) &&
        uuid(v.historyRef.entryId) &&
        hash(v.historyRef.recordSha256))) &&
    (v.status !== 'applied' || v.historyRef !== null) &&
    member(v.current, ['matches', 'changed', 'unavailable']) &&
    v.hostEnforcement === false
  );
}
export function validateMcpGovernanceState(v: unknown): v is McpGovernanceState {
  return (
    exact(v, [
      'schema',
      'generatedAt',
      'contextId',
      'workspaceId',
      'runtimeSha256',
      'policyRawSha256',
      'policyFingerprint',
      'current',
      'editable',
      'history',
      'records',
      'error',
    ]) &&
    v.schema === 'stroq-mcp-governance/1' &&
    stamp(v.generatedAt) &&
    (v.contextId === null || context(v.contextId)) &&
    workspace(v.workspaceId) &&
    nullableHash(v.runtimeSha256) &&
    nullableHash(v.policyRawSha256) &&
    nullableHash(v.policyFingerprint) &&
    validateMcpGovernanceCurrent(v.current) &&
    typeof v.editable === 'boolean' &&
    member(v.history, ['ready', 'missing', 'unavailable']) &&
    Array.isArray(v.records) &&
    v.records.length <= 32 &&
    v.records.every(validateMcpGovernanceRecord) &&
    unique(v.records, (r: McpGovernanceRecord) => r.id) &&
    v.records.every((r: McpGovernanceRecord) => r.binding.contextId === v.contextId) &&
    (v.error === null || member(v.error, MCP_GOVERNANCE_ERRORS)) &&
    (!v.editable ||
      (context(v.contextId) &&
        hash(v.runtimeSha256) &&
        hash(v.policyFingerprint) &&
        v.current.gate !== 'unavailable' &&
        v.history !== 'unavailable' &&
        v.error === null))
  );
}
