import { describe, expect, it } from 'vitest';
import type { HookCheckBinding, HookCheckJob, HookCheckPreview } from './hook-checks';
import {
  hookCheckBindingMatches,
  hookCheckJobMatches,
  hookCheckPreviewMatches,
  hookCheckSelectionKey,
  hookCheckStartInput,
  hookCheckStartMatches,
  hookCheckSourceMatches,
  scopedHookCheckJobs,
} from './hook-check-binding';

const workspaceId = `workspace-${'a'.repeat(24)}`;
const binding: HookCheckBinding = {
  workspaceId,
  agent: 'claude-code',
  scope: 'project',
  sourceSha256: 'b'.repeat(64),
  policySha256: null,
  policySemanticSha256: 'c'.repeat(64),
  runtimeSha256: 'd'.repeat(64),
};
const preview = {
  schema: 'stroq-hook-check-preview/1',
  id: '11111111-1111-4111-8111-111111111111',
  agent: 'claude-code',
  scope: 'project',
  createdAt: '2026-10-23T00:00:00.000Z',
  expiresAt: '2026-10-23T00:02:00.000Z',
  engineVersion: '0.28.0',
  canStart: true,
  reason: null,
  binding,
} satisfies HookCheckPreview;
const job = {
  schema: 'stroq-hook-check-job/1',
  id: '22222222-2222-4222-8222-222222222222',
  previewId: preview.id,
  binding,
  status: 'running',
  startedAt: '2026-10-23T00:00:01.000Z',
} as HookCheckJob;
const selected = { workspaceId, agent: 'claude-code' as const, scope: 'project' as const };

describe('offline hook-check selection and acknowledgement binding', () => {
  it('separates workspace, agent, scope and parent refresh generations', () => {
    const key = hookCheckSelectionKey(workspaceId, 'claude-code', 'project', 0);
    expect(key).toBeTruthy();
    expect(hookCheckSelectionKey(workspaceId, 'claude-code', 'user', 0)).not.toBe(key);
    expect(hookCheckSelectionKey(workspaceId, 'cursor', 'project', 0)).not.toBe(key);
    expect(
      hookCheckSelectionKey(`workspace-${'b'.repeat(24)}`, 'claude-code', 'project', 0),
    ).not.toBe(key);
    expect(hookCheckSelectionKey(workspaceId, 'claude-code', 'project', 1)).not.toBe(key);
    expect(hookCheckSelectionKey(null, 'claude-code', 'project', 0)).toBeNull();
    expect(hookCheckSelectionKey('/private/project', 'claude-code', 'project', 0)).toBeNull();
    expect(hookCheckSelectionKey(workspaceId, 'claude-code', 'project', -1)).toBeNull();
  });

  it('accepts only the selected preview, including unavailable previews without a binding', () => {
    expect(hookCheckPreviewMatches(preview, selected)).toBe(true);
    expect(hookCheckPreviewMatches({ ...preview, agent: 'cursor' }, selected)).toBe(false);
    expect(hookCheckPreviewMatches({ ...preview, scope: 'user' }, selected)).toBe(false);
    expect(
      hookCheckPreviewMatches(
        { ...preview, binding: { ...binding, workspaceId: `workspace-${'f'.repeat(24)}` } },
        selected,
      ),
    ).toBe(false);
    expect(
      hookCheckPreviewMatches({ ...preview, binding: { ...binding, scope: 'user' } }, selected),
    ).toBe(false);
    expect(hookCheckPreviewMatches({ ...preview, canStart: false, binding: null }, selected)).toBe(
      true,
    );
    expect(hookCheckPreviewMatches({ ...preview, binding: null }, selected)).toBe(false);
  });

  it('compares every source, policy and runtime field without treating a default policy as unknown', () => {
    expect(hookCheckBindingMatches(binding, { ...binding })).toBe(true);
    for (const field of ['sourceSha256', 'policySemanticSha256', 'runtimeSha256'] as const)
      expect(hookCheckBindingMatches(binding, { ...binding, [field]: 'f'.repeat(64) })).toBe(false);
    expect(hookCheckBindingMatches(binding, { ...binding, policySha256: 'f'.repeat(64) })).toBe(
      false,
    );
    expect(hookCheckBindingMatches(binding, { ...binding, agent: 'cursor' })).toBe(false);
    expect(hookCheckBindingMatches(binding, { ...binding, scope: 'user' })).toBe(false);
  });

  it('starts only a fresh runnable preview and sends only its opaque identifier', () => {
    const now = Date.parse(preview.createdAt) + 1;
    expect(hookCheckStartInput(preview, now)).toEqual({ previewId: preview.id });
    expect(hookCheckStartInput(preview, Date.parse(preview.expiresAt))).toBeNull();
    expect(hookCheckStartInput({ ...preview, canStart: false }, now)).toBeNull();
    expect(hookCheckStartInput({ ...preview, binding: null }, now)).toBeNull();
  });
  it('requires the setup-receipted source hash before a handoff can start', () => {
    expect(hookCheckSourceMatches(preview)).toBe(true);
    expect(hookCheckSourceMatches(preview, binding.sourceSha256)).toBe(true);
    expect(hookCheckSourceMatches(preview, 'f'.repeat(64))).toBe(false);
    expect(hookCheckSourceMatches(preview, '/private/source')).toBe(false);
    expect(
      hookCheckSourceMatches({ ...preview, binding: null, canStart: false }, binding.sourceSha256),
    ).toBe(false);
  });

  it('requires the exact preview and binding on a start acknowledgement', () => {
    expect(hookCheckStartMatches(job, preview)).toBe(true);
    expect(
      hookCheckStartMatches({ ...job, previewId: '33333333-3333-4333-8333-333333333333' }, preview),
    ).toBe(false);
    expect(hookCheckStartMatches({ ...job, startedAt: '2026-10-22T23:59:59.000Z' }, preview)).toBe(
      false,
    );
    expect(
      hookCheckStartMatches(
        { ...job, binding: { ...binding, sourceSha256: 'f'.repeat(64) } },
        preview,
      ),
    ).toBe(false);
  });

  it('polls and cancels only the exact retained attempt, never another job with the same selection', () => {
    expect(hookCheckJobMatches(job, job)).toBe(true);
    expect(hookCheckJobMatches({ ...job, id: '33333333-3333-4333-8333-333333333333' }, job)).toBe(
      false,
    );
    expect(
      hookCheckJobMatches({ ...job, binding: { ...binding, runtimeSha256: 'f'.repeat(64) } }, job),
    ).toBe(false);
    expect(
      hookCheckJobMatches({ ...job, previewId: '33333333-3333-4333-8333-333333333333' }, job),
    ).toBe(false);
    expect(hookCheckJobMatches({ ...job, startedAt: '2026-10-23T00:00:02.000Z' }, job)).toBe(false);
  });

  it('keeps history scoped and ordered without replacing an explicit missing selection', () => {
    const newer = {
      ...job,
      id: '33333333-3333-4333-8333-333333333333',
      startedAt: '2026-10-23T00:00:02.000Z',
    };
    const foreign = { ...job, binding: { ...binding, workspaceId: `workspace-${'f'.repeat(24)}` } };
    const user = { ...job, binding: { ...binding, scope: 'user' as const } };
    expect(
      scopedHookCheckJobs([job, foreign, newer, user], selected).map((item) => item.id),
    ).toEqual([newer.id, job.id]);
    expect(scopedHookCheckJobs([foreign, user], selected)).toEqual([]);
  });
});
