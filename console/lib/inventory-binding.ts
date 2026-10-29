import type { InventoryEvidence, InventoryItem } from './inventory';
import { skillSourceOf } from './skill-sources';

/** A valid response must still describe the exact artifact requested by this view. */
export function inventoryEvidenceMatches(
  report: Pick<InventoryEvidence, 'workspaceId' | 'artifact'>,
  item: Pick<InventoryItem, 'id' | 'sha256' | 'kind' | 'agent' | 'scope' | 'skillSource'>,
  workspaceId: string,
) {
  return (
    report.workspaceId === workspaceId &&
    item.sha256 !== null &&
    report.artifact.id === item.id &&
    report.artifact.sha256 === item.sha256 &&
    report.artifact.kind === item.kind &&
    report.artifact.agent === item.agent &&
    report.artifact.scope === item.scope &&
    (item.kind !== 'skill' || skillSourceOf(item) !== null) &&
    skillSourceOf(report.artifact) === skillSourceOf(item)
  );
}
