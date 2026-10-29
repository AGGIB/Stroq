import { describe, expect, it } from 'vitest';
import {
  hookCheckHref,
  hookCheckHrefForSetup,
  parseHookCheckNavigation,
  resolveHookCheckNavigation,
} from './hook-check-navigation';
import type { HookCheckState } from './hook-checks';
const workspaceId = 'workspace-' + 'a'.repeat(24);
const foreign = 'workspace-' + 'b'.repeat(24);
const sourceSha256 = 'c'.repeat(64);
const jobId = '11111111-1111-4111-8111-111111111111';
const job = {
  schema: 'stroq-hook-check-job/1' as const,
  id: jobId,
  previewId: '22222222-2222-4222-8222-222222222222',
  binding: {
    workspaceId,
    agent: 'cursor' as const,
    scope: 'user' as const,
    sourceSha256,
    policySha256: null,
    policySemanticSha256: sourceSha256,
    runtimeSha256: sourceSha256,
  },
  status: 'running' as const,
  startedAt: '2026-10-24T01:00:00.000Z',
};
const state: HookCheckState = {
  schema: 'stroq-hook-checks/1',
  workspaceId,
  engine: { available: true, version: '0.28.0' },
  agents: ['claude-code', 'cursor', 'codex'].map((id) => ({
    id: id as 'cursor',
    supported: true,
    reason: null,
  })),
  history: { status: 'ready' },
  jobs: [job],
};
describe('bounded hook-check navigation', () => {
  it('creates canonical overview, exact setup source and exact retained run links', () => {
    expect(hookCheckHref()).toBe('/agents/hooks/');
    const href = hookCheckHref({ workspaceId, agent: 'cursor', scope: 'user', sourceSha256 });
    expect(href).toBe(
      `/agents/hooks/?workspace=${workspaceId}&agent=cursor&scope=user&source=${sourceSha256}`,
    );
    expect(parseHookCheckNavigation(href!.split('?')[1]!)).toEqual({
      kind: 'selection',
      workspaceId,
      agent: 'cursor',
      scope: 'user',
      sourceSha256,
    });
    expect(hookCheckHref({ workspaceId, jobId })).toBe(
      `/agents/hooks/?workspace=${workspaceId}&job=${jobId}`,
    );
  });
  it('rejects duplicates, unknown/private fields, incomplete targets and run/source conflicts', () => {
    for (const query of [
      `workspace=${workspaceId}`,
      `agent=cursor&scope=user`,
      `workspace=${workspaceId}&agent=cursor&scope=user&scope=project`,
      `workspace=${workspaceId}&agent=other&scope=user`,
      `workspace=${workspaceId}&agent=cursor&scope=user&source=private`,
      `workspace=${workspaceId}&job=${jobId}&source=${sourceSha256}`,
      `workspace=${workspaceId}&job=${jobId}&agent=cursor&scope=user`,
      `workspace=${workspaceId}&job=${jobId}&path=/private/config`,
      `workspace=${workspaceId}&job=`,
      'x'.repeat(700),
    ])
      expect(parseHookCheckNavigation(query)).toEqual({ kind: 'invalid' });
    expect(hookCheckHref({ workspaceId, agent: 'cursor' })).toBeNull();
    expect(hookCheckHref({ workspaceId, jobId, sourceSha256 })).toBeNull();
  });
  it('keeps exact missing, foreign, invalid and unavailable selections as gaps without latest fallback', () => {
    const nav = parseHookCheckNavigation(`workspace=${workspaceId}&job=${jobId}`);
    expect(resolveHookCheckNavigation(nav, workspaceId, state)).toEqual({
      status: 'job',
      job,
      selection: { workspaceId, agent: 'cursor', scope: 'user' },
    });
    expect(resolveHookCheckNavigation(nav, foreign, state)).toEqual({
      status: 'foreign-workspace',
    });
    expect(resolveHookCheckNavigation(nav, null, null)).toEqual({ status: 'context-unavailable' });
    expect(resolveHookCheckNavigation(nav, workspaceId, null)).toEqual({ status: 'loading' });
    expect(resolveHookCheckNavigation(nav, workspaceId, { ...state, jobs: [] })).toEqual({
      status: 'missing-run',
    });
    expect(
      resolveHookCheckNavigation(nav, workspaceId, {
        ...state,
        history: { status: 'error', error: 'read-failed' },
        jobs: [],
      }),
    ).toEqual({ status: 'history-unavailable' });
    expect(resolveHookCheckNavigation({ kind: 'invalid' }, workspaceId, state)).toEqual({
      status: 'invalid',
    });
    expect(
      resolveHookCheckNavigation(nav, workspaceId, {
        ...state,
        private: 'unsafe',
      } as HookCheckState),
    ).toEqual({ status: 'invalid' });
  });
  it('never trusts a malformed setup receipt or substitutes caller props', () => {
    expect(
      hookCheckHrefForSetup({
        workspaceId,
        agent: 'cursor',
        scope: 'user',
        candidateSha256: sourceSha256,
      }),
    ).toBeNull();
    const result = {
      schema: 'stroq-agent-setup-result/2',
      status: 'review-required',
      previewId: jobId,
      workspaceId,
      agent: 'cursor',
      scope: 'project',
      scopeImpact: 'all-workspaces',
      target: '~/.cursor/hooks.json',
      context: 'This user',
      operation: 'unchanged',
      configuredAt: '2026-10-24T01:00:00.000Z',
      sourceSha256,
      candidateSha256: sourceSha256,
      addedHooks: 0,
      replacedHooks: 0,
      preservedHooks: 1,
      remainingLookalikes: 1,
      currentExactHooks: 7,
      backupId: null,
      backup: { complete: false, label: null, configExisted: true, recordExisted: false },
      evidence: 'configuration',
      verified: false,
      requiresRestart: true,
      needsApproval: false,
      nextSteps: [],
    };
    expect(hookCheckHrefForSetup(result)).toBe(
      `/agents/hooks/?workspace=${workspaceId}&agent=cursor&scope=project&source=${sourceSha256}`,
    );
    expect(result.status).toBe('review-required');
    expect(hookCheckHrefForSetup({ ...result, raw: 'private' })).toBeNull();
    expect(hookCheckHref({ [Symbol('private')]: 'value' })).toBeNull();
  });
});
