import { describe, expect, it } from 'vitest';
import { INVENTORY_EVIDENCE_LIMITATIONS, type InventoryEvidence } from './inventory-evidence';
import {
  deriveInventoryChanges,
  INVENTORY_COMPARISON_LIMITATIONS,
  validateInventoryComparison,
  type InventoryComparison,
} from './inventory-changes';
import type { InventoryItem } from './inventory';
import {
  inventoryComparisonInput,
  inventoryComparisonKey,
  inventoryComparisonMatches,
  inventoryReviewAcknowledged,
  inventoryReviewDetailsLabel,
} from './inventory-comparison-binding';

const workspaceId = `workspace-${'a'.repeat(24)}`;
const item: InventoryItem = {
  id: `item-${'b'.repeat(24)}`,
  kind: 'skill',
  agent: 'claude-code',
  scope: 'project',
  fileType: 'skill-tree',
  name: 'Release notes',
  sha256: 'c'.repeat(64),
  reviewedSha256: 'd'.repeat(64),
  state: 'changed',
  scan: { status: 'clean', findings: 0 },
  capabilities: [],
};
function evidence(sha256: string, earlier = false): InventoryEvidence {
  const completedAt = earlier ? '2026-10-23T10:00:01.000Z' : '2026-10-23T12:00:01.000Z';
  return {
    schema: 'stroq-inventory-evidence/1',
    source: 'local',
    generatedAt: completedAt,
    workspaceId,
    artifact: {
      id: item.id,
      kind: 'skill',
      agent: 'claude-code',
      scope: 'project',
      name: item.name,
      sha256,
      digestFormat: 'stroq-tree/1',
    },
    engine: {
      version: '0.28.0',
      rulesSha256: 'e'.repeat(64),
      ruleCount: 621,
      inspectorRulesId: 'stroq-vet-rules/2',
      threshold: 0.6,
      target: 'instruction_file',
    },
    scan: { status: 'clean', score: 0, findings: 0, timedOut: false },
    capabilities: [],
    files: [
      {
        id: `file-${'f'.repeat(24)}`,
        label: 'SKILL.md',
        labelHidden: false,
        sha256,
        bytes: 120,
        markdown: true,
        scan: { status: 'clean', score: 0, findings: 0 },
      },
    ],
    matches: [],
    coverage: {
      capturedFiles: 1,
      markdownFiles: 1,
      scannedMarkdownFiles: 1,
      omittedFileDetails: 0,
      omittedMatchDetails: 0,
      incomplete: false,
      gaps: [],
    },
    mcp: null,
    capture: { startedAt: completedAt, completedAt, atomicSnapshot: false },
    limitations: [...INVENTORY_EVIDENCE_LIMITATIONS],
  };
}
function fixture(): InventoryComparison {
  const current = evidence(item.sha256!);
  const previous = evidence(item.reviewedSha256!, true);
  return {
    schema: 'stroq-inventory-comparison/1',
    source: 'local',
    generatedAt: '2026-10-23T12:00:02.000Z',
    workspaceId,
    current,
    baseline: {
      status: 'available',
      reviewedAt: '2026-10-23T10:00:02.000Z',
      sha256: item.reviewedSha256,
      evidence: previous,
    },
    changes: deriveInventoryChanges(current, previous),
    limitations: [...INVENTORY_COMPARISON_LIMITATIONS],
  };
}
describe('skill source binding', () => {
  it('source changes invalidate an existing comparison key', () => {
    const a = { ...item, agent: 'windsurf' as const, skillSource: 'windsurf-skills' as const };
    const b = { ...a, skillSource: 'devin-skills' as const };
    expect(inventoryComparisonKey(a, workspaceId)).not.toBe(inventoryComparisonKey(b, workspaceId));
  });
});

describe('reviewed-to-current comparison binding', () => {
  it('keys both revisions, workspace, artifact identity, kind, agent and scope', () => {
    const original = inventoryComparisonKey(item, workspaceId);
    expect(original).not.toBeNull();
    for (const changed of [
      { id: `item-${'1'.repeat(24)}` },
      { sha256: '2'.repeat(64) },
      { reviewedSha256: '3'.repeat(64) },
      { reviewedSha256: null },
      { kind: 'mcp' as const, agent: 'cursor' as const, fileType: 'mcp-config' as const },
      { agent: 'cursor' as const },
      { scope: 'user' as const },
    ])
      expect(inventoryComparisonKey({ ...item, ...changed }, workspaceId)).not.toBe(original);
    expect(inventoryComparisonKey(item, `workspace-${'4'.repeat(24)}`)).not.toBe(original);
    expect(inventoryComparisonKey(null, workspaceId)).toBeNull();
    expect(inventoryComparisonKey({ ...item, sha256: null }, workspaceId)).toBeNull();
    expect(inventoryComparisonKey(item, '/private/workspace')).toBeNull();
  });
  it('builds one closed read-only comparison request including the exact expected baseline', () => {
    expect(inventoryComparisonInput(item, workspaceId)).toEqual({
      id: item.id,
      expectedSha256: item.sha256,
      expectedReviewedSha256: item.reviewedSha256,
    });
    expect(inventoryComparisonInput({ ...item, reviewedSha256: null }, workspaceId)).toEqual({
      id: item.id,
      expectedSha256: item.sha256,
      expectedReviewedSha256: null,
    });
    expect(
      inventoryComparisonInput({ ...item, reviewedSha256: '/private/secret' }, workspaceId),
    ).toBeNull();
  });
  it('requires the exact current and reviewed captures even when an unrelated report is otherwise valid', () => {
    const comparison = fixture();
    expect(validateInventoryComparison(comparison)).toBe(true);
    expect(inventoryComparisonMatches(comparison, item, workspaceId)).toBe(true);
    for (const selected of [
      { ...item, sha256: '1'.repeat(64) },
      { ...item, reviewedSha256: '2'.repeat(64) },
      { ...item, scope: 'user' as const },
      { ...item, agent: 'cursor' as const },
      { ...item, kind: 'mcp' as const },
      { ...item, id: `item-${'3'.repeat(24)}` },
    ])
      expect(inventoryComparisonMatches(comparison, selected, workspaceId)).toBe(false);
    expect(inventoryComparisonMatches(comparison, item, `workspace-${'4'.repeat(24)}`)).toBe(false);
    for (const field of [
      { id: `item-${'5'.repeat(24)}` },
      { kind: 'mcp' as const },
      { agent: 'cursor' as const },
      { scope: 'user' as const },
      { sha256: '6'.repeat(64) },
    ]) {
      const previous = comparison.baseline.evidence!;
      expect(
        inventoryComparisonMatches(
          {
            ...comparison,
            baseline: {
              ...comparison.baseline,
              evidence: { ...previous, artifact: { ...previous.artifact, ...field } },
            },
          },
          item,
          workspaceId,
        ),
      ).toBe(false);
    }
  });
  it('accepts honest missing/legacy/invalid states only for their matching baseline revision', () => {
    const comparison = fixture();
    const legacy: InventoryComparison = {
      ...comparison,
      baseline: { status: 'legacy', sha256: item.reviewedSha256, evidence: null, reviewedAt: null },
      changes: null,
    };
    expect(validateInventoryComparison(legacy)).toBe(true);
    expect(inventoryComparisonMatches(legacy, item, workspaceId)).toBe(true);
    for (const status of ['missing', 'invalid'] as const) {
      const missing: InventoryComparison = {
        ...comparison,
        baseline: { status, sha256: null, evidence: null, reviewedAt: null },
        changes: null,
      };
      expect(validateInventoryComparison(missing)).toBe(true);
      expect(inventoryComparisonMatches(missing, item, workspaceId)).toBe(false);
      expect(
        inventoryComparisonMatches(missing, { ...item, reviewedSha256: null }, workspaceId),
      ).toBe(true);
    }
  });
  it('permits explicit legacy detail capture and changed analysis without reenabling ordinary unchanged reviews', () => {
    const unchanged = { ...item, state: 'unchanged' as const, reviewedSha256: item.sha256 };
    const comparison = fixture();
    const legacy: InventoryComparison = {
      ...comparison,
      baseline: { status: 'legacy', reviewedAt: null, sha256: item.sha256, evidence: null },
      changes: null,
    };
    expect(inventoryReviewDetailsLabel(unchanged, legacy)).toBe('Record review details');
    expect(inventoryReviewDetailsLabel(item, comparison)).toBeNull();
    const same = evidence(item.sha256!, true);
    const ready: InventoryComparison = {
      ...comparison,
      baseline: { ...comparison.baseline, sha256: item.sha256, evidence: same },
      changes: deriveInventoryChanges(comparison.current, same),
    };
    expect(inventoryReviewDetailsLabel(unchanged, ready)).toBeNull();
    const updated = {
      ...ready.current,
      engine: { ...ready.current.engine, rulesSha256: '7'.repeat(64) },
    };
    const changed: InventoryComparison = {
      ...ready,
      current: updated,
      changes: deriveInventoryChanges(updated, same),
    };
    expect(validateInventoryComparison(changed)).toBe(true);
    expect(inventoryReviewDetailsLabel(unchanged, changed)).toBe('Review updated analysis');
    expect(
      inventoryReviewDetailsLabel(unchanged, {
        ...legacy,
        baseline: { ...legacy.baseline, status: 'invalid', sha256: null },
      }),
    ).toBeNull();
  });
  it('requires the review acknowledgement to retain the selected version in this exact workspace and source', () => {
    const selected = { ...item, state: 'unchanged' as const, reviewedSha256: item.sha256 };
    const result = {
      schema: 'stroq-inventory/1' as const,
      source: 'local' as const,
      generatedAt: '2026-10-23T12:00:02.000Z',
      workspace: { id: workspaceId, label: 'Fixture' },
      baseline: { status: 'ready' as const, reviewedAt: '2026-10-23T12:00:02.000Z' },
      items: [selected],
      gaps: [],
      limitations: [],
    };
    expect(inventoryReviewAcknowledged(result, item, workspaceId)).toBe(true);
    expect(inventoryReviewAcknowledged({ ...result, items: [] }, item, workspaceId)).toBe(false);
    for (const change of [
      { sha256: '8'.repeat(64) },
      { reviewedSha256: item.reviewedSha256 },
      { state: 'changed' as const },
      { scope: 'user' as const },
      { agent: 'cursor' as const },
      { kind: 'mcp' as const },
    ])
      expect(
        inventoryReviewAcknowledged(
          { ...result, items: [{ ...selected, ...change }] },
          item,
          workspaceId,
        ),
      ).toBe(false);
    expect(
      inventoryReviewAcknowledged(
        { ...result, workspace: { ...result.workspace, id: `workspace-${'9'.repeat(24)}` } },
        item,
        workspaceId,
      ),
    ).toBe(false);
  });
  it('allows recording an unchanged MCP entry source capture without reviewing its sibling entries', () => {
    const mcpEvidence = (fileSha: string, earlier: boolean): InventoryEvidence => {
      const base = evidence(item.sha256!, earlier);
      return {
        ...base,
        artifact: {
          ...base.artifact,
          kind: 'mcp',
          agent: 'cursor',
          digestFormat: 'mcp-entry-canonical-json/1',
        },
        scan: { status: 'not-scanned', score: null, findings: 0, timedOut: false },
        files: [
          {
            ...base.files[0]!,
            label: 'Configuration',
            sha256: fileSha,
            markdown: false,
            scan: { status: 'not-scanned', score: null, findings: 0 },
          },
        ],
        coverage: { ...base.coverage, markdownFiles: 0, scannedMarkdownFiles: 0 },
        mcp: { transport: 'stdio', wrapper: 'not-configured', strict: false },
      };
    };
    const current = mcpEvidence('8'.repeat(64), false),
      previous = mcpEvidence('9'.repeat(64), true);
    const comparison: InventoryComparison = {
      ...fixture(),
      current,
      baseline: {
        status: 'available',
        reviewedAt: '2026-10-23T10:00:02.000Z',
        sha256: item.sha256,
        evidence: previous,
      },
      changes: deriveInventoryChanges(current, previous),
    };
    const unchanged = {
      ...item,
      kind: 'mcp' as const,
      agent: 'cursor' as const,
      state: 'unchanged' as const,
      reviewedSha256: item.sha256,
    };
    expect(validateInventoryComparison(comparison)).toBe(true);
    expect(comparison.changes?.mcp).toMatchObject({ entryChanged: false, sourceChanged: true });
    expect(inventoryReviewDetailsLabel(unchanged, comparison)).toBe('Record review details');
  });
});
