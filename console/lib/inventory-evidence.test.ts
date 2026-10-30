import { describe, expect, it } from 'vitest';
import {
  INVENTORY_EVIDENCE_LIMITATIONS,
  LEGACY_INVENTORY_EVIDENCE_LIMITATIONS,
  validateInventoryEvidence,
} from './inventory-evidence';

const fixture = () => ({
  schema: 'stroq-inventory-evidence/1',
  source: 'local',
  generatedAt: '2026-10-23T01:02:04.000Z',
  workspaceId: `workspace-${'a'.repeat(24)}`,
  artifact: {
    id: `item-${'b'.repeat(24)}`,
    kind: 'skill',
    agent: 'claude-code',
    scope: 'project',
    name: 'Release notes',
    sha256: 'c'.repeat(64),
    digestFormat: 'stroq-tree/1',
  },
  engine: {
    version: '0.28.0',
    rulesSha256: 'd'.repeat(64),
    ruleCount: 621,
    inspectorRulesId: 'stroq-vet-rules/2',
    threshold: 0.6,
    target: 'instruction_file',
  },
  scan: { status: 'clean', score: 0.4, findings: 1, timedOut: false },
  capabilities: [{ kind: 'net', count: 1 }],
  files: [
    {
      id: `file-${'e'.repeat(24)}`,
      label: 'SKILL.md',
      labelHidden: false,
      sha256: 'f'.repeat(64),
      bytes: 120,
      markdown: true,
      scan: { status: 'clean', score: 0.4, findings: 1 },
    },
  ],
  matches: [
    {
      fileId: `file-${'e'.repeat(24)}`,
      ruleId: 'STROQ-2026-00005',
      title: 'Remote script execution',
      severity: 'medium',
      category: 'prompt-injection',
      variant: 'raw',
    },
  ],
  coverage: {
    capturedFiles: 1,
    markdownFiles: 1,
    scannedMarkdownFiles: 1,
    omittedFileDetails: 0,
    omittedMatchDetails: 0,
    incomplete: true,
    gaps: ['prose-capabilities-uninspected'],
  },
  mcp: null,
  capture: {
    startedAt: '2026-10-23T01:02:03.000Z',
    completedAt: '2026-10-23T01:02:04.000Z',
    atomicSnapshot: false,
  },
  limitations: [...INVENTORY_EVIDENCE_LIMITATIONS],
});

describe('inventory evidence boundary', () => {
  it('requires explicit valid provenance for new skill sources and keeps legacy evidence readable', () => {
    expect(validateInventoryEvidence(fixture())).toBe(true);
    const report = {
      ...fixture(),
      artifact: { ...fixture().artifact, agent: 'shared', skillSource: 'agents-skills' },
    };
    expect(validateInventoryEvidence(report)).toBe(true);
    expect(
      validateInventoryEvidence({
        ...report,
        artifact: { ...report.artifact, agent: 'claude-code' },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...report,
        artifact: { ...report.artifact, skillSource: undefined },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        limitations: [...LEGACY_INVENTORY_EVIDENCE_LIMITATIONS],
      }),
    ).toBe(true);
    expect(
      validateInventoryEvidence({
        ...report,
        limitations: [...LEGACY_INVENTORY_EVIDENCE_LIMITATIONS],
      }),
    ).toBe(false);
  });
  it('retains below-threshold matches independently from static scope limits', () => {
    expect(validateInventoryEvidence(fixture())).toBe(true);
    const suspect = fixture();
    suspect.scan = { status: 'suspect', score: 1, findings: 1, timedOut: false };
    suspect.files[0]!.scan = { status: 'suspect', score: 1, findings: 1 };
    expect(validateInventoryEvidence(suspect)).toBe(true);
  });

  it('rejects unsupported protection claims, extra raw fields and missing scope caveats', () => {
    for (const report of [
      { ...fixture(), protected: true },
      { ...fixture(), capture: { ...fixture().capture, atomicSnapshot: true } },
      { ...fixture(), artifact: { ...fixture().artifact, path: '/private/credential' } },
      { ...fixture(), files: [{ ...fixture().files[0], content: 'private content' }] },
      { ...fixture(), matches: [{ ...fixture().matches[0], snippet: 'private content' }] },
      { ...fixture(), limitations: [] },
      { ...fixture(), limitations: ['Everything is protected.'] },
    ])
      expect(validateInventoryEvidence(report)).toBe(false);
  });

  it('requires captured file references and accurate omission counts', () => {
    expect(
      validateInventoryEvidence({
        ...fixture(),
        matches: [{ ...fixture().matches[0], fileId: `file-${'1'.repeat(24)}` }],
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({ ...fixture(), files: [...fixture().files, ...fixture().files] }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        matches: [...fixture().matches, ...fixture().matches],
      }),
    ).toBe(false);
    for (const patch of [
      { capturedFiles: 2 },
      { markdownFiles: 0 },
      { scannedMarkdownFiles: 0 },
      { omittedFileDetails: 1 },
      { omittedMatchDetails: 1 },
      { capturedFiles: 129 },
    ])
      expect(
        validateInventoryEvidence({ ...fixture(), coverage: { ...fixture().coverage, ...patch } }),
      ).toBe(false);
    const omitted = fixture();
    omitted.scan.findings = 5;
    omitted.coverage = {
      ...omitted.coverage,
      capturedFiles: 2,
      markdownFiles: 2,
      scannedMarkdownFiles: 2,
      omittedFileDetails: 1,
      omittedMatchDetails: 4,
    };
    expect(validateInventoryEvidence(omitted)).toBe(true);
  });

  it('does not accept a clean verdict above threshold or missing timeout and failed-read evidence', () => {
    for (const patch of [
      { score: 0.6 },
      { status: 'suspect' },
      { timedOut: true },
      { status: 'not-scanned', score: null },
    ])
      expect(
        validateInventoryEvidence({ ...fixture(), scan: { ...fixture().scan, ...patch } }),
      ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        files: [
          { ...fixture().files[0], scan: { status: 'invalid-utf8', score: null, findings: 0 } },
        ],
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        coverage: { ...fixture().coverage, gaps: ['scan-timeout'] },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({ ...fixture(), engine: { ...fixture().engine, threshold: 0.2 } }),
    ).toBe(false);
  });

  it('refuses source byte claims beyond the bounded captured tree', () => {
    const report = fixture();
    report.files[0]!.bytes = 200_000;
    const extra = (index: number) => ({
      ...report.files[0]!,
      id: `file-${String(index).repeat(24)}`,
      label: `notes-${index}.md`,
      scan: { status: 'clean', score: 0, findings: 0 },
    });
    report.files.push(extra(1));
    report.coverage.capturedFiles = 2;
    report.coverage.markdownFiles = 2;
    report.coverage.scannedMarkdownFiles = 2;
    expect(validateInventoryEvidence(report)).toBe(true);
    report.files.push(extra(2));
    report.coverage.capturedFiles = 3;
    report.coverage.markdownFiles = 3;
    report.coverage.scannedMarkdownFiles = 3;
    expect(validateInventoryEvidence(report)).toBe(false);
  });

  it('rejects unsafe names, unknown gap codes and reordered or impossible capture times', () => {
    for (const label of [
      '../outside.md',
      '/absolute.md',
      'folder\\outside.md',
      'OPENAI_API_KEY.md',
      'AWS_ACCESS_KEY_ID.md',
      'GH_PAT.md',
      '.env.production',
      'safe\u202efile.md',
    ])
      expect(
        validateInventoryEvidence({ ...fixture(), files: [{ ...fixture().files[0], label }] }),
      ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        artifact: { ...fixture().artifact, name: 'PRIVATE_TOKEN' },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        coverage: { ...fixture().coverage, gaps: ['assumed-protected'] },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        coverage: { ...fixture().coverage, incomplete: false },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        capture: { ...fixture().capture, completedAt: '2026-10-23T01:02:02.000Z' },
      }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({ ...fixture(), generatedAt: '2026-10-23T01:02:02.000Z' }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({ ...fixture(), generatedAt: '2026-10-23T01:02:05.000Z' }),
    ).toBe(false);
    expect(
      validateInventoryEvidence({
        ...fixture(),
        files: [{ ...fixture().files[0], label: 'File 1', labelHidden: true }],
      }),
    ).toBe(true);
  });

  it('keeps MCP configuration evidence separate from content and runtime scans', () => {
    const skill = fixture();
    const mcp = {
      ...skill,
      artifact: { ...skill.artifact, kind: 'mcp', digestFormat: 'mcp-entry-canonical-json/1' },
      scan: { status: 'not-scanned', score: null, findings: 0, timedOut: false },
      capabilities: [],
      files: [
        {
          ...skill.files[0],
          label: 'Configuration',
          markdown: false,
          scan: { status: 'not-scanned', score: null, findings: 0 },
        },
      ],
      matches: [],
      coverage: {
        ...skill.coverage,
        markdownFiles: 0,
        scannedMarkdownFiles: 0,
        incomplete: false,
        gaps: [],
      },
      mcp: { transport: 'stdio', wrapper: 'configured', strict: true },
    };
    expect(validateInventoryEvidence(mcp)).toBe(true);
    expect(validateInventoryEvidence({ ...mcp, scan: skill.scan })).toBe(false);
    expect(validateInventoryEvidence({ ...mcp, capabilities: skill.capabilities })).toBe(false);
    expect(validateInventoryEvidence({ ...mcp, mcp: { ...mcp.mcp, transport: 'http' } })).toBe(
      false,
    );
    expect(validateInventoryEvidence({ ...mcp, mcp: { ...mcp.mcp, protected: true } })).toBe(false);
    expect(
      validateInventoryEvidence({
        ...mcp,
        artifact: { ...mcp.artifact, digestFormat: 'stroq-tree/1' },
      }),
    ).toBe(false);
  });
});
