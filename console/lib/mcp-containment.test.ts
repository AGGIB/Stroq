import { describe, expect, it } from 'vitest';
import {
  MCP_CONTAINMENT_LIMITATIONS,
  validateMcpContainment,
  validateMcpContainmentPreview,
  validateMcpContainmentReceipt,
  type McpContainmentArtifact,
} from './mcp-containment';
const workspace = 'workspace-' + 'a'.repeat(24);
const id = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-10-23T09:30:00.000Z';
const artifact: McpContainmentArtifact = {
  id: 'item-' + 'b'.repeat(24),
  name: 'Notes server',
  kind: 'mcp',
  agent: 'cursor',
  scope: 'user',
  sha256: 'c'.repeat(64),
  digestFormat: 'mcp-entry-canonical-json/1',
  configSource: 'cursor-user',
};
const preview = () => ({
  schema: 'stroq-mcp-containment-preview/2',
  source: 'local',
  id,
  recordId: id,
  workspaceId: workspace,
  action: 'remove-registration',
  proxy: null,
  createdAt: stamp,
  expiresAt: '2026-10-23T09:32:00.000Z',
  artifact,
  configSha256: 'd'.repeat(64),
  candidateSha256: 'e'.repeat(64),
  bytes: 512,
  siblings: 2,
  reformatted: false,
  effect: 'remove-registration',
  evidence: 'configuration',
  hostEnforcement: false,
  requiresAcknowledgement: true,
  retention: { unencrypted: true, maxRecords: 32, maxBytes: 17825792, automaticDeletion: false },
  limitations: [...MCP_CONTAINMENT_LIMITATIONS],
});
const record = () => ({
  id,
  artifact,
  change: 'remove-registration',
  changedEntrySha256: null,
  proxy: null,
  originWorkspaceId: workspace,
  phase: 'removed',
  createdAt: stamp,
  restoredAt: null,
  checkedAt: stamp,
  status: 'removed',
  slot: 'absent',
  payload: 'match',
  sourceMatchesChange: true,
  configSha256: 'e'.repeat(64),
});
const state = () => ({
  schema: 'stroq-mcp-containment/2',
  source: 'local',
  generatedAt: stamp,
  workspaceId: workspace,
  available: true,
  reason: null,
  records: [record()],
  gaps: [],
  limitations: [...MCP_CONTAINMENT_LIMITATIONS],
});
const receipt = () => ({
  schema: 'stroq-mcp-containment-receipt/2',
  source: 'local',
  previewId: id,
  recordId: id,
  workspaceId: workspace,
  artifact,
  action: 'remove-registration',
  proxy: null,
  status: 'removed',
  effect: 'remove-registration',
  completedAt: stamp,
  configSha256: 'e'.repeat(64),
  evidence: 'configuration',
  hostEnforcement: false,
  reviewBaselineChanged: false,
  requiresClientRestart: true,
});
describe('MCP configuration evidence boundary', () => {
  it('accepts exact configuration-only state/preview/receipt', () => {
    expect(validateMcpContainment(state())).toBe(true);
    expect(validateMcpContainmentPreview(preview())).toBe(true);
    expect(validateMcpContainmentReceipt(receipt())).toBe(true);
  });
  it('rejects raw config, names with secrets and unsupported source claims', () => {
    expect(
      validateMcpContainmentPreview({ ...preview(), config: { env: { TOKEN: 'private' } } }),
    ).toBe(false);
    expect(
      validateMcpContainmentPreview({ ...preview(), artifact: { ...artifact, name: 'API_TOKEN' } }),
    ).toBe(false);
    expect(
      validateMcpContainmentPreview({
        ...preview(),
        artifact: { ...artifact, configSource: 'cursor-project' },
      }),
    ).toBe(false);
    expect(
      validateMcpContainmentPreview({ ...preview(), artifact: { ...artifact, agent: 'windsurf' } }),
    ).toBe(false);
  });
  it('never upgrades configuration absence to live blocking or revocation', () => {
    expect(validateMcpContainmentReceipt({ ...receipt(), hostEnforcement: true })).toBe(false);
    expect(validateMcpContainmentReceipt({ ...receipt(), effect: 'stop-process' })).toBe(false);
    expect(validateMcpContainmentReceipt({ ...receipt(), status: 'restored' })).toBe(false);
    expect(validateMcpContainmentReceipt({ ...receipt(), reviewBaselineChanged: true })).toBe(
      false,
    );
  });
  it('requires bounded expiry, retention disclosure and the full limitation set', () => {
    expect(
      validateMcpContainmentPreview({ ...preview(), expiresAt: '2026-10-23T09:33:00.000Z' }),
    ).toBe(false);
    expect(
      validateMcpContainmentPreview({
        ...preview(),
        retention: { ...preview().retention, unencrypted: false },
      }),
    ).toBe(false);
    expect(validateMcpContainmentPreview({ ...preview(), limitations: [] })).toBe(false);
    expect(validateMcpContainmentPreview({ ...preview(), bytes: 262145 })).toBe(false);
  });
  it('rejects contradictory recovery states and duplicate retained records', () => {
    expect(validateMcpContainment({ ...state(), records: [record(), record()] })).toBe(false);
    expect(
      validateMcpContainment({
        ...state(),
        records: [{ ...record(), status: 'removed', slot: 'same' }],
      }),
    ).toBe(false);
    expect(
      validateMcpContainment({
        ...state(),
        records: [{ ...record(), status: 'removed', payload: 'missing' }],
      }),
    ).toBe(false);
    expect(
      validateMcpContainment({ ...state(), available: true, reason: 'storage-unavailable' }),
    ).toBe(false);
  });
  it('accepts explicit unverifiable foreign-project evidence without exposing a path', () => {
    const project = { ...artifact, scope: 'project', configSource: 'cursor-project' };
    expect(
      validateMcpContainment({
        ...state(),
        records: [
          {
            ...record(),
            artifact: project,
            originWorkspaceId: 'workspace-' + 'f'.repeat(24),
            status: 'unverifiable',
            slot: 'unverifiable',
            sourceMatchesChange: null,
            configSha256: null,
          },
        ],
      }),
    ).toBe(true);
  });
  it('accepts an exact strict proxy plan, configured record and guarded undo', () => {
    const proxy = { mode: 'strict', policyWorkspaceId: workspace };
    expect(
      validateMcpContainmentPreview({
        ...preview(),
        action: 'protect-registration',
        effect: 'protect-registration',
        proxy,
      }),
    ).toBe(true);
    expect(
      validateMcpContainmentReceipt({
        ...receipt(),
        action: 'protect-registration',
        effect: 'protect-registration',
        status: 'configured',
        proxy,
      }),
    ).toBe(true);
    expect(
      validateMcpContainment({
        ...state(),
        records: [
          {
            ...record(),
            change: 'protect-registration',
            changedEntrySha256: 'f'.repeat(64),
            phase: 'configured',
            status: 'configured',
            slot: 'guarded',
            proxy: { ...proxy, runtimeMatches: true },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateMcpContainmentPreview({
        ...preview(),
        action: 'restore-registration',
        effect: 'restore-registration',
        proxy,
      }),
    ).toBe(true);
  });
  it('refuses missing policy context, downgraded modes and fabricated enforcement', () => {
    const protect = {
      ...preview(),
      action: 'protect-registration',
      effect: 'protect-registration',
      proxy: { mode: 'strict', policyWorkspaceId: workspace },
    };
    expect(validateMcpContainmentPreview({ ...protect, proxy: null })).toBe(false);
    expect(
      validateMcpContainmentPreview({
        ...protect,
        proxy: { mode: 'monitor', policyWorkspaceId: workspace },
      }),
    ).toBe(false);
    expect(
      validateMcpContainmentPreview({
        ...protect,
        proxy: { ...protect.proxy, policyWorkspaceId: 'workspace-' + 'f'.repeat(24) },
      }),
    ).toBe(false);
    expect(validateMcpContainmentPreview({ ...protect, hostEnforcement: true })).toBe(false);
    expect(validateMcpContainmentPreview({ ...preview(), proxy: protect.proxy })).toBe(false);
    expect(
      validateMcpContainmentReceipt({
        ...receipt(),
        action: 'protect-registration',
        effect: 'protect-registration',
        status: 'removed',
        proxy: protect.proxy,
      }),
    ).toBe(false);
  });
  it('keeps original and guarded revisions distinct and never transfers proxy claims to removal records', () => {
    const guarded = {
      ...record(),
      change: 'protect-registration',
      changedEntrySha256: 'f'.repeat(64),
      phase: 'configured',
      status: 'configured',
      slot: 'guarded',
      proxy: { mode: 'strict', policyWorkspaceId: workspace, runtimeMatches: false },
    };
    expect(validateMcpContainment({ ...state(), records: [guarded] })).toBe(true);
    expect(
      validateMcpContainment({
        ...state(),
        records: [{ ...guarded, changedEntrySha256: artifact.sha256 }],
      }),
    ).toBe(false);
    expect(
      validateMcpContainment({ ...state(), records: [{ ...guarded, changedEntrySha256: null }] }),
    ).toBe(false);
    expect(validateMcpContainment({ ...state(), records: [{ ...guarded, slot: 'absent' }] })).toBe(
      false,
    );
    expect(
      validateMcpContainment({
        ...state(),
        records: [{ ...guarded, proxy: { ...guarded.proxy, runtimeMatches: 'verified' } }],
      }),
    ).toBe(false);
    expect(
      validateMcpContainment({ ...state(), records: [{ ...record(), proxy: guarded.proxy }] }),
    ).toBe(false);
  });
});
