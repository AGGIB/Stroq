import {
  validatePolicyPreview,
  validatePolicyReceipt,
  type PolicyPreview,
  type PolicyReceipt,
  type PolicyState,
} from './policy-control';
import type { RecordedActionClass } from './incident-comparison';

export interface PolicyRequestedChanges {
  defaultEffect?: 'ask' | 'deny';
  threshold?: number;
  promoteRuleIndexes?: number[];
  denyActionClasses?: RecordedActionClass[];
}

/** A closed response must also describe this exact source and selected draft. */
export function policyPreviewMatches(
  value: unknown,
  state: PolicyState,
  changes: PolicyRequestedChanges,
): value is PolicyPreview {
  if (
    !validatePolicyPreview(value) ||
    value.expectedRawSha !== state.expectedRawSha ||
    value.currentPolicyFingerprint !== state.policyFingerprint
  )
    return false;
  const diffs = value.changes;
  if (!diffs.length) return false;
  for (const change of diffs) {
    if (change.field === 'class-deny') {
      if (!changes.denyActionClasses?.includes(change.actionClass)) return false;
    } else if (change.field === 'default') {
      if (change.from !== state.defaultEffect || change.to !== changes.defaultEffect) return false;
    } else if (change.field === 'threshold') {
      if (change.from !== state.threshold || change.to !== changes.threshold) return false;
    } else if (
      change.index === undefined ||
      !changes.promoteRuleIndexes?.includes(change.index) ||
      state.rules[change.index]?.effect !== 'ask' ||
      change.from !== 'ask' ||
      change.to !== 'deny'
    )
      return false;
  }
  if (
    changes.defaultEffect !== undefined &&
    changes.defaultEffect !== state.defaultEffect &&
    !diffs.some((d) => d.field === 'default')
  )
    return false;
  if (
    changes.threshold !== undefined &&
    changes.threshold !== state.threshold &&
    !diffs.some((d) => d.field === 'threshold')
  )
    return false;
  return (changes.promoteRuleIndexes ?? []).every((index) =>
    diffs.some((d) => d.field === 'rule-effect' && d.index === index),
  );
}

export function policyApplyInput(
  value: unknown,
  ack: boolean,
  sharedScope: boolean,
  now = Date.now(),
) {
  if (
    !validatePolicyPreview(value) ||
    Date.parse(value.expiresAt) <= now ||
    value.blockers.length ||
    !value.check.ok ||
    !value.simulation.ok ||
    value.simulation.attacksPassing ||
    value.simulation.notJudged ||
    value.simulation.violations ||
    value.regressions.failed > 0 ||
    ((value.requiresInterruptionAcknowledgement || value.simulation.newInterruptions > 0) &&
      !ack) ||
    (value.actionControl !== null && !sharedScope)
  )
    return null;
  return {
    previewId: value.previewId,
    expectedRawSha: value.expectedRawSha,
    candidateFingerprint: value.candidateFingerprint,
    acknowledgeInterruptions: ack,
    acknowledgeActionScope: sharedScope,
  };
}

export function policyReceiptMatches(
  value: unknown,
  preview: PolicyPreview,
): value is PolicyReceipt {
  return (
    validatePolicyReceipt(value) &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.receiptId) &&
    value.policyFingerprint === preview.candidateFingerprint &&
    value.rawSha !== preview.expectedRawSha &&
    value.backupId === (preview.expectedRawSha === null ? null : value.receiptId)
  );
}
