import { describe, expect, it } from 'vitest';
import {
  mcpContainmentPreviewMatches,
  mcpContainmentReceiptMatches,
  mcpContainmentCanRestore,
  mcpContainmentApplyInput,
} from './mcp-containment-binding';
import type {
  McpContainmentPreview,
  McpContainmentReceipt,
  McpContainmentRecord,
} from './mcp-containment';

const workspaceId = 'workspace-' + 'a'.repeat(24);
const artifact = {
  id: 'item-' + 'b'.repeat(24),
  name: 'Notes server',
  kind: 'mcp',
  agent: 'cursor',
  scope: 'user',
  sha256: 'c'.repeat(64),
  digestFormat: 'mcp-entry-canonical-json/1',
  configSource: 'cursor-user',
} as const;
const preview = {
  id: '11111111-1111-4111-8111-111111111111',
  recordId: '22222222-2222-4222-8222-222222222222',
  workspaceId,
  action: 'remove-registration',
  artifact,
  configSha256: 'd'.repeat(64),
  candidateSha256: 'e'.repeat(64),
  proxy: null,
  createdAt: '2026-10-23T09:30:00.000Z',
} as McpContainmentPreview;
const receipt = {
  previewId: preview.id,
  recordId: preview.recordId,
  workspaceId,
  artifact,
  action: preview.action,
  status: 'removed',
  proxy: null,
  configSha256: preview.candidateSha256,
  completedAt: '2026-10-23T09:30:01.000Z',
} as McpContainmentReceipt;

describe('exact MCP containment action bindings', () => {
  it('offers restore only for a verified empty slot and intact retained bytes in its allowed scope', () => {
    const record: McpContainmentRecord = {
      id: preview.recordId,
      artifact,
      originWorkspaceId: 'workspace-' + 'f'.repeat(24),
      change: 'remove-registration',
      changedEntrySha256: null,
      proxy: null,
      phase: 'removed',
      createdAt: preview.createdAt,
      restoredAt: null,
      checkedAt: receipt.completedAt,
      status: 'removed',
      slot: 'absent',
      payload: 'match',
      sourceMatchesChange: true,
      configSha256: preview.candidateSha256,
    };
    expect(mcpContainmentCanRestore(record, workspaceId)).toBe(true);
    expect(
      mcpContainmentCanRestore(
        { ...record, artifact: { ...artifact, scope: 'project', configSource: 'cursor-project' } },
        workspaceId,
      ),
    ).toBe(false);
    for (const changed of [
      { slot: 'same' as const },
      { slot: 'different' as const },
      { payload: 'changed' as const },
      { payload: 'missing' as const },
      { configSha256: null },
      { status: 'unverifiable' as const },
      { status: 'config-missing' as const },
    ])
      expect(mcpContainmentCanRestore({ ...record, ...changed }, workspaceId)).toBe(false);
    expect(mcpContainmentCanRestore(record, null)).toBe(false);
  });
  it('removes a proxy only while its exact changed entry is present, including user records from another workspace', () => {
    const record = {
      id: preview.recordId,
      artifact,
      originWorkspaceId: 'workspace-' + 'f'.repeat(24),
      change: 'protect-registration',
      changedEntrySha256: 'f'.repeat(64),
      proxy: {
        mode: 'strict',
        policyWorkspaceId: 'workspace-' + 'f'.repeat(24),
        runtimeMatches: true,
      },
      phase: 'configured',
      createdAt: preview.createdAt,
      restoredAt: null,
      checkedAt: receipt.completedAt,
      status: 'configured',
      slot: 'guarded',
      payload: 'match',
      sourceMatchesChange: true,
      configSha256: preview.candidateSha256,
    } as McpContainmentRecord;
    expect(mcpContainmentCanRestore(record, workspaceId)).toBe(true);
    expect(
      mcpContainmentCanRestore(
        { ...record, proxy: { ...record.proxy!, runtimeMatches: false } },
        workspaceId,
      ),
    ).toBe(true);
    for (const changed of [
      { slot: 'absent' as const },
      { slot: 'same' as const },
      { slot: 'different' as const },
      { changedEntrySha256: null },
      { proxy: null },
      { payload: 'changed' as const },
      { configSha256: null },
    ])
      expect(mcpContainmentCanRestore({ ...record, ...changed }, workspaceId)).toBe(false);
  });
  it('binds protection and proxy undo previews to the exact acknowledged policy context', () => {
    const proxy = { mode: 'strict' as const, policyWorkspaceId: workspaceId };
    const protect = { ...preview, action: 'protect-registration' as const, proxy };
    expect(
      mcpContainmentPreviewMatches(protect, 'protect-registration', artifact, workspaceId),
    ).toBe(true);
    expect(
      mcpContainmentPreviewMatches(
        { ...protect, proxy: null },
        'protect-registration',
        artifact,
        workspaceId,
      ),
    ).toBe(false);
    expect(
      mcpContainmentPreviewMatches(
        { ...protect, proxy: { ...proxy, policyWorkspaceId: 'workspace-' + 'f'.repeat(24) } },
        'protect-registration',
        artifact,
        workspaceId,
      ),
    ).toBe(false);
    expect(
      mcpContainmentPreviewMatches(
        { ...preview, proxy },
        'remove-registration',
        artifact,
        workspaceId,
      ),
    ).toBe(false);
    const undo = { ...protect, action: 'restore-registration' as const };
    expect(
      mcpContainmentPreviewMatches(
        undo,
        'restore-registration',
        artifact,
        workspaceId,
        preview.recordId,
        proxy,
      ),
    ).toBe(true);
    expect(
      mcpContainmentPreviewMatches(
        undo,
        'restore-registration',
        artifact,
        workspaceId,
        preview.recordId,
      ),
    ).toBe(false);
    expect(
      mcpContainmentReceiptMatches(
        { ...receipt, action: 'protect-registration', status: 'configured', proxy },
        protect,
      ),
    ).toBe(true);
    expect(
      mcpContainmentReceiptMatches(
        {
          ...receipt,
          action: 'protect-registration',
          status: 'configured',
          proxy: { ...proxy, policyWorkspaceId: 'workspace-' + 'f'.repeat(24) },
        },
        protect,
      ),
    ).toBe(false);
  });
  it('requires separate proxy and shared-policy consent and sends only the relevant acknowledgements', () => {
    const consent = { session: true, retention: true, proxy: true, sharedPolicy: true };
    const proxy = { mode: 'strict' as const, policyWorkspaceId: workspaceId };
    const protect = { ...preview, action: 'protect-registration' as const, proxy };
    const base = {
      previewId: preview.id,
      confirm: true,
      acknowledgeSessionLimits: true,
      acknowledgePrivateRetention: true,
    };
    expect(mcpContainmentApplyInput(preview, consent)).toEqual(base);
    expect(mcpContainmentApplyInput(protect, consent)).toEqual({
      ...base,
      acknowledgeProxyEffects: true,
      acknowledgeSharedPolicyContext: true,
    });
    for (const key of ['session', 'retention', 'proxy', 'sharedPolicy'] as const)
      expect(mcpContainmentApplyInput(protect, { ...consent, [key]: false })).toBeNull();
    expect(
      mcpContainmentApplyInput(
        { ...protect, artifact: { ...artifact, scope: 'project', configSource: 'cursor-project' } },
        { ...consent, sharedPolicy: false },
      ),
    ).toEqual({ ...base, acknowledgeProxyEffects: true });
    expect(
      mcpContainmentApplyInput(
        { ...protect, action: 'restore-registration' },
        { ...consent, sharedPolicy: false },
      ),
    ).toEqual({ ...base, acknowledgeProxyEffects: true });
  });
  it('accepts only the selected entry and workspace in a preview', () => {
    expect(
      mcpContainmentPreviewMatches(preview, 'remove-registration', artifact, workspaceId),
    ).toBe(true);
    expect(
      mcpContainmentPreviewMatches(
        { ...preview, workspaceId: 'workspace-' + 'f'.repeat(24) },
        'remove-registration',
        artifact,
        workspaceId,
      ),
    ).toBe(false);
    for (const changed of [
      { id: 'item-' + 'a'.repeat(24) },
      { sha256: 'f'.repeat(64) },
      { agent: 'claude-code' as const },
      { scope: 'project' as const },
    ])
      expect(
        mcpContainmentPreviewMatches(
          { ...preview, artifact: { ...artifact, ...changed } },
          'remove-registration',
          artifact,
          workspaceId,
        ),
      ).toBe(false);
  });
  it('binds restore previews to their exact retained record', () => {
    const restore = { ...preview, action: 'restore-registration' as const };
    expect(
      mcpContainmentPreviewMatches(
        restore,
        'restore-registration',
        artifact,
        workspaceId,
        preview.recordId,
      ),
    ).toBe(true);
    expect(
      mcpContainmentPreviewMatches(
        restore,
        'restore-registration',
        artifact,
        workspaceId,
        preview.id,
      ),
    ).toBe(false);
    expect(
      mcpContainmentPreviewMatches(restore, 'remove-registration', artifact, workspaceId),
    ).toBe(false);
  });
  it('accepts completion only for the confirmed preview and generated configuration', () => {
    expect(mcpContainmentReceiptMatches(receipt, preview)).toBe(true);
    for (const changed of [
      { previewId: preview.recordId },
      { recordId: preview.id },
      { configSha256: preview.configSha256 },
      { proxy: { mode: 'strict' as const, policyWorkspaceId: workspaceId } },
      { status: 'configured' as const },
      { workspaceId: 'workspace-' + 'f'.repeat(24) },
      { artifact: { ...artifact, sha256: 'f'.repeat(64) } },
      { completedAt: '2026-10-23T09:29:59.000Z' },
    ])
      expect(mcpContainmentReceiptMatches({ ...receipt, ...changed }, preview)).toBe(false);
  });
});
