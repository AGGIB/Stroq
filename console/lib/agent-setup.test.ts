import { describe, it, expect } from 'vitest';
import {
  setupSelection,
  validateSetupPreview,
  validateSetupResult,
  validateSetupState,
  type SetupPreview,
  type SetupResult,
} from './agent-setup';
const preview = {
  schema: 'stroq-agent-setup-preview/2',
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-10-23T01:00:03.000Z',
  expiresAt: '2026-10-23T01:02:03.000Z',
  workspaceId: 'workspace-' + 'a'.repeat(24),
  agent: 'claude-code',
  scope: 'project',
  scopeImpact: 'workspace',
  context: 'surface',
  target: 'Workspace/.claude/settings.json',
  operation: 'create',
  sourceSha256: null,
  candidateSha256: 'a'.repeat(64),
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
  preservedHooks: 0,
  replacedHooks: 0,
  remainingLookalikes: 0,
  needs: { acknowledgeSharedScope: false, acknowledgeRetainedCopy: false },
  backup: {
    required: false,
    label: '~/.stroq/backups/console-setup/',
    configExisted: false,
    recordExisted: false,
  },
  evidence: 'configuration',
  verified: false,
  requiresRestart: true,
  needsApproval: false,
  nextSteps: ['Restart the agent.'],
} satisfies SetupPreview;
const receipt = {
  schema: 'stroq-agent-setup-result/2',
  status: 'configured',
  previewId: preview.id,
  workspaceId: preview.workspaceId,
  agent: preview.agent,
  scope: preview.scope,
  scopeImpact: preview.scopeImpact,
  target: preview.target,
  context: preview.context,
  operation: preview.operation,
  configuredAt: preview.createdAt,
  sourceSha256: null,
  candidateSha256: preview.candidateSha256,
  addedHooks: 3,
  preservedHooks: 0,
  replacedHooks: 0,
  remainingLookalikes: 0,
  currentExactHooks: 3,
  backupId: preview.id,
  backup: {
    complete: true,
    label: `~/.stroq/backups/console-setup/${preview.id}.manifest.json`,
    configExisted: false,
    recordExisted: false,
  },
  evidence: 'configuration',
  verified: false,
  requiresRestart: true,
  needsApproval: false,
  nextSteps: preview.nextSteps,
} satisfies SetupResult;
describe('agent setup evidence', () => {
  it('keeps configured hooks separate from live verification', () => {
    expect(validateSetupPreview(preview)).toBe(true);
    expect(validateSetupPreview({ ...preview, verified: true })).toBe(false);
  });
  it('rejects a premature receipt, injected raw config and unknown scopes', () => {
    expect(validateSetupResult(preview)).toBe(false);
    expect(validateSetupPreview({ ...preview, raw: { env: { KEY: 'secret' } } })).toBe(false);
    expect(validateSetupPreview({ ...preview, scope: 'arbitrary-path' })).toBe(false);
  });
  it('binds all event rows, hashes, lifetime and exact target to this workspace and agent', () => {
    for (const patch of [
      { workspaceId: 'surface' },
      { target: '~/arbitrary' },
      { hookEvents: preview.hookEvents.slice(0, 1) },
      { hookEvents: [...preview.hookEvents].reverse() },
      { createdAt: preview.expiresAt },
      { expiresAt: '2026-10-23T02:00:03.000Z' },
      { sourceSha256: 'b'.repeat(64) },
      { candidateSha256: null },
      { needsApproval: true },
      { addedHooks: 0 },
      { preservedHooks: 1 },
      { replacedHooks: 1 },
    ])
      expect(validateSetupPreview({ ...preview, ...patch })).toBe(false);
  });
  it('requires retained-copy and shared-scope disclosure only when a change needs them', () => {
    const updated = {
      ...preview,
      operation: 'update',
      sourceSha256: 'b'.repeat(64),
      scope: 'user',
      scopeImpact: 'all-workspaces',
      target: '~/.claude/settings.json',
      needs: { acknowledgeSharedScope: true, acknowledgeRetainedCopy: true },
      backup: { ...preview.backup, required: true, configExisted: true },
    };
    expect(validateSetupPreview(updated)).toBe(true);
    expect(validateSetupPreview({ ...updated, needs: preview.needs })).toBe(false);
    expect(
      validateSetupPreview({ ...updated, backup: { ...updated.backup, required: false } }),
    ).toBe(false);
    const recordOnly = {
      ...preview,
      needs: { ...preview.needs, acknowledgeRetainedCopy: true },
      backup: { ...preview.backup, required: true, recordExisted: true },
    };
    expect(validateSetupPreview(recordOnly)).toBe(true);
  });
  it('accepts configuration receipts but refuses a green result with retained ambiguous registrations', () => {
    expect(validateSetupResult(receipt)).toBe(true);
    const reviewed = {
      ...receipt,
      status: 'review-required',
      operation: 'update',
      sourceSha256: 'b'.repeat(64),
      backup: { ...receipt.backup, configExisted: true },
      remainingLookalikes: 1,
      preservedHooks: 2,
    };
    expect(validateSetupResult(reviewed)).toBe(true);
    for (const patch of [
      { status: 'configured' },
      { preservedHooks: 0 },
      { verified: true },
      { currentExactHooks: 2 },
      { backupId: null },
    ])
      expect(validateSetupResult({ ...reviewed, ...patch })).toBe(false);
  });
  it('requires no-op receipts to have equal hashes, zero changes and no recovery copy', () => {
    const unchanged = {
      ...receipt,
      status: 'unchanged',
      operation: 'unchanged',
      sourceSha256: receipt.candidateSha256,
      addedHooks: 0,
      backupId: null,
      backup: { ...receipt.backup, complete: false, label: null, configExisted: true },
    };
    expect(validateSetupResult(unchanged)).toBe(true);
    for (const patch of [
      { addedHooks: 1 },
      { replacedHooks: 1 },
      { sourceSha256: 'b'.repeat(64) },
      { backupId: receipt.backupId },
      { backup: receipt.backup },
    ])
      expect(validateSetupResult({ ...unchanged, ...patch })).toBe(false);
  });
  it('keeps state availability consistent across every selectable agent', () => {
    const state = {
      schema: 'stroq-agent-setup/2',
      workspaceId: preview.workspaceId,
      available: true,
      context: { workspace: 'surface', userScope: 'This user' },
      engineVersion: '0.28.0',
      agents: ['claude-code', 'cursor', 'codex'].map((id) => ({
        id,
        scopes: ['project', 'user'],
        available: true,
      })),
    };
    expect(validateSetupState(state)).toBe(true);
    expect(validateSetupState({ ...state, agents: state.agents.slice(1) })).toBe(false);
    // Windsurf is no longer an agent the console connects.
    expect(
      validateSetupState({
        ...state,
        agents: [...state.agents, { id: 'windsurf', scopes: ['project', 'user'], available: true }],
      }),
    ).toBe(false);
    expect(validateSetupState({ ...state, available: false })).toBe(false);
    expect(validateSetupState({ ...state, engineVersion: null })).toBe(false);
  });
});

describe('setup action context', () => {
  it('opens the exact agent and scope from a user or workspace action', () => {
    expect(setupSelection('cursor', 'user')).toEqual({ agent: 'cursor', scope: 'user' });
    expect(setupSelection('codex', 'project')).toEqual({ agent: 'codex', scope: 'project' });
  });
  it('resolves each new session from its current action context', () => {
    const previousSession = setupSelection('claude-code', 'project');
    expect(setupSelection('codex', 'user')).toEqual({ agent: 'codex', scope: 'user' });
    expect(setupSelection('windsurf', 'user')).toEqual({ agent: 'claude-code', scope: 'user' });
    expect(previousSession).toEqual({ agent: 'claude-code', scope: 'project' });
    expect(setupSelection(undefined, 'user')).toEqual({ agent: 'claude-code', scope: 'user' });
  });
  it('keeps the explicit scope when the invoking agent is absent or unsupported', () => {
    expect(setupSelection()).toEqual({ agent: 'claude-code', scope: 'project' });
    for (const id of ['not-an-agent', 'constructor', 'toString', '__proto__'])
      expect(setupSelection(id, 'user')).toEqual({ agent: 'claude-code', scope: 'user' });
  });
});
