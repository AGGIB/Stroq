import type { ProtectionEvidenceRow } from './protection-evidence';
import { taskLockHref } from './task-lock-navigation';
import type { TaskLockState } from './task-locks';

/** Reviews issued authority; neither a file nor an idle permit proves a running process. */
export function taskLockRows(
  state: TaskLockState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (!state || !workspaceId || state.workspaceId !== workspaceId || !state.available)
    return [
      {
        key: 'task-locks-unavailable',
        title: 'Task permissions unavailable',
        detail:
          'Existing task permits could not be inspected for this workspace. Current authority is unknown.',
        href: taskLockHref(),
        action: 'Review permissions',
        tone: 'orange',
      },
    ];
  const rows: ProtectionEvidenceRow[] = [];
  if (!state.coverage.complete)
    rows.push({
      key: 'task-locks-coverage',
      title: 'Task-permit inspection is incomplete',
      detail: `Checked ${state.checkedAt}. ${state.coverage.unverified} entries could not be verified; workspace membership is unknown.${state.coverage.limited ? ' The bounded inspection limit was reached.' : ''}`,
      href: taskLockHref(),
      action: 'Inspect coverage',
      tone: 'orange',
    });
  const review = state.tasks.filter(
    (task) =>
      task.standing === 'present' &&
      task.eligibility !== 'expired' &&
      task.policyRelation !== 'matches-current',
  );
  if (review.length > 1) {
    rows.push({
      key: 'task-policies',
      title: `${review.length} task permits need policy review`,
      detail: `Captured ${state.checkedAt}. Existing tasks keep their launch policy; this does not establish a running process or adoption of the current file.`,
      href: taskLockHref(),
      action: 'Review tasks',
      tone: 'orange',
    });
    return rows;
  }
  for (const task of review) {
    rows.push({
      key: `task-policy-${task.id}`,
      title:
        task.policyRelation === 'unavailable'
          ? 'Task policy comparison unavailable'
          : 'Task permit policy differs from current',
      detail: `Captured ${state.checkedAt}; permit expires ${task.expiresAt}. An existing task keeps its launch policy. This does not establish a running agent or adoption of the current file.`,
      href: taskLockHref(task.id, workspaceId),
      action: 'Review task',
      tone: 'orange',
    });
  }
  return rows;
}
