import {
  validateMcpGovernancePreview,
  validateMcpGovernanceReceipt,
  validateMcpGovernanceRecheck,
  type McpGovernanceBinding,
  type McpGovernanceCapture,
  type McpGovernancePreviewRequest,
  type McpGovernancePreview,
  type McpGovernanceReceipt,
  type McpGovernanceRecheck,
  type McpGovernanceError,
  type McpGovernanceApplyRequest,
} from './mcp-governance';
import { samePairs } from './mcp-governance-validation';
export const MCP_GOVERNANCE_ERROR_MESSAGES: Record<McpGovernanceError, string> = {
  'mcp-governance-unavailable': 'MCP governance is unavailable.',
  'mcp-governance-stale': 'The captured policy or registrations changed. Inspect again.',
  'mcp-governance-unsupported': 'This runtime cannot apply MCP governance safely.',
  'mcp-governance-invalid': 'The request or policy could not be verified.',
  'mcp-governance-ambiguous': 'A reported identity is ambiguous and cannot be selected.',
  'mcp-governance-store-unavailable': 'Saved governance operations could not be verified.',
  'mcp-governance-store-full': 'Saved operation storage is full. Recovery data was retained.',
  'mcp-governance-recovery-required':
    'Review the exact unconfirmed operations before a new change.',
  'mcp-governance-write-unconfirmed': 'Completion is unknown. Recheck the exact operation.',
  'mcp-governance-runtime-changed': 'Stroq changed. Inspect again before preparing another change.',
  'mcp-governance-policy-changed': 'The policy changed. Inspect its current revision again.',
  'mcp-governance-source-changed': 'A registration source changed. Inspect again.',
  'mcp-governance-preview-expired': 'Preview expired. Prepare a new review.',
  'mcp-governance-consent-required':
    'Confirm the scope, retention and required impact acknowledgements.',
  'mcp-governance-busy': 'Another local operation is running. Try after it finishes.',
  'mcp-governance-checks-failed': 'The candidate did not pass the required engine checks.',
  'mcp-governance-no-changes': 'The selected allow set already matches this policy.',
  'mcp-governance-selection-unavailable': 'A selected identity is no longer available.',
};
export const governanceMessage = (error: unknown, fallback: string) =>
  error instanceof Error && Object.values(MCP_GOVERNANCE_ERROR_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
export type GovernanceTransport = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export type McpGovernancePending = { preview: McpGovernancePreview; startedAt: string };
export type McpGovernanceAcknowledgements = {
  scope: boolean;
  retention: boolean;
  weakening: boolean;
  interruptions: boolean;
  recovery: boolean;
  pendingReview: boolean;
};
export const emptyGovernanceAck = (): McpGovernanceAcknowledgements => ({
  scope: false,
  retention: false,
  weakening: false,
  interruptions: false,
  recovery: false,
  pendingReview: false,
});
export const GOVERNANCE_PENDING_LIMIT = 8;
const pending = new WeakMap<GovernanceTransport, Map<string, McpGovernancePending>>(),
  listeners = new WeakMap<GovernanceTransport, Set<() => void>>();
export const governanceOperationKey = (context: string, op: string) => context + ':' + op;
export function mcpGovernancePending(transport: GovernanceTransport) {
  let map = pending.get(transport);
  if (!map) {
    map = new Map();
    pending.set(transport, map);
  }
  return map;
}
export function subscribeMcpGovernancePending(
  transport: GovernanceTransport,
  listener: () => void,
) {
  let set = listeners.get(transport);
  if (!set) {
    set = new Set();
    listeners.set(transport, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function notifyMcpGovernancePending(transport: GovernanceTransport) {
  listeners.get(transport)?.forEach((fn) => fn());
}
export function governanceBindingMatches(a: McpGovernanceBinding, b: McpGovernanceBinding) {
  return (
    [
      'contextId',
      'workspaceId',
      'runtimeSha256',
      'policyRawSha256',
      'policyFingerprint',
      'captureSha256',
    ] as const
  ).every((k) => a[k] === b[k]);
}
export function governancePreviewMatches(
  value: unknown,
  request: McpGovernancePreviewRequest,
  capture: McpGovernanceCapture,
): value is McpGovernancePreview {
  if (
    !validateMcpGovernancePreview(value) ||
    !capture.binding ||
    !capture.canPreview ||
    value.captureId !== request.captureId ||
    value.captureId !== capture.captureId ||
    !governanceBindingMatches(value.binding, request.binding) ||
    !governanceBindingMatches(value.binding, capture.binding) ||
    Date.parse(value.expiresAt) <= Date.now() ||
    value.selected.length !== request.selected.length ||
    !value.selected.every((s) =>
      request.selected.some((r) => s.id === r.id && s.expectedSha256 === r.expectedSha256),
    ) ||
    value.current.policyVersion !== capture.current.policyVersion ||
    value.current.gate !== capture.current.gate ||
    !samePairs(value.current.allowed, capture.current.allowed)
  )
    return false;
  const selected = request.selected.map((s) =>
    capture.choices.find(
      (c) =>
        c.id === s.id &&
        c.expectedSha256 === s.expectedSha256 &&
        c.eligibility === 'eligible' &&
        c.pair,
    ),
  );
  return (
    selected.every(Boolean) &&
    samePairs(
      selected.map((c) => c!.pair!),
      [...value.diff.added, ...value.diff.retained],
    )
  );
}
export function governanceApplyInput(
  p: McpGovernancePreview,
  ack: McpGovernanceAcknowledgements,
): McpGovernanceApplyRequest | null {
  if (
    !validateMcpGovernancePreview(p) ||
    Date.parse(p.expiresAt) <= Date.now() ||
    p.blockers.length ||
    !p.check.ok ||
    !p.simulation.ok ||
    p.regressions.failed ||
    !p.gateChecks.passed ||
    !ack.scope ||
    !ack.retention ||
    (p.requiresWeakening && !ack.weakening) ||
    (p.requiresInterruptions && !ack.interruptions) ||
    (p.requiresRecoveryReview && !ack.recovery)
  )
    return null;
  return {
    previewId: p.id,
    operationId: p.operationId,
    contextId: p.binding.contextId,
    acknowledgeScope: true,
    acknowledgeRetention: true,
    ...(p.requiresWeakening ? { acknowledgeWeakening: true } : {}),
    ...(p.requiresInterruptions ? { acknowledgeInterruptions: true } : {}),
    ...(p.requiresRecoveryReview ? { acknowledgeUnconfirmed: true } : {}),
  };
}
export function governanceCompletionMatches(
  value: unknown,
  p: McpGovernancePreview,
  recheck = false,
): value is McpGovernanceReceipt | McpGovernanceRecheck {
  if (!validateMcpGovernanceRecheck(value) && !validateMcpGovernanceReceipt(value)) return false;
  return (
    (recheck
      ? value.schema === 'stroq-mcp-governance-recheck/1'
      : value.schema === 'stroq-mcp-governance-receipt/1') &&
    governanceBindingMatches(value.binding, p.binding) &&
    value.operationId === p.operationId &&
    value.record.candidateRawSha256 === p.candidateRawSha256 &&
    value.record.candidateFingerprint === p.candidateFingerprint &&
    (recheck || ('previewId' in value && value.previewId === p.id)) &&
    ('checkedAt' in value ? value.checkedAt : value.completedAt) >= p.createdAt
  );
}
export function reconcileMcpGovernance(
  transport: GovernanceTransport,
  value: McpGovernanceReceipt | McpGovernanceRecheck,
) {
  const map = mcpGovernancePending(transport),
    k = governanceOperationKey(value.binding.contextId, value.operationId),
    old = map.get(k);
  if (
    !old ||
    !governanceCompletionMatches(value, old.preview, 'checkedAt' in value) ||
    value.record.status === 'unknown' ||
    ('checkedAt' in value ? value.checkedAt : value.completedAt) < old.startedAt
  )
    return false;
  map.delete(k);
  notifyMcpGovernancePending(transport);
  return true;
}
