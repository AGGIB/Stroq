import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_BACKUP_ROOT,
  DISCONNECT_LIMITATIONS,
  validateAgentDisconnectPreview,
  validateAgentDisconnectReceipt,
  type AgentDisconnectPreview,
  type AgentDisconnectReceipt,
} from './agent-disconnect';
import {
  agentDisconnectKey,
  disconnectApplyInput,
  disconnectPreviewMatches,
  disconnectReceiptMatches,
  emptyDisconnectAcknowledgements,
} from './agent-disconnect-binding';

const workspaceId = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const now = Date.parse('2026-10-23T12:00:00.000Z');
const preview: AgentDisconnectPreview = {
  schema: 'stroq-agent-disconnect-preview/1',
  previewId: '11111111-1111-4111-8111-111111111111',
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120_000).toISOString(),
  workspaceId,
  agent: 'cursor',
  scope: 'project',
  scopeImpact: 'workspace',
  target: 'Workspace/.cursor/hooks.json',
  operation: 'remove-hooks',
  sourceSha256: 'c'.repeat(64),
  candidateSha256: 'd'.repeat(64),
  removedHooks: 2,
  preservedHooks: 3,
  remainingLookalikes: 1,
  events: [
    { event: 'beforeShellExecution', removed: 1 },
    { event: 'beforeMCPExecution', removed: 1 },
  ],
  needs: {
    acknowledgeWeakenProtection: true,
    acknowledgeRetainedCopy: true,
    acknowledgeSharedScope: false,
  },
  backup: { required: true, label: DISCONNECT_BACKUP_ROOT },
  evidence: 'configuration',
  hostEnforcement: false,
  requiresNewSession: true,
  limitations: [...DISCONNECT_LIMITATIONS],
};
const receipt: AgentDisconnectReceipt = {
  schema: 'stroq-agent-disconnect-receipt/1',
  status: 'removed',
  receiptId: '22222222-2222-4222-8222-222222222222',
  previewId: preview.previewId,
  completedAt: new Date(now + 1000).toISOString(),
  workspaceId,
  agent: preview.agent,
  scope: preview.scope,
  scopeImpact: preview.scopeImpact,
  target: preview.target,
  sourceSha256: preview.sourceSha256!,
  candidateSha256: preview.candidateSha256!,
  removedHooks: 2,
  preservedHooks: 3,
  remainingLookalikes: 1,
  backupId: '22222222-2222-4222-8222-222222222222',
  currentExactHooks: 0,
  evidence: 'configuration',
  hostEnforcement: false,
  requiresNewSession: true,
};
const acknowledged = {
  acknowledgeWeakenProtection: true,
  acknowledgeRetainedCopy: true,
  acknowledgeSharedScope: false,
};
describe('exact hook-removal consent binding', () => {
  it('keys current workspace, fixed agent, selected scope and read generation', () => {
    expect(agentDisconnectKey(workspaceId, 'cursor', 'project', 1)).toBe(
      `${workspaceId}:cursor:project:1`,
    );
    expect(agentDisconnectKey(workspaceId, 'cursor', 'project', 2)).not.toBe(
      agentDisconnectKey(workspaceId, 'cursor', 'project', 1),
    );
    expect(agentDisconnectKey(null, 'cursor', 'project', 1)).toBeNull();
    expect(agentDisconnectKey('/Users/private', 'cursor', 'project', 1)).toBeNull();
    expect(agentDisconnectKey(workspaceId, 'cursor', 'project', -1)).toBeNull();
  });
  it('binds the preview to the exact selected source without changing a home alias to project impact', () => {
    expect(validateAgentDisconnectPreview(preview)).toBe(true);
    expect(
      disconnectPreviewMatches(preview, { workspaceId, agent: 'cursor', scope: 'project' }),
    ).toBe(true);
    expect(
      disconnectPreviewMatches(preview, { workspaceId: other, agent: 'cursor', scope: 'project' }),
    ).toBe(false);
    expect(
      disconnectPreviewMatches(preview, { workspaceId, agent: 'codex', scope: 'project' }),
    ).toBe(false);
    expect(disconnectPreviewMatches(preview, { workspaceId, agent: 'cursor', scope: 'user' })).toBe(
      false,
    );
    const alias = {
      ...preview,
      scopeImpact: 'all-workspaces' as const,
      target: '~/.cursor/hooks.json',
      needs: { ...preview.needs, acknowledgeSharedScope: true },
    };
    expect(validateAgentDisconnectPreview(alias)).toBe(true);
    expect(
      disconnectPreviewMatches(alias, { workspaceId, agent: 'cursor', scope: 'project' }),
    ).toBe(true);
  });
  it('accepts only the exact preview receipt with matching hashes, counts and recovery metadata', () => {
    expect(validateAgentDisconnectReceipt(receipt)).toBe(true);
    expect(disconnectReceiptMatches(receipt, preview)).toBe(true);
    for (const change of [
      { workspaceId: other },
      { previewId: receipt.receiptId },
      { completedAt: new Date(now - 1).toISOString() },
      { agent: 'codex' as const },
      { scope: 'user' as const },
      { scopeImpact: 'all-workspaces' as const },
      { target: '~/.cursor/hooks.json' },
      { sourceSha256: 'e'.repeat(64) },
      { candidateSha256: 'e'.repeat(64) },
      { removedHooks: 1 },
      { preservedHooks: 2 },
      { remainingLookalikes: 0 },
      { backupId: '33333333-3333-4333-8333-333333333333' },
    ])
      expect(
        disconnectReceiptMatches({ ...receipt, ...change }, preview),
        JSON.stringify(change),
      ).toBe(false);
  });
  it('requires weakening and full-copy retention acknowledgement before building the closed apply input', () => {
    expect(disconnectApplyInput(preview, emptyDisconnectAcknowledgements(), now)).toBeNull();
    expect(
      disconnectApplyInput(preview, { ...acknowledged, acknowledgeRetainedCopy: false }, now),
    ).toBeNull();
    expect(
      disconnectApplyInput(preview, { ...acknowledged, acknowledgeWeakenProtection: false }, now),
    ).toBeNull();
    expect(disconnectApplyInput(preview, acknowledged, now)).toEqual({
      previewId: preview.previewId,
      acknowledgeWeakenProtection: true,
      acknowledgeRetainedCopy: true,
    });
  });
  it('requires a separate shared-scope acknowledgement for user sources and home aliases', () => {
    for (const scope of ['project', 'user'] as const) {
      const shared = {
        ...preview,
        scope,
        scopeImpact: 'all-workspaces' as const,
        target: '~/.cursor/hooks.json',
        needs: { ...preview.needs, acknowledgeSharedScope: true },
      };
      expect(validateAgentDisconnectPreview(shared)).toBe(true);
      expect(disconnectApplyInput(shared, acknowledged, now)).toBeNull();
      expect(
        disconnectApplyInput(shared, { ...acknowledged, acknowledgeSharedScope: true }, now),
      ).toEqual({
        previewId: preview.previewId,
        acknowledgeWeakenProtection: true,
        acknowledgeRetainedCopy: true,
        acknowledgeSharedScope: true,
      });
    }
  });
  it('refuses expired previews and read-only unchanged results', () => {
    expect(disconnectApplyInput(preview, acknowledged, Date.parse(preview.expiresAt))).toBeNull();
    expect(
      disconnectApplyInput(
        { ...preview, operation: 'unchanged', removedHooks: 0 },
        acknowledged,
        now,
      ),
    ).toBeNull();
  });
});
