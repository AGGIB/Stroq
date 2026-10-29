import { INVENTORY_AGENTS, type InventoryItem, type InventoryState } from './inventory';
import type { InventoryComparison } from './inventory-changes';
import { inventoryEvidenceMatches } from './inventory-binding';
import { skillSourceOf } from './skill-sources';

type Selection = Pick<
  InventoryItem,
  'id' | 'sha256' | 'reviewedSha256' | 'kind' | 'agent' | 'scope' | 'skillSource'
>;
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function inventoryComparisonKey(item: Selection | null, workspaceId: string | null) {
  if (
    !item ||
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !/^item-[a-f0-9]{24}$/.test(item.id) ||
    !sha(item.sha256) ||
    !(item.reviewedSha256 === null || sha(item.reviewedSha256)) ||
    !['skill', 'mcp'].includes(item.kind) ||
    !Object.hasOwn(INVENTORY_AGENTS, item.agent) ||
    !['project', 'user'].includes(item.scope) ||
    (item.kind === 'skill' && skillSourceOf(item) === null)
  )
    return null;
  return JSON.stringify([
    workspaceId,
    item.id,
    item.sha256,
    item.reviewedSha256,
    item.kind,
    item.agent,
    item.scope,
    skillSourceOf(item),
  ]);
}
export function inventoryComparisonInput(item: Selection | null, workspaceId: string | null) {
  if (!item || !inventoryComparisonKey(item, workspaceId) || !item.sha256) return null;
  return { id: item.id, expectedSha256: item.sha256, expectedReviewedSha256: item.reviewedSha256 };
}
export function inventoryComparisonMatches(
  comparison: InventoryComparison,
  item: Selection,
  workspaceId: string,
) {
  if (
    comparison.workspaceId !== workspaceId ||
    !inventoryEvidenceMatches(comparison.current, item, workspaceId) ||
    comparison.baseline.sha256 !== item.reviewedSha256
  )
    return false;
  const previous = comparison.baseline.evidence;
  return (
    previous === null ||
    inventoryEvidenceMatches(previous, { ...item, sha256: item.reviewedSha256 }, workspaceId)
  );
}
export function inventoryReviewDetailsLabel(
  item: Selection & Pick<InventoryItem, 'state'>,
  comparison: InventoryComparison | null,
) {
  if (
    !comparison ||
    item.state !== 'unchanged' ||
    !inventoryComparisonMatches(comparison, item, comparison.workspaceId)
  )
    return null;
  if (comparison.baseline.status === 'legacy') return 'Record review details';
  if (comparison.baseline.status === 'available' && comparison.changes?.engineChanged)
    return 'Review updated analysis';
  if (comparison.baseline.status === 'available' && comparison.changes?.files.rows.length)
    return 'Record review details';
  return null;
}
export function inventoryReviewAcknowledged(
  state: InventoryState,
  item: Selection,
  workspaceId: string,
) {
  const selected = state.items.find((entry) => entry.id === item.id);
  return (
    state.workspace.id === workspaceId &&
    state.baseline.status === 'ready' &&
    selected !== undefined &&
    selected.sha256 === item.sha256 &&
    selected.reviewedSha256 === item.sha256 &&
    selected.kind === item.kind &&
    selected.agent === item.agent &&
    selected.scope === item.scope &&
    skillSourceOf(selected) === skillSourceOf(item) &&
    selected.state === 'unchanged'
  );
}
