import { describe, expect, it } from 'vitest';
import {
  credentialFilterTarget,
  credentialFilterContextKey,
  credentialFilterPreviewMatches,
  credentialFilterReceiptMatches,
  credentialFilterApplyInput,
  CREDENTIAL_FILTER_PATTERNS,
} from './credential-filter-binding';
import {
  CLAUDE_READ_DENY_RULES,
  PROJECT_SECRET_FILES,
} from '../../packages/cli/src/harden/recipes/credential-paths';
import {
  CREDENTIAL_FILTER_LIMITATIONS,
  CREDENTIAL_FILTER_RETENTION,
  validateCredentialFilterPreview,
  validateCredentialFilterReceipt,
  type CredentialFilterPreview,
  type CredentialFilterReceipt,
} from './credential-filters';

const workspace = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const preview: CredentialFilterPreview = {
  schema: 'stroq-credential-filter-preview/1',
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: workspace,
  target: 'claude-project',
  action: 'apply-filter',
  expiresAt: '2026-10-23T12:02:00.000Z',
  location: 'workspace',
  context: 'workspace',
  operation: 'create',
  sourceSha256: null,
  candidateSha256: 'c'.repeat(64),
  bytes: 0,
  required: 13,
  present: 0,
  added: 13,
  removed: 0,
  kept: 0,
  applications: 0,
  backup: 'none-new-file',
  reformatted: false,
  needs: {
    acknowledgeReformat: false,
    acknowledgeLink: false,
    acknowledgeCredentialLoss: false,
    acknowledgeSharedScope: false,
  },
  evidence: 'configuration',
  hostEnforcement: false,
  limitations: [...CREDENTIAL_FILTER_LIMITATIONS],
  retention: CREDENTIAL_FILTER_RETENTION,
};
const receipt: CredentialFilterReceipt = {
  schema: 'stroq-credential-filter-receipt/1',
  previewId: preview.id,
  candidateSha256: preview.candidateSha256,
  workspaceId: workspace,
  target: 'claude-project',
  action: 'apply-filter',
  status: 'configured',
  completedAt: '2026-10-23T12:01:00.000Z',
  applications: 1,
  backup: 'none-new-file',
  evidence: 'configuration',
  hostEnforcement: false,
  requiresClientRestart: true,
};
const undoPreview: CredentialFilterPreview = {
  ...preview,
  action: 'undo-filter',
  operation: 'remove-created-file',
  sourceSha256: preview.candidateSha256,
  candidateSha256: null,
  bytes: 256,
  present: 13,
  added: 0,
  removed: 13,
  applications: 2,
};
const undoReceipt: CredentialFilterReceipt = {
  ...receipt,
  action: 'undo-filter',
  status: 'undone',
  candidateSha256: null,
  applications: undoPreview.applications,
};
const unchangedPreview: CredentialFilterPreview = {
  ...preview,
  operation: 'unchanged',
  sourceSha256: preview.candidateSha256,
  bytes: 256,
  present: 13,
  added: 0,
  applications: 3,
  backup: 'none',
};
const unchangedReceipt: CredentialFilterReceipt = {
  ...receipt,
  status: 'unchanged',
  applications: 0,
  backup: 'none',
};
const updatePreview: CredentialFilterPreview = {
  ...preview,
  operation: 'update',
  sourceSha256: 'd'.repeat(64),
  bytes: 256,
  present: 12,
  added: 1,
  applications: 7,
  backup: 'copy',
};
const updateReceipt: CredentialFilterReceipt = { ...receipt, backup: 'copy' };

describe('credential filter selection and consent bindings', () => {
  it('uses valid public fixtures for changed, unchanged and undo operations', () => {
    for (const value of [preview, updatePreview, unchangedPreview, undoPreview])
      expect(validateCredentialFilterPreview(value)).toBe(true);
    for (const value of [receipt, updateReceipt, unchangedReceipt, undoReceipt])
      expect(validateCredentialFilterReceipt(value)).toBe(true);
  });
  it('shows only the exact fixed additions used by the engine recipes', () => {
    expect(CREDENTIAL_FILTER_PATTERNS['claude-project']).toEqual(CLAUDE_READ_DENY_RULES);
    expect(CREDENTIAL_FILTER_PATTERNS['claude-user']).toEqual(CLAUDE_READ_DENY_RULES);
    expect(CREDENTIAL_FILTER_PATTERNS['cursor-project']).toEqual(PROJECT_SECRET_FILES);
  });
  it('selects only the exact supported agent and scope without Cursor user fallback', () => {
    expect(credentialFilterTarget('claude-code', 'project')).toBe('claude-project');
    expect(credentialFilterTarget('claude-code', 'user')).toBe('claude-user');
    expect(credentialFilterTarget('cursor', 'project')).toBe('cursor-project');
    expect(credentialFilterTarget('cursor', 'user')).toBeNull();
    for (const agent of ['codex', 'windsurf', 'Claude Code', '__proto__', 'unknown'])
      expect(credentialFilterTarget(agent, 'project')).toBeNull();
  });
  it('invalidates an earlier selection when workspace, scope, or read generation changes', () => {
    const key = credentialFilterContextKey(workspace, 'claude-project', 1);
    expect(key).not.toBeNull();
    expect(credentialFilterContextKey(other, 'claude-project', 1)).not.toBe(key);
    expect(credentialFilterContextKey(workspace, 'claude-user', 1)).not.toBe(key);
    expect(credentialFilterContextKey(workspace, 'claude-project', 2)).not.toBe(key);
    expect(credentialFilterContextKey(null, 'claude-project', 1)).toBeNull();
    expect(credentialFilterContextKey(workspace, null, 1)).toBeNull();
  });
  it('rejects preview responses for another action, target, workspace or source context', () => {
    const selection = {
      workspaceId: workspace,
      target: 'claude-project' as const,
      action: 'apply-filter' as const,
      location: 'workspace' as const,
      context: 'workspace' as const,
    };
    expect(credentialFilterPreviewMatches(preview, selection)).toBe(true);
    for (const change of [
      { workspaceId: other },
      { target: 'claude-user' as const },
      { action: 'undo-filter' as const },
      { location: 'main-checkout' as const, context: 'repository' as const },
    ])
      expect(credentialFilterPreviewMatches({ ...preview, ...change }, selection)).toBe(false);
  });
  it('accepts only the exact approved preview and final candidate, including a deleted file', () => {
    expect(credentialFilterReceiptMatches(receipt, preview)).toBe(true);
    for (const change of [
      { previewId: '22222222-2222-4222-8222-222222222222' },
      { workspaceId: other },
      { target: 'cursor-project' as const },
      { action: 'undo-filter' as const },
      { candidateSha256: 'd'.repeat(64) },
      { candidateSha256: null },
      { status: 'undone' as const },
    ])
      expect(credentialFilterReceiptMatches({ ...receipt, ...change }, preview)).toBe(false);
    expect(credentialFilterReceiptMatches(undoReceipt, undoPreview)).toBe(true);
    expect(
      credentialFilterReceiptMatches(
        { ...unchangedReceipt, status: 'configured' },
        unchangedPreview,
      ),
    ).toBe(false);
    expect(credentialFilterReceiptMatches(unchangedReceipt, unchangedPreview)).toBe(true);
  });
  it('rejects recovery metadata that differs from the approved backup strategy', () => {
    for (const [p, r] of [
      [preview, receipt],
      [updatePreview, updateReceipt],
      [unchangedPreview, unchangedReceipt],
      [undoPreview, undoReceipt],
    ] as const) {
      const wrong = {
        ...r,
        backup: p.backup === 'copy' ? ('surgical' as const) : ('copy' as const),
      };
      expect(validateCredentialFilterReceipt(wrong)).toBe(true);
      expect(credentialFilterReceiptMatches(wrong, p)).toBe(false);
    }
  });
  it('requires one changed apply, zero unchanged applies and exactly the previewed undo applications', () => {
    for (const [p, r, invalid] of [
      [preview, receipt, [0, 2]],
      [updatePreview, updateReceipt, [0, 2, 7]],
      [unchangedPreview, unchangedReceipt, [1, 3]],
      [undoPreview, undoReceipt, [0, 1, 3]],
    ] as const) {
      expect(credentialFilterReceiptMatches(r, p)).toBe(true);
      for (const applications of invalid)
        expect(credentialFilterReceiptMatches({ ...r, applications }, p)).toBe(false);
    }
  });
  it('requires each named consent and never sends unneeded acknowledgements', () => {
    const consent = {
      acknowledgeNativeLimits: true,
      acknowledgePrivateRetention: true,
      acknowledgeWeakenFilter: true,
      acknowledgeReformat: true,
      acknowledgeLink: true,
      acknowledgeCredentialLoss: true,
      acknowledgeSharedScope: true,
    };
    const base = {
      previewId: preview.id,
      confirm: true,
      acknowledgeNativeLimits: true,
      acknowledgePrivateRetention: true,
    };
    expect(credentialFilterApplyInput(preview, consent)).toEqual(base);
    const needs = {
      acknowledgeReformat: true,
      acknowledgeLink: true,
      acknowledgeCredentialLoss: true,
      acknowledgeSharedScope: true,
    };
    const guarded: CredentialFilterPreview = {
      ...preview,
      target: 'claude-user',
      location: 'user',
      context: 'all-workspaces',
      operation: 'update',
      sourceSha256: 'd'.repeat(64),
      bytes: 256,
      backup: 'none-credential-text',
      reformatted: true,
      needs,
    };
    expect(validateCredentialFilterPreview(guarded)).toBe(true);
    expect(credentialFilterApplyInput(guarded, consent)).toEqual({ ...base, ...needs });
    for (const flag of [
      'acknowledgeNativeLimits',
      'acknowledgePrivateRetention',
      ...Object.keys(needs),
    ] as (keyof typeof consent)[])
      expect(credentialFilterApplyInput(guarded, { ...consent, [flag]: false })).toBeNull();
    expect(
      credentialFilterApplyInput(undoPreview, { ...consent, acknowledgeWeakenFilter: false }),
    ).toBeNull();
    expect(credentialFilterApplyInput(undoPreview, consent)).toEqual({
      ...base,
      acknowledgeWeakenFilter: true,
    });
  });
});
