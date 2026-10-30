import { describe, expect, it } from 'vitest';
import {
  validateSetupPreview,
  validateSetupResult,
  type SetupPreview,
  type SetupResult,
} from './agent-setup';
import {
  agentSetupKey,
  emptySetupAcknowledgements,
  setupApplyInput,
  setupPreviewMatches,
  setupReceiptMatches,
} from './agent-setup-binding';

const workspaceId = 'workspace-' + 'a'.repeat(24);
const otherWorkspace = 'workspace-' + 'b'.repeat(24);
const now = Date.parse('2026-10-23T12:00:00.000Z');
const preview: SetupPreview = {
  schema: 'stroq-agent-setup-preview/2',
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 300_000).toISOString(),
  workspaceId,
  agent: 'claude-code',
  scope: 'project',
  scopeImpact: 'workspace',
  context: 'Fixture project',
  target: 'Workspace/.claude/settings.json',
  sourceSha256: 'c'.repeat(64),
  candidateSha256: 'd'.repeat(64),
  operation: 'update',
  hookEvents: [
    { event: 'PreToolUse', matcher: '*', blocking: true, failClosed: null, timeoutSeconds: null },
    { event: 'PostToolUse', matcher: '*', blocking: false, failClosed: null, timeoutSeconds: null },
    {
      event: 'PostToolUseFailure',
      matcher: '*',
      blocking: false,
      failClosed: null,
      timeoutSeconds: null,
    },
  ],
  addedHooks: 3,
  replacedHooks: 0,
  preservedHooks: 3,
  remainingLookalikes: 1,
  needs: { acknowledgeRetainedCopy: true, acknowledgeSharedScope: false },
  backup: {
    required: true,
    label: '~/.stroq/backups/console-setup/',
    configExisted: true,
    recordExisted: false,
  },
  evidence: 'configuration',
  verified: false,
  requiresRestart: true,
  needsApproval: false,
  nextSteps: ['Start a new agent session.'],
};
const receipt: SetupResult = {
  schema: 'stroq-agent-setup-result/2',
  status: 'review-required',
  previewId: preview.id,
  workspaceId,
  agent: preview.agent,
  scope: preview.scope,
  scopeImpact: preview.scopeImpact,
  target: preview.target,
  context: preview.context,
  sourceSha256: preview.sourceSha256,
  candidateSha256: preview.candidateSha256,
  operation: preview.operation,
  addedHooks: preview.addedHooks,
  replacedHooks: preview.replacedHooks,
  preservedHooks: preview.preservedHooks,
  remainingLookalikes: preview.remainingLookalikes,
  currentExactHooks: preview.hookEvents.length,
  configuredAt: new Date(now + 1000).toISOString(),
  backupId: preview.id,
  backup: {
    complete: true,
    label: `${preview.backup.label}${preview.id}.manifest.json`,
    configExisted: true,
    recordExisted: false,
  },
  evidence: 'configuration',
  verified: false,
  requiresRestart: true,
  needsApproval: false,
  nextSteps: [...preview.nextSteps],
};
const acknowledged = { acknowledgeRetainedCopy: true, acknowledgeSharedScope: false };

describe('exact setup consent and receipt binding', () => {
  it('keys workspace, selected agent/scope and open/read generation', () => {
    expect(agentSetupKey(workspaceId, 'claude-code', 'project', 1)).toBe(
      `${workspaceId}:claude-code:project:1`,
    );
    expect(agentSetupKey(workspaceId, 'claude-code', 'project', 2)).not.toBe(
      agentSetupKey(workspaceId, 'claude-code', 'project', 1),
    );
    for (const id of [null, '/Users/private', 'workspace-short'])
      expect(agentSetupKey(id, 'claude-code', 'project', 1)).toBeNull();
    expect(agentSetupKey(workspaceId, 'claude-code', 'project', -1)).toBeNull();
  });
  it('requires the selected workspace/agent/scope while preserving actual user-wide alias impact', () => {
    expect(validateSetupPreview(preview)).toBe(true);
    expect(
      setupPreviewMatches(preview, { workspaceId, agent: 'claude-code', scope: 'project' }),
    ).toBe(true);
    for (const selection of [
      { workspaceId: otherWorkspace, agent: 'claude-code' as const, scope: 'project' as const },
      { workspaceId, agent: 'cursor' as const, scope: 'project' as const },
      { workspaceId, agent: 'claude-code' as const, scope: 'user' as const },
    ])
      expect(setupPreviewMatches(preview, selection)).toBe(false);
    const alias = {
      ...preview,
      scopeImpact: 'all-workspaces' as const,
      target: '~/.claude/settings.json',
      needs: { ...preview.needs, acknowledgeSharedScope: true },
    };
    expect(validateSetupPreview(alias)).toBe(true);
    expect(
      setupPreviewMatches(alias, { workspaceId, agent: 'claude-code', scope: 'project' }),
    ).toBe(true);
  });
  it('binds hashes, counts, context, operation, approval and exact recovery reference', () => {
    expect(validateSetupResult(receipt)).toBe(true);
    expect(setupReceiptMatches(receipt, preview)).toBe(true);
    for (const change of [
      { workspaceId: otherWorkspace },
      { previewId: '22222222-2222-4222-8222-222222222222' },
      { configuredAt: new Date(now - 1).toISOString() },
      { agent: 'cursor' as const },
      { scope: 'user' as const },
      { scopeImpact: 'all-workspaces' as const },
      { context: 'Another project' },
      { target: '~/.claude/settings.json' },
      { sourceSha256: 'e'.repeat(64) },
      { candidateSha256: 'e'.repeat(64) },
      { operation: 'create' as const },
      { addedHooks: 1 },
      { replacedHooks: 1 },
      { preservedHooks: 2 },
      { remainingLookalikes: 0 },
      { currentExactHooks: 1 },
      { status: 'configured' as const },
      { needsApproval: true },
      { nextSteps: ['Unrelated advice'] },
      { backupId: null },
      { backup: { ...receipt.backup, complete: false } },
      { backup: { ...receipt.backup, configExisted: false } },
      { backup: { ...receipt.backup, recordExisted: true } },
      {
        backup: { ...receipt.backup, label: '~/.stroq/backups/console-setup/other.manifest.json' },
      },
    ])
      expect(setupReceiptMatches({ ...receipt, ...change }, preview), JSON.stringify(change)).toBe(
        false,
      );
  });
  it('requires retention and separate shared-context consent for changed user/alias sources', () => {
    expect(setupApplyInput(preview, emptySetupAcknowledgements(), now)).toBeNull();
    expect(setupApplyInput(preview, acknowledged, now)).toEqual({
      previewId: preview.id,
      confirm: true,
      acknowledgeRetainedCopy: true,
    });
    for (const scope of ['project', 'user'] as const) {
      const shared = {
        ...preview,
        scope,
        scopeImpact: 'all-workspaces' as const,
        target: '~/.claude/settings.json',
        needs: { acknowledgeRetainedCopy: true, acknowledgeSharedScope: true },
      };
      expect(validateSetupPreview(shared)).toBe(true);
      expect(setupApplyInput(shared, acknowledged, now)).toBeNull();
      expect(
        setupApplyInput(shared, { ...acknowledged, acknowledgeSharedScope: true }, now),
      ).toEqual({
        previewId: preview.id,
        confirm: true,
        acknowledgeRetainedCopy: true,
        acknowledgeSharedScope: true,
      });
    }
  });
  it('accepts a read-only no-op only with unchanged hashes, zero edits and no fabricated backup', () => {
    const unchanged: SetupPreview = {
      ...preview,
      operation: 'unchanged',
      candidateSha256: preview.sourceSha256!,
      addedHooks: 0,
      replacedHooks: 0,
      remainingLookalikes: 0,
      backup: { ...preview.backup, required: false },
      needs: { acknowledgeRetainedCopy: false, acknowledgeSharedScope: false },
    };
    const result: SetupResult = {
      ...receipt,
      status: 'unchanged',
      operation: 'unchanged',
      candidateSha256: unchanged.candidateSha256,
      addedHooks: 0,
      replacedHooks: 0,
      remainingLookalikes: 0,
      backupId: null,
      backup: { complete: false, label: null, configExisted: true, recordExisted: false },
    };
    expect(validateSetupPreview(unchanged)).toBe(true);
    expect(validateSetupResult(result)).toBe(true);
    expect(setupReceiptMatches(result, unchanged)).toBe(true);
    expect(setupReceiptMatches({ ...result, backupId: preview.id }, unchanged)).toBe(false);
    expect(setupApplyInput(unchanged, emptySetupAcknowledgements(), now)).toEqual({
      previewId: preview.id,
      confirm: true,
    });
    expect(setupReceiptMatches({ ...result, status: 'configured' }, unchanged)).toBe(false);
    expect(
      setupReceiptMatches(
        { ...result, status: 'review-required', remainingLookalikes: 1 },
        { ...unchanged, remainingLookalikes: 1 },
      ),
    ).toBe(true);
  });
  it('refuses expired consent and keeps a new-file receipt bound to a missing original source', () => {
    expect(setupApplyInput(preview, acknowledged, Date.parse(preview.expiresAt))).toBeNull();
    const fresh: SetupPreview = {
      ...preview,
      operation: 'create',
      sourceSha256: null,
      preservedHooks: 0,
      remainingLookalikes: 0,
      needs: { acknowledgeRetainedCopy: false, acknowledgeSharedScope: false },
      backup: { ...preview.backup, required: false, configExisted: false },
    };
    const result: SetupResult = {
      ...receipt,
      status: 'configured',
      operation: 'create',
      sourceSha256: null,
      preservedHooks: 0,
      remainingLookalikes: 0,
      backup: { ...receipt.backup, configExisted: false },
    };
    expect(validateSetupPreview(fresh)).toBe(true);
    expect(validateSetupResult(result)).toBe(true);
    expect(setupReceiptMatches(result, fresh)).toBe(true);
    expect(
      setupReceiptMatches({ ...result, backup: { ...result.backup, configExisted: true } }, fresh),
    ).toBe(false);
  });
  it('requires retention consent for a new settings file when an installation record already exists', () => {
    const fresh: SetupPreview = {
      ...preview,
      operation: 'create',
      sourceSha256: null,
      preservedHooks: 0,
      remainingLookalikes: 0,
      backup: { ...preview.backup, configExisted: false, recordExisted: true },
    };
    expect(validateSetupPreview(fresh)).toBe(true);
    expect(setupApplyInput(fresh, emptySetupAcknowledgements(), now)).toBeNull();
    expect(setupApplyInput(fresh, acknowledged, now)).toEqual({
      previewId: fresh.id,
      confirm: true,
      acknowledgeRetainedCopy: true,
    });
    const result: SetupResult = {
      ...receipt,
      status: 'configured',
      operation: 'create',
      sourceSha256: null,
      preservedHooks: 0,
      remainingLookalikes: 0,
      backup: { ...receipt.backup, configExisted: false, recordExisted: true },
    };
    expect(validateSetupResult(result)).toBe(true);
    expect(setupReceiptMatches(result, fresh)).toBe(true);
    expect(
      setupReceiptMatches({ ...result, backup: { ...result.backup, recordExisted: false } }, fresh),
    ).toBe(false);
  });
});
