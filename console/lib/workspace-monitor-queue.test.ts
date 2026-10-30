import { describe, expect, it } from 'vitest';
import { workspaceMonitorRows } from './workspace-monitor-queue';
import { validateWorkspaceMonitorState, type WorkspaceMonitorState } from './workspace-monitor';
const workspaceId = `workspace-${'a'.repeat(24)}`;
function state(status: WorkspaceMonitorState['status'] = 'disabled'): WorkspaceMonitorState {
  return {
    schema: 'stroq-workspace-monitor/1',
    workspaceId,
    status,
    reason: null,
    revision: 'b'.repeat(64),
    configuredAt: '2026-10-24T00:00:00.000Z',
    runtimeSha256: 'c'.repeat(64),
    intervalMs: 300000,
    nextCheckAt: null,
    activeRunId: null,
    lastAttempt: null,
  };
}
describe('workspace change watch in the attention queue', () => {
  it('keeps disabled and normally enabled watches quiet without inventing protection', () => {
    for (const status of ['disabled', 'enabled', 'stopped'] as const) {
      const value = state(status);
      expect(validateWorkspaceMonitorState(value)).toBe(true);
      expect(workspaceMonitorRows(value, workspaceId)).toEqual([]);
    }
  });
  it('shows a paused stale binding once and links to explicit watch review', () => {
    expect(workspaceMonitorRows(state('needs-review'), workspaceId)).toEqual([
      {
        key: 'workspace-monitor-needs-review',
        title: 'Change watch needs review',
        detail:
          'The saved watch must be reviewed for the current workspace and runtime before checks resume.',
        href: '/protection/workspace/',
        action: 'Review watch',
        tone: 'orange',
      },
    ]);
  });
  it('distinguishes another console owner from unavailable evidence', () => {
    expect(workspaceMonitorRows(state('in-use'), workspaceId)[0]).toMatchObject({
      key: 'workspace-monitor-in-use',
      tone: 'muted',
      title: 'Change watch is open in another console',
    });
    expect(workspaceMonitorRows(state('unavailable'), workspaceId)[0]).toMatchObject({
      key: 'workspace-monitor-unavailable',
      tone: 'orange',
      title: 'Change watch state unavailable',
    });
  });
  it('never treats foreign or malformed evidence as disabled success and emits no dynamic paths', () => {
    for (const value of [
      null,
      { ...state(), workspaceId: `workspace-${'d'.repeat(24)}` },
      { ...state(), private: 'PRIVATE_PATH' },
    ] as (WorkspaceMonitorState | null)[]) {
      const rows = workspaceMonitorRows(value, workspaceId);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.href).toBe('/protection/workspace/');
      expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    }
  });
  it('does not duplicate running or changed capture rows owned by workspaceReviewRows', () => {
    const value = state('enabled'),
      id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    value.activeRunId = id;
    value.lastAttempt = {
      status: 'running',
      runId: id,
      startedAt: '2026-10-24T01:00:00.000Z',
      finishedAt: null,
      error: null,
    };
    expect(validateWorkspaceMonitorState(value)).toBe(true);
    expect(workspaceMonitorRows(value, workspaceId)).toEqual([]);
  });
});
