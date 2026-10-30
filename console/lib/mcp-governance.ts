import {
  validateMcpGovernanceBinding,
  validateMcpGovernanceChoice,
  validateMcpGovernanceRecord,
} from './mcp-governance-state';
export {
  validateMcpGovernanceBinding,
  validateMcpGovernanceChoice,
  validateMcpGovernanceSourceRef,
  validateMcpGovernanceRecord,
  validateMcpGovernanceState,
} from './mcp-governance-state';
import {
  MCP_GOVERNANCE_GAPS,
  MCP_GOVERNANCE_AGENTS,
  MCP_GOVERNANCE_SOURCES,
  MCP_GOVERNANCE_ERRORS,
  MCP_GOVERNANCE_GATE_CASES,
  type McpGovernanceBinding,
  type McpGovernanceChoice,
  type McpGovernanceCapture,
  type McpGovernanceSelection,
  type McpGovernancePreviewRequest,
  type McpGovernancePreview,
  type McpGovernanceApplyRequest,
  type McpGovernanceReceipt,
  type McpGovernanceRecheckRequest,
  type McpGovernanceRecheck,
  type McpGovernanceGateChecks,
} from './mcp-governance-types';
import {
  exact,
  uuid,
  context,
  workspace,
  choiceId,
  unique,
  pairKey,
  samePairs,
  validateMcpGovernanceCurrent,
  validateMcpGovernanceDiff,
  governanceCheck,
  governanceSimulation,
  count,
  hash,
  member,
  stamp,
} from './mcp-governance-validation';
import { validatePolicyCaseRegressions } from './policy-cases';
export * from './mcp-governance-types';
export {
  validateMcpGovernancePairSummary,
  validateMcpGovernanceCurrent,
  validateMcpGovernanceDiff,
  validateMcpGovernanceRestoreDiff,
} from './mcp-governance-validation';
export function validateMcpGovernanceCapture(v: unknown): v is McpGovernanceCapture {
  return (
    exact(v, [
      'schema',
      'capturedAt',
      'captureId',
      'binding',
      'current',
      'compatibility',
      'choices',
      'gaps',
      'canPreview',
      'reason',
    ]) &&
    v.schema === 'stroq-mcp-governance-capture/1' &&
    stamp(v.capturedAt) &&
    (v.captureId === null || uuid(v.captureId)) &&
    (v.binding === null || validateMcpGovernanceBinding(v.binding)) &&
    validateMcpGovernanceCurrent(v.current) &&
    exact(v.compatibility, ['status', 'format', 'olderRuntimes']) &&
    member(v.compatibility.status, ['supported', 'unsupported', 'unavailable']) &&
    v.compatibility.format === 2 &&
    v.compatibility.olderRuntimes === 'reject-v2' &&
    Array.isArray(v.choices) &&
    v.choices.length <= 192 &&
    v.choices.every(validateMcpGovernanceChoice) &&
    unique(v.choices, (c: McpGovernanceChoice) => c.id) &&
    unique(
      v.choices.filter((c: McpGovernanceChoice) => c.pair !== null),
      (c: McpGovernanceChoice) => pairKey(c.pair!),
    ) &&
    Array.isArray(v.gaps) &&
    v.gaps.length <= 64 &&
    v.gaps.every(
      (g: unknown) =>
        exact(g, ['code', 'agent', 'scope', 'sourceId']) &&
        member(g.code, MCP_GOVERNANCE_GAPS) &&
        (g.agent === null || member(g.agent, MCP_GOVERNANCE_AGENTS)) &&
        member(g.scope, ['project', 'user', 'unknown']) &&
        (g.sourceId === null || member(g.sourceId, MCP_GOVERNANCE_SOURCES)),
    ) &&
    typeof v.canPreview === 'boolean' &&
    (v.reason === null || member(v.reason, MCP_GOVERNANCE_ERRORS)) &&
    (!v.canPreview ||
      (v.captureId !== null &&
        v.binding !== null &&
        v.compatibility.status === 'supported' &&
        v.current.gate !== 'unavailable' &&
        v.reason === null))
  );
}
export function validateMcpGovernanceSelection(v: unknown): v is McpGovernanceSelection {
  return exact(v, ['id', 'expectedSha256']) && choiceId(v.id) && hash(v.expectedSha256);
}
export function validateMcpGovernancePreviewRequest(v: unknown): v is McpGovernancePreviewRequest {
  return (
    exact(v, ['captureId', 'binding', 'selected']) &&
    uuid(v.captureId) &&
    validateMcpGovernanceBinding(v.binding) &&
    Array.isArray(v.selected) &&
    v.selected.length <= 64 &&
    v.selected.every(validateMcpGovernanceSelection) &&
    unique(v.selected, (s: McpGovernanceSelection) => s.id)
  );
}
export function validateMcpGovernanceGateChecks(
  v: unknown,
  selectedCount?: number,
): v is McpGovernanceGateChecks {
  return (
    exact(v, ['scope', 'runtimeSha256', 'passed', 'cases', 'modelCalls', 'providerCalls']) &&
    v.scope === 'core-mcp-gate-fixtures' &&
    hash(v.runtimeSha256) &&
    typeof v.passed === 'boolean' &&
    v.modelCalls === 0 &&
    v.providerCalls === 0 &&
    Array.isArray(v.cases) &&
    v.cases.length === 4 &&
    v.cases.every(
      (c: unknown, i: number) =>
        exact(c, ['id', 'status']) &&
        c.id === MCP_GOVERNANCE_GATE_CASES[i] &&
        member(c.status, ['passed', 'failed', 'unavailable', 'not-applicable']) &&
        (i === 0
          ? selectedCount === undefined
            ? true
            : selectedCount === 0
              ? c.status === 'not-applicable'
              : c.status !== 'not-applicable'
          : c.status !== 'not-applicable'),
    ) &&
    v.passed === v.cases.every((c: any) => c.status === 'passed' || c.status === 'not-applicable')
  );
}
export function validateMcpGovernancePreview(v: unknown): v is McpGovernancePreview {
  if (
    !exact(v, [
      'schema',
      'id',
      'operationId',
      'createdAt',
      'expiresAt',
      'captureId',
      'binding',
      'selected',
      'candidateRawSha256',
      'candidateFingerprint',
      'policyVersion',
      'current',
      'diff',
      'selectedEffect',
      'unlistedEffect',
      'unknownEffect',
      'registrationPinned',
      'check',
      'simulation',
      'regressions',
      'gateChecks',
      'blockers',
      'unconfirmedRecords',
      'requiresRecoveryReview',
      'requiresWeakening',
      'requiresInterruptions',
      'scope',
      'retainsConfigurationCopies',
      'existingProxies',
      'existingTasks',
      'hostEnforcement',
    ]) ||
    v.schema !== 'stroq-mcp-governance-preview/1' ||
    !uuid(v.id) ||
    !uuid(v.operationId) ||
    !stamp(v.createdAt) ||
    !stamp(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    Date.parse(v.expiresAt) - Date.parse(v.createdAt) > 120000 ||
    !validateMcpGovernancePreviewRequest({
      captureId: v.captureId,
      binding: v.binding,
      selected: v.selected,
    }) ||
    !hash(v.candidateRawSha256) ||
    !hash(v.candidateFingerprint) ||
    v.policyVersion !== 2 ||
    !validateMcpGovernanceCurrent(v.current) ||
    v.current.gate === 'unavailable' ||
    !validateMcpGovernanceDiff(v.diff) ||
    !samePairs(v.current.allowed, [...v.diff.removed, ...v.diff.retained]) ||
    v.selected.length !== v.diff.added.length + v.diff.retained.length ||
    v.selectedEffect !== 'continue-existing-checks' ||
    v.unlistedEffect !== 'deny' ||
    v.unknownEffect !== 'deny' ||
    v.registrationPinned !== false ||
    !governanceCheck(v.check) ||
    !governanceSimulation(v.simulation) ||
    !validatePolicyCaseRegressions(v.regressions) ||
    !validateMcpGovernanceGateChecks(v.gateChecks, v.selected.length) ||
    v.gateChecks.runtimeSha256 !== v.binding.runtimeSha256 ||
    !Array.isArray(v.blockers) ||
    v.blockers.length > 6 ||
    !v.blockers.every((b: unknown) =>
      member(b, [
        'policy-checks-failed',
        'simulation-failed',
        'saved-case-failures',
        'gate-checks-failed',
        'capture-incomplete',
        'runtime-unsupported',
      ]),
    ) ||
    !unique(v.blockers, (b: string) => b) ||
    !Array.isArray(v.unconfirmedRecords) ||
    v.unconfirmedRecords.length > 32 ||
    !v.unconfirmedRecords.every(
      (r: unknown) =>
        exact(r, ['id', 'revision', 'operationId']) &&
        uuid(r.id) &&
        hash(r.revision) &&
        uuid(r.operationId),
    ) ||
    !unique(v.unconfirmedRecords, (r: { id: string }) => r.id) ||
    v.unconfirmedRecords.some((r: { operationId: string }) => r.operationId === v.operationId) ||
    v.requiresRecoveryReview !== v.unconfirmedRecords.length > 0 ||
    typeof v.requiresWeakening !== 'boolean' ||
    v.requiresWeakening !== (v.current.policyVersion === 2 && v.diff.added.length > 0) ||
    typeof v.requiresInterruptions !== 'boolean' ||
    ((v.simulation.newInterruptions > 0 || v.diff.removed.length > 0) &&
      !v.requiresInterruptions) ||
    v.scope !== 'stroq-home' ||
    v.retainsConfigurationCopies !== true ||
    v.existingProxies !== 'restart-required' ||
    v.existingTasks !== 'launch-policy-unchanged' ||
    v.hostEnforcement !== false
  )
    return false;
  const required = [
    ...(!v.check.ok ? ['policy-checks-failed'] : []),
    ...(!v.simulation.ok ? ['simulation-failed'] : []),
    ...(v.regressions.failed ? ['saved-case-failures'] : []),
    ...(!v.gateChecks.passed ? ['gate-checks-failed'] : []),
  ];
  return required.every((b) => v.blockers.includes(b));
}
export function validateMcpGovernanceApplyRequest(v: unknown): v is McpGovernanceApplyRequest {
  return (
    exact(v, [
      'previewId',
      'operationId',
      'contextId',
      'acknowledgeScope',
      'acknowledgeRetention',
      ...(v && typeof v === 'object' && Object.hasOwn(v, 'acknowledgeWeakening')
        ? ['acknowledgeWeakening']
        : []),
      ...(v && typeof v === 'object' && Object.hasOwn(v, 'acknowledgeInterruptions')
        ? ['acknowledgeInterruptions']
        : []),
      ...(v && typeof v === 'object' && Object.hasOwn(v, 'acknowledgeUnconfirmed')
        ? ['acknowledgeUnconfirmed']
        : []),
    ]) &&
    uuid(v.previewId) &&
    uuid(v.operationId) &&
    context(v.contextId) &&
    v.acknowledgeScope === true &&
    v.acknowledgeRetention === true &&
    (!Object.hasOwn(v, 'acknowledgeWeakening') || v.acknowledgeWeakening === true) &&
    (!Object.hasOwn(v, 'acknowledgeInterruptions') || v.acknowledgeInterruptions === true) &&
    (!Object.hasOwn(v, 'acknowledgeUnconfirmed') || v.acknowledgeUnconfirmed === true)
  );
}
const sameBinding = (a: McpGovernanceBinding, b: McpGovernanceBinding) =>
  Object.keys(a).every(
    (k) => a[k as keyof McpGovernanceBinding] === b[k as keyof McpGovernanceBinding],
  );
function publication(v: Record<string, any>, time: string) {
  return (
    uuid(v.operationId) &&
    validateMcpGovernanceBinding(v.binding) &&
    stamp(v[time]) &&
    typeof v.writeConfirmed === 'boolean' &&
    validateMcpGovernanceRecord(v.record) &&
    v.record.operationId === v.operationId &&
    sameBinding(v.binding, v.record.binding) &&
    v.record.updatedAt <= v[time] &&
    v.writeConfirmed === (v.record.status === 'applied') &&
    v.hostEnforcement === false
  );
}
export function validateMcpGovernanceReceipt(v: unknown): v is McpGovernanceReceipt {
  return (
    exact(v, [
      'schema',
      'previewId',
      'operationId',
      'binding',
      'completedAt',
      'writeConfirmed',
      'record',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-mcp-governance-receipt/1' &&
    uuid(v.previewId) &&
    publication(v, 'completedAt')
  );
}
export function validateMcpGovernanceRecheckRequest(v: unknown): v is McpGovernanceRecheckRequest {
  return (
    exact(v, ['contextId', 'recordId', 'recordRevision', 'operationId']) &&
    context(v.contextId) &&
    uuid(v.recordId) &&
    hash(v.recordRevision) &&
    uuid(v.operationId)
  );
}
export function validateMcpGovernanceRecheck(v: unknown): v is McpGovernanceRecheck {
  return (
    exact(v, [
      'schema',
      'operationId',
      'binding',
      'checkedAt',
      'writeConfirmed',
      'record',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-mcp-governance-recheck/1' &&
    publication(v, 'checkedAt')
  );
}
