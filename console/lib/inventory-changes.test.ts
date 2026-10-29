import { describe, expect, it } from 'vitest';
import {
  INVENTORY_EVIDENCE_LIMITATIONS,
  validateInventoryEvidence,
  type InventoryEvidence,
} from './inventory-evidence';
import {
  deriveInventoryChanges,
  INVENTORY_COMPARISON_LIMITATIONS,
  validateInventoryComparison,
  type InventoryComparison,
} from './inventory-changes';

const sha = (s: string) => s.repeat(64);
const workspaceId = `workspace-${'a'.repeat(24)}`;
const file = (
  id: string,
  label: string,
  digest: string,
  suspect = false,
): InventoryEvidence['files'][number] => ({
  id: `file-${id.repeat(24)}`,
  label,
  labelHidden: false,
  sha256: sha(digest),
  bytes: 10,
  markdown: label.endsWith('.md'),
  scan: label.endsWith('.md')
    ? { status: suspect ? 'suspect' : 'clean', score: suspect ? 0.9 : 0, findings: suspect ? 1 : 0 }
    : { status: 'not-scanned', score: null, findings: 0 },
});
function evidence(current = false): InventoryEvidence {
  return {
    schema: 'stroq-inventory-evidence/1',
    source: 'local',
    generatedAt: current ? '2026-10-23T10:00:01.000Z' : '2026-10-23T08:00:01.000Z',
    workspaceId,
    artifact: {
      id: `item-${'b'.repeat(24)}`,
      kind: 'skill',
      agent: 'claude-code',
      scope: 'project',
      name: 'Notes',
      sha256: sha(current ? 'b' : 'a'),
      digestFormat: 'stroq-tree/1',
    },
    engine: {
      version: '0.28.0',
      rulesSha256: sha('c'),
      ruleCount: 100,
      inspectorRulesId: 'stroq-vet-rules/2',
      threshold: 0.6,
      target: 'instruction_file',
    },
    scan: {
      status: current ? 'suspect' : 'clean',
      score: current ? 0.9 : 0,
      findings: current ? 1 : 0,
      timedOut: false,
    },
    capabilities: current
      ? [
          { kind: 'fs.read', count: 1 },
          { kind: 'exec', count: 1 },
        ]
      : [{ kind: 'fs.read', count: 1 }],
    files: [
      file('1', 'SKILL.md', current ? 'b' : 'a', current),
      file('2', 'helper.js', 'c'),
      current ? file('4', 'new.md', 'd') : file('3', 'old.md', 'e'),
    ],
    matches: current
      ? [
          {
            fileId: `file-${'1'.repeat(24)}`,
            ruleId: 'STROQ-FIXED',
            title: 'Fixed rule',
            severity: 'high',
            category: 'injection',
            variant: 'raw',
          },
        ]
      : [],
    coverage: {
      capturedFiles: 3,
      markdownFiles: 2,
      scannedMarkdownFiles: 2,
      omittedFileDetails: 0,
      omittedMatchDetails: 0,
      incomplete: false,
      gaps: [],
    },
    mcp: null,
    capture: {
      startedAt: current ? '2026-10-23T10:00:00.000Z' : '2026-10-23T08:00:00.000Z',
      completedAt: current ? '2026-10-23T10:00:02.000Z' : '2026-10-23T08:00:02.000Z',
      atomicSnapshot: false,
    },
    limitations: [...INVENTORY_EVIDENCE_LIMITATIONS],
  };
}
function comparison(before = evidence(), current = evidence(true)): InventoryComparison {
  return {
    schema: 'stroq-inventory-comparison/1',
    source: 'local',
    generatedAt: '2026-10-23T10:00:03.000Z',
    workspaceId,
    current,
    baseline: {
      status: 'available',
      reviewedAt: '2026-10-23T09:00:00.000Z',
      sha256: before.artifact.sha256,
      evidence: before,
    },
    changes: deriveInventoryChanges(current, before),
    limitations: [...INVENTORY_COMPARISON_LIMITATIONS],
  };
}
describe('derived artifact revision comparison', () => {
  it('shows exact captured additions, modifications, removals, capabilities and new rule signals', () => {
    const result = comparison();
    expect(validateInventoryEvidence(result.current)).toBe(true);
    expect(validateInventoryEvidence(result.baseline.evidence)).toBe(true);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes?.files.rows.map((row) => [row.label, row.state])).toEqual([
      ['SKILL.md', 'modified'],
      ['old.md', 'removed'],
      ['new.md', 'added'],
    ]);
    expect(result.changes?.files.unchanged).toBe(1);
    expect(result.changes?.capabilities).toEqual({
      comparable: true,
      rows: [{ kind: 'exec', before: 0, after: 1 }],
    });
    expect(result.changes?.signals.added.map((match) => match.ruleId)).toEqual(['STROQ-FIXED']);
  });
  it('does not infer file addition or removal from omitted details on either side', () => {
    const old = evidence(),
      current = evidence(true);
    for (const report of [old, current])
      Object.assign(report.coverage, {
        capturedFiles: 4,
        markdownFiles: 3,
        scannedMarkdownFiles: 3,
        omittedFileDetails: 1,
      });
    const result = comparison(old, current);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes?.files.rows.map((row) => row.state)).toEqual([
      'modified',
      'unobserved-current',
      'unobserved-before',
    ]);
    expect(result.changes?.capabilities.comparable).toBe(false);
    expect(result.changes?.signals.comparable).toBe(false);
    const forged = structuredClone(result);
    forged.changes!.files.rows[1]!.state = 'removed';
    expect(validateInventoryComparison(forged)).toBe(false);
  });
  it('keeps byte changes comparable across engine updates while withholding analysis deltas', () => {
    const result = comparison();
    result.current.engine.version = '0.29.0';
    result.changes = deriveInventoryChanges(result.current, result.baseline.evidence!);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes.engineChanged).toBe(true);
    expect(result.changes.files.rows).toHaveLength(3);
    expect(result.changes.capabilities).toEqual({ comparable: false, rows: [] });
    expect(result.changes.signals).toEqual({
      comparable: false,
      added: [],
      removed: [],
      unchanged: 0,
    });
  });
  it('retains static scope gaps instead of claiming reduced capabilities or resolved signals', () => {
    const old = evidence(),
      current = evidence(true);
    current.coverage.incomplete = true;
    current.coverage.gaps = ['static-analysis-incomplete'];
    current.scan.status = 'incomplete';
    const result = comparison(old, current);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes?.capabilities.comparable).toBe(false);
    expect(result.changes?.signals.comparable).toBe(false);
    expect(result.changes?.files.completeAfter).toBe(true);
  });
  it('binds baseline workspace, artifact identity, digest and per-entry review time', () => {
    for (const patch of [
      (v: InventoryComparison) => {
        v.baseline.evidence!.workspaceId = `workspace-${'d'.repeat(24)}`;
      },
      (v: InventoryComparison) => {
        v.baseline.evidence!.artifact.id = `item-${'d'.repeat(24)}`;
      },
      (v: InventoryComparison) => {
        v.baseline.evidence!.artifact.scope = 'user';
      },
      (v: InventoryComparison) => {
        v.baseline.sha256 = sha('d');
      },
      (v: InventoryComparison) => {
        v.baseline.reviewedAt = '2026-10-23T07:00:00.000Z';
      },
      (v: InventoryComparison) => {
        v.baseline.reviewedAt = '2026-10-23T11:00:00.000Z';
      },
      (v: InventoryComparison) => {
        v.changes!.artifactChanged = false;
      },
    ]) {
      const result = comparison();
      patch(result);
      expect(validateInventoryComparison(result)).toBe(false);
    }
  });
  it('keeps missing, legacy and invalid baselines distinct without inventing historical details', () => {
    for (const status of ['missing', 'legacy', 'invalid'] as const) {
      const result = comparison();
      result.baseline = {
        status,
        reviewedAt: null,
        sha256: status === 'legacy' ? sha('a') : null,
        evidence: null,
      };
      result.changes = null;
      expect(validateInventoryComparison(result)).toBe(true);
      expect(validateInventoryComparison({ ...result, changes: comparison().changes })).toBe(false);
      expect(
        validateInventoryComparison({
          ...result,
          baseline: { ...result.baseline, reviewedAt: '2026-10-23T09:00:00.000Z' },
        }),
      ).toBe(false);
    }
  });
  it('refuses injected source text or forged derived rows even with otherwise valid captures', () => {
    const result = comparison();
    expect(validateInventoryComparison({ ...result, raw: 'PRIVATE' })).toBe(false);
    expect(
      validateInventoryComparison({
        ...result,
        changes: { ...result.changes, command: 'PRIVATE' },
      }),
    ).toBe(false);
    expect(
      validateInventoryComparison({ ...result, current: { ...result.current, raw: 'PRIVATE' } }),
    ).toBe(false);
    const reordered = JSON.parse(JSON.stringify(result), (key, value) =>
      key === 'files' && value?.rows ? Object.fromEntries(Object.entries(value).reverse()) : value,
    );
    expect(validateInventoryComparison(reordered)).toBe(true);
  });
  it('separates an MCP sibling-only source edit from selected-entry drift', () => {
    const old = evidence(),
      current = evidence(true);
    for (const report of [old, current]) {
      report.artifact.kind = 'mcp';
      report.artifact.agent = 'cursor';
      report.artifact.digestFormat = 'mcp-entry-canonical-json/1';
      report.artifact.sha256 = sha('a');
      report.scan = { status: 'not-scanned', score: null, findings: 0, timedOut: false };
      report.capabilities = [];
      report.matches = [];
      report.files = [
        { ...file('1', 'helper.js', report === old ? 'a' : 'b'), label: 'Configuration' },
      ];
      report.coverage = {
        capturedFiles: 1,
        markdownFiles: 0,
        scannedMarkdownFiles: 0,
        omittedFileDetails: 0,
        omittedMatchDetails: 0,
        incomplete: false,
        gaps: [],
      };
      report.mcp = { transport: 'stdio', wrapper: 'not-configured', strict: false };
    }
    let result = comparison(old, current);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes?.mcp).toMatchObject({ entryChanged: false, sourceChanged: true });
    current.artifact.sha256 = sha('c');
    current.mcp = { transport: 'http', wrapper: 'not-configured', strict: false };
    result = comparison(old, current);
    expect(validateInventoryComparison(result)).toBe(true);
    expect(result.changes?.mcp?.transport).toEqual({ before: 'stdio', after: 'http' });
    expect(result.changes?.mcp?.entryChanged).toBe(true);
  });
});
