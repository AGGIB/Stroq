import type {
  McpGovernancePairSummary,
  McpGovernanceBinding,
  McpGovernanceChoice,
  McpGovernanceCapture,
  McpGovernancePreview,
  McpGovernanceRecord,
  McpGovernanceState,
  McpGovernanceReceipt,
  McpGovernanceRecheck,
} from './mcp-governance-types';
export const governanceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const governanceHash = 'a'.repeat(64),
  governanceContext = 'governance-context-' + governanceHash,
  governanceWorkspace = 'workspace-' + 'b'.repeat(24);
export const governancePair = (
  patch: Partial<McpGovernancePairSummary> = {},
): McpGovernancePairSummary => ({
  channel: 'claude-code',
  label: 'notes',
  redacted: false,
  identitySha256: 'c'.repeat(64),
  ...patch,
});
export const governanceBinding = (): McpGovernanceBinding => ({
  contextId: governanceContext,
  workspaceId: governanceWorkspace,
  runtimeSha256: 'd'.repeat(64),
  policyRawSha256: null,
  policyFingerprint: 'e'.repeat(64),
  captureSha256: 'f'.repeat(64),
});
export const governanceChoice = (
  patch: Partial<McpGovernanceChoice> = {},
): McpGovernanceChoice => ({
  id: 'choice-' + '1'.repeat(64),
  expectedSha256: '2'.repeat(64),
  pair: governancePair(),
  kind: 'registration',
  sourceRefs: [
    {
      id: 'item-' + '3'.repeat(24),
      sha: '4'.repeat(64),
      agent: 'claude-code',
      scope: 'project',
      label: 'notes',
      sourceId: 'claude-code-project',
    },
  ],
  eligibility: 'eligible',
  reason: null,
  inAllowSet: false,
  ...patch,
});
export const governanceCapture = (): McpGovernanceCapture => ({
  schema: 'stroq-mcp-governance-capture/1',
  capturedAt: new Date().toISOString(),
  captureId: governanceId(1),
  binding: governanceBinding(),
  current: { policyVersion: 1, gate: 'absent', allowed: [] },
  compatibility: { status: 'supported', format: 2, olderRuntimes: 'reject-v2' },
  choices: [governanceChoice()],
  gaps: [],
  canPreview: true,
  reason: null,
});
export const governancePreview = (): McpGovernancePreview => {
  const capture = governanceCapture(),
    choice = capture.choices[0]!;
  return {
    schema: 'stroq-mcp-governance-preview/1',
    id: governanceId(2),
    operationId: governanceId(3),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    captureId: capture.captureId!,
    binding: capture.binding!,
    selected: [{ id: choice.id, expectedSha256: choice.expectedSha256 }],
    candidateRawSha256: '5'.repeat(64),
    candidateFingerprint: '6'.repeat(64),
    policyVersion: 2,
    current: capture.current,
    diff: { added: [choice.pair!], removed: [], retained: [] },
    selectedEffect: 'continue-existing-checks',
    unlistedEffect: 'deny',
    unknownEffect: 'deny',
    registrationPinned: false,
    check: { ok: true, loaded: true, faults: 0, findings: [] },
    simulation: {
      ok: true,
      replayed: { attack: 1, ordinary: 1, cases: 0 },
      attacksPassing: 0,
      newInterruptions: 0,
      relieved: 0,
      violations: 0,
      notJudged: 0,
    },
    regressions: { revision: null, total: 0, passed: 0, failed: 0, results: [] },
    gateChecks: {
      scope: 'core-mcp-gate-fixtures',
      runtimeSha256: capture.binding!.runtimeSha256,
      passed: true,
      cases: [
        { id: 'listed-continues', status: 'passed' },
        { id: 'unlisted-denied', status: 'passed' },
        { id: 'unknown-denied', status: 'passed' },
        { id: 'non-mcp-unchanged', status: 'passed' },
      ],
      modelCalls: 0,
      providerCalls: 0,
    },
    blockers: [],
    unconfirmedRecords: [],
    requiresRecoveryReview: false,
    requiresWeakening: false,
    requiresInterruptions: false,
    scope: 'stroq-home',
    retainsConfigurationCopies: true,
    existingProxies: 'restart-required',
    existingTasks: 'launch-policy-unchanged',
    hostEnforcement: false,
  };
};
export const governanceRecord = (
  patch: Partial<McpGovernanceRecord> = {},
): McpGovernanceRecord => ({
  id: governanceId(4),
  operationId: governanceId(3),
  revision: '7'.repeat(64),
  binding: governanceBinding(),
  // A fixed past time: a receipt made a millisecond earlier must still be later than its record.
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'applied',
  candidateRawSha256: '5'.repeat(64),
  candidateFingerprint: '6'.repeat(64),
  historyRef: { entryId: governanceId(5), recordSha256: '8'.repeat(64) },
  current: 'matches',
  hostEnforcement: false,
  ...patch,
});
export const governanceState = (records: McpGovernanceRecord[] = []): McpGovernanceState => ({
  schema: 'stroq-mcp-governance/1',
  generatedAt: new Date().toISOString(),
  contextId: governanceContext,
  workspaceId: governanceWorkspace,
  runtimeSha256: governanceBinding().runtimeSha256,
  policyRawSha256: null,
  policyFingerprint: governanceBinding().policyFingerprint,
  current: { policyVersion: 1, gate: 'absent', allowed: [] },
  editable: true,
  history: 'missing',
  records,
  error: null,
});
export const governanceReceipt = (): McpGovernanceReceipt => ({
  schema: 'stroq-mcp-governance-receipt/1',
  previewId: governanceId(2),
  operationId: governanceId(3),
  binding: governanceBinding(),
  completedAt: new Date().toISOString(),
  writeConfirmed: true,
  record: governanceRecord(),
  hostEnforcement: false,
});
export const governanceRecheck = (): McpGovernanceRecheck => ({
  schema: 'stroq-mcp-governance-recheck/1',
  operationId: governanceId(3),
  binding: governanceBinding(),
  checkedAt: new Date().toISOString(),
  writeConfirmed: true,
  record: governanceRecord(),
  hostEnforcement: false,
});

export const governanceRestoreDiff = () => ({
  current: { policyVersion: 1 as const, gate: 'absent' as const, allowed: [] },
  candidate: { policyVersion: 1 as const, gate: 'absent' as const, allowed: [] },
  diff: { added: [], removed: [], retained: [] },
  selectedEffect: 'continue-existing-checks' as const,
  registrationPinned: false as const,
  hostEnforcement: false as const,
});
