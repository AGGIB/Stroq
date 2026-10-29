import type { InventoryItem } from './inventory';
import { skillSourceOf } from './skill-sources';
import {
  signalBindingKey,
  signalReasonMatches,
  validateInventorySignalPreview,
  validateInventorySignalReceipt,
  validateInventorySignalState,
  type InventorySignalPreview,
  type InventorySignalState,
  type SignalDecision,
  type SignalReason,
} from './inventory-signal-decision';

type Selection = Pick<InventoryItem, 'id' | 'kind' | 'agent' | 'scope' | 'sha256' | 'skillSource'>;
export function inventorySignalSelectionKey(item: Selection | null, workspaceId: string | null) {
  if (
    !item ||
    item.kind !== 'skill' ||
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !/^item-[a-f0-9]{24}$/.test(item.id) ||
    !item.sha256 ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !['project', 'user'].includes(item.scope)
  )
    return null;
  const source = skillSourceOf(item);
  return source
    ? JSON.stringify([workspaceId, item.id, item.agent, source, item.scope, item.sha256])
    : null;
}
export function inventorySignalStateMatches(
  value: unknown,
  item: Selection,
  workspaceId: string,
): value is InventorySignalState {
  if (!inventorySignalSelectionKey(item, workspaceId) || !validateInventorySignalState(value))
    return false;
  const artifact = value.artifact;
  return (
    value.workspaceId === workspaceId &&
    artifact.id === item.id &&
    artifact.agent === item.agent &&
    artifact.scope === item.scope &&
    artifact.sha256 === item.sha256 &&
    artifact.skillSource === skillSourceOf(item)
  );
}
export function inventorySignalPreviewInput(
  state: InventorySignalState,
  item: Selection,
  workspaceId: string,
  decision: SignalDecision,
  reason: SignalReason,
) {
  if (
    !inventorySignalStateMatches(state, item, workspaceId) ||
    !signalReasonMatches(decision, reason) ||
    !state.binding ||
    state.store.status === 'unavailable' ||
    state.reason === 'incomplete' ||
    (decision === 'reopened'
      ? !state.decision || state.decision.decision === 'reopened'
      : !state.eligible)
  )
    return null;
  return {
    id: item.id,
    expectedSha256: item.sha256!,
    expectedDecisionId: state.decision?.id ?? null,
    decision,
    reason,
  };
}
export function inventorySignalPreviewMatches(
  value: unknown,
  state: InventorySignalState,
  item: Selection,
  workspaceId: string,
  decision: SignalDecision,
  reason: SignalReason,
  now = Date.now(),
): value is InventorySignalPreview {
  if (
    !validateInventorySignalPreview(value) ||
    !inventorySignalPreviewInput(state, item, workspaceId, decision, reason) ||
    !inventorySignalStateMatches(value.state, item, workspaceId) ||
    !value.state.binding ||
    !state.binding
  )
    return false;
  return (
    value.workspaceId === workspaceId &&
    value.decision === decision &&
    value.reason === reason &&
    value.expectedDecisionId === (state.decision?.id ?? null) &&
    value.state.store.revision === state.store.revision &&
    value.state.findings === state.findings &&
    signalBindingKey(value.state.binding) === signalBindingKey(state.binding) &&
    Date.parse(value.expiresAt) > now
  );
}
export function inventorySignalApplyInput(
  preview: InventorySignalPreview,
  acknowledged: boolean,
  now = Date.now(),
) {
  return validateInventorySignalPreview(preview) &&
    acknowledged &&
    Date.parse(preview.expiresAt) > now
    ? { previewId: preview.previewId, acknowledgeSignalOnly: true as const }
    : null;
}
export function inventorySignalReceiptMatches(
  value: unknown,
  preview: InventorySignalPreview,
  item: Selection,
  workspaceId: string,
) {
  if (
    !validateInventorySignalReceipt(value) ||
    !inventorySignalStateMatches(value.state, item, workspaceId) ||
    !value.state.binding ||
    !preview.state.binding ||
    !value.state.decision
  )
    return false;
  return (
    value.workspaceId === workspaceId &&
    value.previewId === preview.previewId &&
    value.decision === preview.decision &&
    value.state.decision.reason === preview.reason &&
    Date.parse(value.recordedAt) >= Date.parse(preview.state.generatedAt) &&
    signalBindingKey(value.state.binding) === signalBindingKey(preview.state.binding)
  );
}
