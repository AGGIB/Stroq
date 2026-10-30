import {
  SETUP_AGENTS,
  type SetupAgent,
  type SetupPreview,
  type SetupResult,
  type SetupScope,
} from './agent-setup';

export function agentSetupKey(
  workspaceId: string | null,
  agent: SetupAgent,
  scope: SetupScope,
  generation: number,
) {
  if (
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !Object.hasOwn(SETUP_AGENTS, agent) ||
    !['project', 'user'].includes(scope) ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return null;
  return `${workspaceId}:${agent}:${scope}:${generation}`;
}
export interface SetupSelection {
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
}
export function setupPreviewMatches(preview: SetupPreview, selected: SetupSelection) {
  return (
    preview.workspaceId === selected.workspaceId &&
    preview.agent === selected.agent &&
    preview.scope === selected.scope
  );
}
export function setupReceiptMatches(receipt: SetupResult, preview: SetupPreview) {
  const unchanged = preview.operation === 'unchanged';
  const expectedStatus =
    preview.remainingLookalikes > 0 ? 'review-required' : unchanged ? 'unchanged' : 'configured';
  return (
    receipt.previewId === preview.id &&
    Date.parse(receipt.configuredAt) >= Date.parse(preview.createdAt) &&
    receipt.workspaceId === preview.workspaceId &&
    receipt.agent === preview.agent &&
    receipt.scope === preview.scope &&
    receipt.scopeImpact === preview.scopeImpact &&
    receipt.context === preview.context &&
    receipt.target === preview.target &&
    receipt.sourceSha256 === preview.sourceSha256 &&
    receipt.candidateSha256 === preview.candidateSha256 &&
    receipt.operation === preview.operation &&
    receipt.addedHooks === preview.addedHooks &&
    receipt.replacedHooks === preview.replacedHooks &&
    receipt.preservedHooks === preview.preservedHooks &&
    receipt.remainingLookalikes === preview.remainingLookalikes &&
    receipt.currentExactHooks === preview.hookEvents.length &&
    receipt.status === expectedStatus &&
    receipt.needsApproval === preview.needsApproval &&
    receipt.nextSteps.length === preview.nextSteps.length &&
    receipt.nextSteps.every((step, index) => step === preview.nextSteps[index]) &&
    receipt.backup.configExisted === preview.backup.configExisted &&
    receipt.backup.recordExisted === preview.backup.recordExisted &&
    (unchanged
      ? receipt.backupId === null &&
        receipt.backup.complete === false &&
        receipt.backup.label === null
      : receipt.backupId === preview.id &&
        receipt.backup.complete === true &&
        receipt.backup.label === `${preview.backup.label}${preview.id}.manifest.json`)
  );
}
export interface SetupAcknowledgements {
  acknowledgeRetainedCopy: boolean;
  acknowledgeSharedScope: boolean;
}
export const emptySetupAcknowledgements = (): SetupAcknowledgements => ({
  acknowledgeRetainedCopy: false,
  acknowledgeSharedScope: false,
});
export function setupApplyInput(
  preview: SetupPreview,
  acknowledged: SetupAcknowledgements,
  now = Date.now(),
) {
  if (
    now >= Date.parse(preview.expiresAt) ||
    (preview.needs.acknowledgeRetainedCopy && acknowledged.acknowledgeRetainedCopy !== true) ||
    (preview.needs.acknowledgeSharedScope && acknowledged.acknowledgeSharedScope !== true)
  )
    return null;
  return {
    previewId: preview.id,
    confirm: true,
    ...(preview.needs.acknowledgeRetainedCopy ? { acknowledgeRetainedCopy: true } : {}),
    ...(preview.needs.acknowledgeSharedScope ? { acknowledgeSharedScope: true } : {}),
  };
}
