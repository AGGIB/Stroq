import { describe, expect, it } from 'vitest';
import { taskLockRows } from './task-lock-queue';
import { TASK_LOCK_LIMITATIONS, type TaskLockState } from './task-locks';
const workspaceId = `workspace-${'a'.repeat(24)}`,
  id = `task-${'b'.repeat(64)}`,
  sha = 'c'.repeat(64);
function state(): TaskLockState {
  return {
    schema: 'stroq-task-locks/1',
    workspaceId,
    host: 'claude-code',
    checkedAt: '2026-10-23T00:00:00.000Z',
    currentPolicySha256: sha,
    available: true,
    reason: null,
    coverage: { complete: true, limited: false, unverified: 0, foreign: 0 },
    tasks: [
      {
        id,
        permitSha256: sha,
        profile: 'code',
        policySha256: 'd'.repeat(64),
        issuedAt: '2026-10-23T00:00:00.000Z',
        expiresAt: '2026-10-23T01:00:00.000Z',
        declaredMode: 'hook-only',
        eligibility: 'eligible',
        standing: 'present',
        policyRelation: 'differs-current',
        scope: {
          tools: ['Bash'],
          shell: 'allowed',
          read: { allow: [], deny: [] },
          write: { allow: [], deny: [] },
          net: { mode: 'none' },
          mcp: [],
        },
        evidence: { status: 'missing', journalSha256: null, counts: null, lastGate: null },
      },
    ],
    limitations: TASK_LOCK_LIMITATIONS,
  };
}
describe('task permission review queue', () => {
  it('groups multiple task-policy gaps into one review entry', () => {
    const value = state();
    value.tasks.push({ ...value.tasks[0]!, id: `task-${'f'.repeat(64)}` });
    const rows = taskLockRows(value, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('2 task permits');
    expect(rows[0]!.href).toBe('/agents/tasks/');
  });
  it('links exact workspace/task for an unexpired captured policy difference without claiming running state', () => {
    const rows = taskLockRows(state(), workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.href).toContain(id);
    expect(rows[0]!.detail).toContain('does not establish');
    expect(rows[0]!.title).not.toMatch(/running|stopped|protected/i);
  });
  it('keeps terminal and expired permissions out of current policy-drift action rows', () => {
    for (const change of [
      { standing: 'revoked' as const },
      { standing: 'ended' as const },
      { eligibility: 'expired' as const },
    ]) {
      const value = state();
      Object.assign(value.tasks[0]!, change);
      if ('eligibility' in change) value.checkedAt = '2026-10-24T00:00:00.000Z';
      expect(taskLockRows(value, workspaceId)).toEqual([]);
    }
  });
  it('keeps empty complete stores quiet but unavailable/foreign/partial evidence explicit', () => {
    expect(taskLockRows({ ...state(), tasks: [] }, workspaceId)).toEqual([]);
    expect(taskLockRows(null, workspaceId)[0]!.tone).toBe('orange');
    expect(taskLockRows(state(), `workspace-${'e'.repeat(24)}`)[0]!.key).toContain('unavailable');
    const value = state();
    value.tasks = [];
    value.coverage = { complete: false, limited: true, unverified: 2, foreign: 1 };
    expect(taskLockRows(value, workspaceId)[0]!.detail).toContain('membership');
  });
  it('does not infer a new policy or an adopted sandbox from unknown comparison/mode', () => {
    const value = state();
    value.tasks[0]!.policyRelation = 'unavailable';
    value.currentPolicySha256 = null;
    expect(taskLockRows(value, workspaceId)[0]!.title).toContain('comparison');
    expect(taskLockRows(value, workspaceId)[0]!.tone).toBe('orange');
  });
});
