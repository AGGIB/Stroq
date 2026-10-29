import type { PolicyCheck, PolicyPreview } from './policy-control';
import type { PolicyCaseRegressions } from './policy-cases';
export const MCP_GOVERNANCE_CHANNELS = [
  'claude-code',
  'codex',
  'cursor',
  'windsurf',
  'mcp-proxy',
] as const;
export const MCP_GOVERNANCE_AGENTS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'windsurf',
] as const;
export const MCP_GOVERNANCE_SOURCES = [
  'claude-code-project',
  'claude-code-user',
  'claude-desktop-user',
  'cursor-project',
  'cursor-user',
  'windsurf-project',
  'windsurf-user',
  'codex-project',
  'codex-user',
] as const;
export const MCP_GOVERNANCE_REASONS = [
  'unsupported-agent',
  'unsupported-source',
  'unsupported-name',
  'missing-identity',
  'ambiguous-identity',
  'source-unavailable',
  'proxy-unverified',
  'proxy-other-home',
  'redacted-identity',
] as const;
export const MCP_GOVERNANCE_GAPS = [
  'source-unavailable',
  'source-unsupported',
  'source-limit',
  'identity-unknown',
  'identity-ambiguous',
  'identity-unsupported',
  'proxy-unverified',
  'proxy-other-home',
  'partial-capture',
] as const;
export const MCP_GOVERNANCE_ERRORS = [
  'mcp-governance-unavailable',
  'mcp-governance-stale',
  'mcp-governance-unsupported',
  'mcp-governance-invalid',
  'mcp-governance-ambiguous',
  'mcp-governance-store-unavailable',
  'mcp-governance-store-full',
  'mcp-governance-recovery-required',
  'mcp-governance-write-unconfirmed',
  'mcp-governance-runtime-changed',
  'mcp-governance-policy-changed',
  'mcp-governance-source-changed',
  'mcp-governance-preview-expired',
  'mcp-governance-consent-required',
  'mcp-governance-busy',
  'mcp-governance-checks-failed',
  'mcp-governance-no-changes',
  'mcp-governance-selection-unavailable',
] as const;
export type McpGovernanceChannel = (typeof MCP_GOVERNANCE_CHANNELS)[number];
export type McpGovernanceAgent = (typeof MCP_GOVERNANCE_AGENTS)[number];
export type McpGovernanceSource = (typeof MCP_GOVERNANCE_SOURCES)[number];
export type McpGovernanceError = (typeof MCP_GOVERNANCE_ERRORS)[number];
export type McpGovernanceReason = (typeof MCP_GOVERNANCE_REASONS)[number];
/** Labels are server-redacted display metadata, never mutation authority or endpoint provenance. */
export interface McpGovernancePairSummary {
  channel: McpGovernanceChannel;
  label: string;
  redacted: boolean;
  identitySha256: string;
}
export interface McpGovernanceSourceRef {
  id: string;
  sha: string;
  agent: McpGovernanceAgent;
  scope: 'project' | 'user';
  label: string;
  sourceId: McpGovernanceSource;
}
export interface McpGovernanceChoice {
  id: string;
  expectedSha256: string;
  pair: McpGovernancePairSummary | null;
  kind: 'registration' | 'retained' | 'both';
  sourceRefs: McpGovernanceSourceRef[];
  eligibility: 'eligible' | 'unsupported' | 'ambiguous' | 'unavailable';
  reason: McpGovernanceReason | null;
  inAllowSet: boolean;
}
export interface McpGovernanceBinding {
  contextId: string;
  workspaceId: string;
  runtimeSha256: string;
  policyRawSha256: string | null;
  policyFingerprint: string;
  captureSha256: string;
}
export interface McpGovernanceCurrent {
  policyVersion: 1 | 2 | null;
  gate: 'absent' | 'enforced' | 'unavailable';
  allowed: McpGovernancePairSummary[];
}
export interface McpGovernanceHistoryRef {
  entryId: string;
  recordSha256: string;
}
export interface McpGovernanceRecord {
  id: string;
  operationId: string;
  revision: string;
  binding: McpGovernanceBinding;
  createdAt: string;
  updatedAt: string;
  status: 'unknown' | 'applied' | 'not-applied';
  candidateRawSha256: string;
  candidateFingerprint: string;
  historyRef: McpGovernanceHistoryRef | null;
  current: 'matches' | 'changed' | 'unavailable';
  hostEnforcement: false;
}
export interface McpGovernanceState {
  schema: 'stroq-mcp-governance/1';
  generatedAt: string;
  contextId: string | null;
  workspaceId: string;
  runtimeSha256: string | null;
  policyRawSha256: string | null;
  policyFingerprint: string | null;
  current: McpGovernanceCurrent;
  editable: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  records: McpGovernanceRecord[];
  error: McpGovernanceError | null;
}
export interface McpGovernanceCapture {
  schema: 'stroq-mcp-governance-capture/1';
  capturedAt: string;
  captureId: string | null;
  binding: McpGovernanceBinding | null;
  current: McpGovernanceCurrent;
  compatibility: {
    status: 'supported' | 'unsupported' | 'unavailable';
    format: 2;
    olderRuntimes: 'reject-v2';
  };
  choices: McpGovernanceChoice[];
  gaps: {
    code: (typeof MCP_GOVERNANCE_GAPS)[number];
    agent: McpGovernanceAgent | null;
    scope: 'project' | 'user' | 'unknown';
    sourceId: McpGovernanceSource | null;
  }[];
  canPreview: boolean;
  reason: McpGovernanceError | null;
}
export interface McpGovernanceSelection {
  id: string;
  expectedSha256: string;
}
export interface McpGovernancePreviewRequest {
  captureId: string;
  binding: McpGovernanceBinding;
  selected: McpGovernanceSelection[];
}
export interface McpGovernanceDiff {
  added: McpGovernancePairSummary[];
  removed: McpGovernancePairSummary[];
  retained: McpGovernancePairSummary[];
}
export const MCP_GOVERNANCE_GATE_CASES = [
  'listed-continues',
  'unlisted-denied',
  'unknown-denied',
  'non-mcp-unchanged',
] as const;
export interface McpGovernanceGateChecks {
  scope: 'core-mcp-gate-fixtures';
  runtimeSha256: string;
  passed: boolean;
  cases: {
    id: (typeof MCP_GOVERNANCE_GATE_CASES)[number];
    status: 'passed' | 'failed' | 'unavailable' | 'not-applicable';
  }[];
  modelCalls: 0;
  providerCalls: 0;
}
export interface McpGovernancePreview {
  schema: 'stroq-mcp-governance-preview/1';
  id: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  captureId: string;
  binding: McpGovernanceBinding;
  selected: McpGovernanceSelection[];
  candidateRawSha256: string;
  candidateFingerprint: string;
  policyVersion: 2;
  current: McpGovernanceCurrent;
  diff: McpGovernanceDiff;
  selectedEffect: 'continue-existing-checks';
  unlistedEffect: 'deny';
  unknownEffect: 'deny';
  registrationPinned: false;
  check: PolicyCheck;
  simulation: PolicyPreview['simulation'];
  regressions: PolicyCaseRegressions;
  gateChecks: McpGovernanceGateChecks;
  blockers: (
    | 'policy-checks-failed'
    | 'simulation-failed'
    | 'saved-case-failures'
    | 'gate-checks-failed'
    | 'capture-incomplete'
    | 'runtime-unsupported'
  )[];
  unconfirmedRecords: { id: string; revision: string; operationId: string }[];
  requiresRecoveryReview: boolean;
  requiresWeakening: boolean;
  requiresInterruptions: boolean;
  scope: 'stroq-home';
  retainsConfigurationCopies: true;
  existingProxies: 'restart-required';
  existingTasks: 'launch-policy-unchanged';
  hostEnforcement: false;
}
export interface McpGovernanceApplyRequest {
  previewId: string;
  operationId: string;
  contextId: string;
  acknowledgeScope: true;
  acknowledgeRetention: true;
  acknowledgeWeakening?: true;
  acknowledgeInterruptions?: true;
  acknowledgeUnconfirmed?: true;
}
export interface McpGovernanceReceipt {
  schema: 'stroq-mcp-governance-receipt/1';
  previewId: string;
  operationId: string;
  binding: McpGovernanceBinding;
  completedAt: string;
  writeConfirmed: boolean;
  record: McpGovernanceRecord;
  hostEnforcement: false;
}
export interface McpGovernanceRecheckRequest {
  contextId: string;
  recordId: string;
  recordRevision: string;
  operationId: string;
}
export interface McpGovernanceRecheck {
  schema: 'stroq-mcp-governance-recheck/1';
  operationId: string;
  binding: McpGovernanceBinding;
  checkedAt: string;
  writeConfirmed: boolean;
  record: McpGovernanceRecord;
  hostEnforcement: false;
}
/** Shared display-only MCP delta required by retained whole-policy Restore. */
export interface McpGovernanceRestoreDiff {
  current: McpGovernanceCurrent;
  candidate: McpGovernanceCurrent;
  diff: McpGovernanceDiff;
  selectedEffect: 'continue-existing-checks';
  registrationPinned: false;
  hostEnforcement: false;
}
