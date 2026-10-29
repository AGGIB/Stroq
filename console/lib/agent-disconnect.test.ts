import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_BACKUP_ROOT,
  DISCONNECT_LIMITATIONS,
  disconnectTarget,
  validateAgentDisconnectState,
  validateAgentDisconnectPreview,
  validateAgentDisconnectReceipt,
  type AgentDisconnectPreview,
} from './agent-disconnect';
const id = '11111111-1111-4111-8111-111111111111';
const preview: AgentDisconnectPreview = {
  schema: 'stroq-agent-disconnect-preview/1',
  previewId: id,
  createdAt: '2026-10-23T00:00:00.000Z',
  expiresAt: '2026-10-23T00:05:00.000Z',
  workspaceId: 'workspace-' + 'a'.repeat(24),
  agent: 'claude-code',
  scope: 'project',
  scopeImpact: 'workspace',
  target: 'Workspace/.claude/settings.json',
  operation: 'remove-hooks',
  sourceSha256: 'b'.repeat(64),
  candidateSha256: 'c'.repeat(64),
  removedHooks: 3,
  preservedHooks: 2,
  remainingLookalikes: 1,
  events: [
    { event: 'PreToolUse', removed: 1 },
    { event: 'PostToolUse', removed: 1 },
    { event: 'PostToolUseFailure', removed: 1 },
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
describe('hook removal browser boundary', () => {
  it('requires a complete local state without contradictory availability or a host claim', () => {
    const state = {
      schema: 'stroq-agent-disconnect/1',
      workspaceId: preview.workspaceId,
      available: true,
      reason: null,
      hostEnforcement: false,
    };
    expect(validateAgentDisconnectState(state)).toBe(true);
    for (const value of [
      { ...state, available: false },
      { ...state, reason: 'private exception' },
      { ...state, hostEnforcement: true },
      { ...state, path: '/private/settings' },
    ])
      expect(validateAgentDisconnectState(value)).toBe(false);
  });
  it('binds preview changes, scopes, backup consent and canonical event totals', () => {
    expect(validateAgentDisconnectPreview(preview)).toBe(true);
    for (const value of [
      { ...preview, removedHooks: 2 },
      { ...preview, events: [{ event: 'PRIVATE_COMMAND', removed: 3 }] },
      {
        ...preview,
        events: [
          { event: 'PreToolUse', removed: 1 },
          { event: 'PreToolUse', removed: 2 },
        ],
      },
      { ...preview, scope: 'user' },
      { ...preview, needs: { ...preview.needs, acknowledgeRetainedCopy: false } },
      { ...preview, candidateSha256: preview.sourceSha256 },
      { ...preview, expiresAt: '2026-10-23T00:05:01.000Z' },
      { ...preview, limitations: [] },
      { ...preview, command: 'private command' },
    ])
      expect(validateAgentDisconnectPreview(value)).toBe(false);
    const shared = {
      ...preview,
      scopeImpact: 'all-workspaces',
      target: '~/.claude/settings.json',
      needs: { ...preview.needs, acknowledgeSharedScope: true },
    };
    expect(validateAgentDisconnectPreview(shared)).toBe(true);
    expect(validateAgentDisconnectPreview({ ...shared, needs: preview.needs })).toBe(false);
    const cursor = {
      ...preview,
      agent: 'cursor',
      scope: 'user',
      scopeImpact: 'all-workspaces',
      target: disconnectTarget('cursor', 'user', 'all-workspaces'),
      events: [{ event: 'beforeShellExecution', removed: 3 }],
      needs: { ...preview.needs, acknowledgeSharedScope: true },
    };
    expect(validateAgentDisconnectPreview(cursor)).toBe(true);
    // Windsurf is no longer an agent the console connects or disconnects.
    expect(
      validateAgentDisconnectPreview({
        ...cursor,
        agent: 'windsurf',
        target: '~/.codeium/windsurf/hooks.json',
        events: [{ event: 'pre_run_command', removed: 3 }],
      }),
    ).toBe(false);
  });
  it('distinguishes an absent no-op from a mutation with missing source evidence', () => {
    const empty = {
      ...preview,
      operation: 'unchanged',
      sourceSha256: null,
      candidateSha256: null,
      removedHooks: 0,
      preservedHooks: 0,
      remainingLookalikes: 0,
      events: [],
      needs: {
        acknowledgeWeakenProtection: false,
        acknowledgeRetainedCopy: false,
        acknowledgeSharedScope: false,
      },
      backup: { required: false, label: DISCONNECT_BACKUP_ROOT },
    };
    expect(validateAgentDisconnectPreview(empty)).toBe(true);
    expect(validateAgentDisconnectPreview({ ...empty, operation: 'remove-hooks' })).toBe(false);
    expect(validateAgentDisconnectPreview({ ...empty, sourceSha256: preview.sourceSha256 })).toBe(
      false,
    );
  });
  it('requires exact recovery identity and selected-file readback without native enforcement', () => {
    const receipt = {
      schema: 'stroq-agent-disconnect-receipt/1',
      status: 'removed',
      receiptId: id,
      previewId: id,
      completedAt: preview.createdAt,
      workspaceId: preview.workspaceId,
      agent: preview.agent,
      scope: preview.scope,
      scopeImpact: preview.scopeImpact,
      target: preview.target,
      sourceSha256: preview.sourceSha256,
      candidateSha256: preview.candidateSha256,
      removedHooks: 3,
      preservedHooks: 2,
      remainingLookalikes: 1,
      backupId: id,
      currentExactHooks: 0,
      evidence: 'configuration',
      hostEnforcement: false,
      requiresNewSession: true,
    };
    expect(validateAgentDisconnectReceipt(receipt)).toBe(true);
    for (const value of [
      { ...receipt, backupId: '22222222-2222-4222-8222-222222222222' },
      { ...receipt, currentExactHooks: 1 },
      { ...receipt, hostEnforcement: true },
      { ...receipt, scope: 'user' },
      { ...receipt, removedHooks: 0 },
      { ...receipt, sourceSha256: receipt.candidateSha256 },
      { ...receipt, before: 'PRIVATE_SETTINGS' },
    ])
      expect(validateAgentDisconnectReceipt(value)).toBe(false);
  });
});
