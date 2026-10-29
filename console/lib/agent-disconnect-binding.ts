import type { AgentDisconnectPreview, AgentDisconnectReceipt } from './agent-disconnect';
import { SETUP_AGENTS, type SetupAgent, type SetupScope } from './agent-setup';

export function agentDisconnectKey(
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
export interface DisconnectSelection {
  workspaceId: string;
  agent: SetupAgent;
  scope: SetupScope;
}
export function disconnectPreviewMatches(
  preview: AgentDisconnectPreview,
  selected: DisconnectSelection,
) {
  return (
    preview.workspaceId === selected.workspaceId &&
    preview.agent === selected.agent &&
    preview.scope === selected.scope
  );
}
export function disconnectReceiptMatches(
  receipt: AgentDisconnectReceipt,
  preview: AgentDisconnectPreview,
) {
  return (
    preview.operation === 'remove-hooks' &&
    preview.backup.required &&
    receipt.previewId === preview.previewId &&
    Date.parse(receipt.completedAt) >= Date.parse(preview.createdAt) &&
    receipt.workspaceId === preview.workspaceId &&
    receipt.agent === preview.agent &&
    receipt.scope === preview.scope &&
    receipt.scopeImpact === preview.scopeImpact &&
    receipt.target === preview.target &&
    receipt.sourceSha256 === preview.sourceSha256 &&
    receipt.candidateSha256 === preview.candidateSha256 &&
    receipt.removedHooks === preview.removedHooks &&
    receipt.preservedHooks === preview.preservedHooks &&
    receipt.remainingLookalikes === preview.remainingLookalikes &&
    receipt.backupId === receipt.receiptId &&
    receipt.currentExactHooks === 0
  );
}
export interface DisconnectAcknowledgements {
  acknowledgeWeakenProtection: boolean;
  acknowledgeRetainedCopy: boolean;
  acknowledgeSharedScope: boolean;
}
export const emptyDisconnectAcknowledgements = (): DisconnectAcknowledgements => ({
  acknowledgeWeakenProtection: false,
  acknowledgeRetainedCopy: false,
  acknowledgeSharedScope: false,
});
export function disconnectApplyInput(
  preview: AgentDisconnectPreview,
  acknowledged: DisconnectAcknowledgements,
  now = Date.now(),
) {
  if (
    preview.operation !== 'remove-hooks' ||
    now >= Date.parse(preview.expiresAt) ||
    acknowledged.acknowledgeWeakenProtection !== true ||
    acknowledged.acknowledgeRetainedCopy !== true ||
    (preview.needs.acknowledgeSharedScope && acknowledged.acknowledgeSharedScope !== true)
  )
    return null;
  return {
    previewId: preview.previewId,
    acknowledgeWeakenProtection: true,
    acknowledgeRetainedCopy: true,
    ...(preview.needs.acknowledgeSharedScope ? { acknowledgeSharedScope: true } : {}),
  };
}
