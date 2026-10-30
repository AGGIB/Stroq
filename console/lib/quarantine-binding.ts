import type {
  SkillQuarantineArtifact,
  SkillQuarantinePreview,
  SkillQuarantineReceipt,
} from './skill-quarantine';
import type { InventoryItem } from './inventory';
import { skillSourceOf } from './skill-sources';
import { validateSkillLocation } from './skill-location';
export const sameQuarantineArtifact = (
  left: SkillQuarantineArtifact,
  right: SkillQuarantineArtifact,
) =>
  left.id === right.id &&
  left.sha256 === right.sha256 &&
  left.scope === right.scope &&
  left.agent === right.agent &&
  left.skillSource === right.skillSource &&
  left.location.label === right.location.label &&
  left.location.redacted === right.location.redacted;

/** Physical moves remain uncertain across a changed revision of the same source folder. */
export function quarantineSelectionKey(artifact: SkillQuarantineArtifact, workspaceId: string) {
  return [workspaceId, artifact.id, artifact.agent, artifact.skillSource, artifact.scope].join(
    '\0',
  );
}
export function quarantineTargetKey(artifact: SkillQuarantineArtifact, workspaceId: string) {
  return [
    quarantineSelectionKey(artifact, workspaceId),
    artifact.sha256,
    artifact.location.label,
    artifact.location.redacted,
  ].join('\0');
}
export function quarantineArtifactFromInventory(
  item: InventoryItem,
): SkillQuarantineArtifact | null {
  const skillSource = skillSourceOf(item);
  if (
    item.kind !== 'skill' ||
    !Object.hasOwn(item, 'skillSource') ||
    !skillSource ||
    item.quarantineSupported !== true ||
    item.quarantineReason !== 'supported' ||
    !validateSkillLocation(item.location) ||
    !item.sha256 ||
    item.scan.status === 'incomplete' ||
    ['missing', 'unverifiable'].includes(item.state)
  )
    return null;
  return {
    id: item.id,
    name: item.name,
    agent: item.agent as SkillQuarantineArtifact['agent'],
    skillSource,
    location: item.location,
    scope: item.scope,
    sha256: item.sha256,
  };
}
export function quarantineUnavailableReason(item: InventoryItem) {
  if (item.kind !== 'skill' || quarantineArtifactFromInventory(item)) return null;
  switch (item.quarantineReason) {
    case 'source-root':
      return 'This skill is the source root. Quarantine is unavailable.';
    case 'overlapping-skill':
      return 'This folder contains overlapping skills. Quarantine is unavailable.';
    case 'managed-source':
      return 'Managed, synced and plugin folders cannot be quarantined here.';
    case 'unsafe-location':
      return 'This location could not be verified for a physical move.';
    case 'incomplete':
      return 'Quarantine requires a complete capture of this folder.';
    default:
      return 'Refresh inventory to verify whether this folder supports quarantine.';
  }
}
export function quarantinePreviewMatches(
  preview: SkillQuarantinePreview,
  action: 'quarantine' | 'restore',
  artifact: SkillQuarantineArtifact,
  workspaceId: string,
  recordId?: string,
) {
  return (
    preview.action === action &&
    preview.workspaceId === workspaceId &&
    sameQuarantineArtifact(preview.artifact, artifact) &&
    (action !== 'restore' || preview.recordId === recordId)
  );
}
export function quarantineReceiptMatches(
  receipt: SkillQuarantineReceipt,
  preview: SkillQuarantinePreview,
) {
  return (
    receipt.id === preview.id &&
    receipt.recordId === preview.recordId &&
    receipt.action === preview.action &&
    receipt.workspaceId === preview.workspaceId &&
    sameQuarantineArtifact(receipt.artifact, preview.artifact)
  );
}
