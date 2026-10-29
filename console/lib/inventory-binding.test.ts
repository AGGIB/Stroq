import { describe, expect, it } from 'vitest';
import { inventoryEvidenceMatches } from './inventory-binding';
import type { InventoryEvidence, InventoryItem } from './inventory';

const item: Pick<InventoryItem, 'id' | 'sha256' | 'kind' | 'agent' | 'scope'> = {
  id: `item-${'a'.repeat(24)}`,
  sha256: 'b'.repeat(64),
  kind: 'skill',
  agent: 'claude-code',
  scope: 'project',
};
const workspaceId = `workspace-${'c'.repeat(24)}`;
const report: Pick<InventoryEvidence, 'workspaceId' | 'artifact'> = {
  workspaceId,
  artifact: { ...item, name: 'release-notes', sha256: item.sha256!, digestFormat: 'stroq-tree/1' },
};
describe('captured evidence cannot cross an artifact selection boundary', () => {
  it('refuses cross-source responses even when all opaque IDs and digests match', () => {
    const selected = {
      ...item,
      agent: 'windsurf' as const,
      skillSource: 'windsurf-skills' as const,
    };
    const observed = {
      ...report,
      artifact: {
        ...report.artifact,
        agent: 'windsurf' as const,
        skillSource: 'devin-skills' as const,
      },
    };
    expect(inventoryEvidenceMatches(observed, selected, workspaceId)).toBe(false);
  });
  it('accepts the requested fingerprint in the same workspace', () =>
    expect(inventoryEvidenceMatches(report, item, workspaceId)).toBe(true));
  it('refuses different workspace, digest, identity, type, agent and scope', () => {
    expect(
      inventoryEvidenceMatches(
        { ...report, workspaceId: `workspace-${'d'.repeat(24)}` },
        item,
        workspaceId,
      ),
    ).toBe(false);
    for (const changed of [
      { id: `item-${'e'.repeat(24)}` },
      { sha256: 'f'.repeat(64) },
      { kind: 'mcp' as const },
      { agent: 'cursor' as const },
      { scope: 'user' as const },
    ])
      expect(
        inventoryEvidenceMatches(
          { ...report, artifact: { ...report.artifact, ...changed } },
          item,
          workspaceId,
        ),
      ).toBe(false);
    expect(inventoryEvidenceMatches(report, { ...item, sha256: null }, workspaceId)).toBe(false);
  });
});
