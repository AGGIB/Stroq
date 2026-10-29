import {
  validatePolicyHistoryState,
  validatePolicyRestorePreview,
  validatePolicyRestoreReceipt,
  type PolicyHistoryEntry,
  type PolicyHistoryState,
  type PolicyRestorePreview,
  type PolicyRestoreReceipt,
} from './policy-history';
export interface PolicyRestoreAcknowledgements {
  sharedScope: boolean;
  reducedProtection: boolean;
  backup: boolean;
  interruptions: boolean;
}
export function policyRestorePreviewMatches(
  value: unknown,
  state: PolicyHistoryState,
  entry: PolicyHistoryEntry,
  now = Date.now(),
): value is PolicyRestorePreview {
  return (
    validatePolicyHistoryState(state) &&
    state.restoreAvailable &&
    state.currentValid &&
    state.entries.some(
      (item) => item.id === entry.id && item.recordSha256 === entry.recordSha256,
    ) &&
    entry.recovery !== 'unavailable' &&
    validatePolicyRestorePreview(value) &&
    Date.parse(value.expiresAt) > now &&
    value.entryId === entry.id &&
    value.recordSha256 === entry.recordSha256 &&
    value.runtimeSha256 === state.runtimeSha256 &&
    value.expectedRawSha === state.currentRawSha &&
    value.currentPolicyFingerprint === state.currentPolicyFingerprint &&
    value.target === entry.recovery &&
    value.candidateRawSha === (entry.recovery === 'current-default' ? null : entry.beforeRawSha)
  );
}
export function policyRestoreApplyInput(
  value: unknown,
  ack: PolicyRestoreAcknowledgements,
  now = Date.now(),
) {
  if (
    !validatePolicyRestorePreview(value) ||
    Date.parse(value.expiresAt) <= now ||
    value.blockers.length > 0 ||
    !value.check.ok ||
    !value.check.loaded ||
    value.check.faults > 0 ||
    !value.simulation.ok ||
    value.simulation.attacksPassing > 0 ||
    value.simulation.notJudged > 0 ||
    value.simulation.violations > 0 ||
    value.regressions.failed > 0 ||
    !ack.sharedScope ||
    !ack.reducedProtection ||
    !ack.backup ||
    (value.simulation.newInterruptions > 0 && !ack.interruptions)
  )
    return null;
  return {
    previewId: value.previewId,
    entryId: value.entryId,
    recordSha256: value.recordSha256,
    expectedRawSha: value.expectedRawSha,
    candidateFingerprint: value.candidateFingerprint,
    acknowledgeSharedScope: true as const,
    acknowledgeReducedProtection: true as const,
    acknowledgeBackup: true as const,
    acknowledgeInterruptions: ack.interruptions,
  };
}
export function policyRestoreReceiptMatches(
  value: unknown,
  preview: PolicyRestorePreview,
): value is PolicyRestoreReceipt {
  return (
    validatePolicyRestoreReceipt(value) &&
    value.entryId === preview.entryId &&
    value.target === preview.target &&
    value.runtimeSha256 === preview.runtimeSha256 &&
    value.policyFingerprint === preview.candidateFingerprint &&
    value.rawSha === preview.candidateRawSha &&
    value.backupId === (preview.expectedRawSha === null ? null : value.receiptId)
  );
}
