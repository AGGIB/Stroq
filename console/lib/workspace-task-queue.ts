import { validateWorkspaceTaskState, type WorkspaceTaskRecord } from './workspace-task-controls';
import { workspaceTaskRecoveryHref } from './workspace-task-controls-binding';
import { workspaceReviewHref } from './workspace-review-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

export const WORKSPACE_TASK_ATTENTION_LIMIT = 6;
type Reason = { priority: number; title: string; detail: string };
function attention(record: WorkspaceTaskRecord): Reason | null {
  if (['prepared', 'restoring', 'uncertain'].includes(record.status))
    return {
      priority: 0,
      title: 'Task change needs recheck',
      detail: 'Completion is unverified. Open this retained record and recheck it explicitly.',
    };
  const phase =
    record.status === 'manual'
      ? 'File change recorded'
      : record.status === 'restored'
        ? 'Restore recorded'
        : 'Original file observed';
  const fileTitle = {
    changed: 'Task file changed after recorded action',
    missing: 'Task file missing',
    unverifiable: 'Current task file unverified',
  } as const;
  if (
    record.fileState === 'changed' ||
    record.fileState === 'missing' ||
    record.fileState === 'unverifiable'
  )
    return {
      priority: 1,
      title: fileTitle[record.fileState],
      detail: `${phase}. Current file evidence needs an explicit recheck; the historical result is unchanged.`,
    };
  const expected = record.status === 'manual' ? 'manual-version' : 'original-version';
  if (record.fileState !== expected)
    return {
      priority: 1,
      title: 'Task file differs from recorded result',
      detail: `${phase}. A different retained version is currently present. Recheck this record before another file action.`,
    };
  if (!record.recoveryAvailable)
    return {
      priority: 2,
      title: 'Task recovery copy unavailable',
      detail: `${phase}. The retained private copy could not be verified; recovery availability is not established.`,
    };
  const verification = record.verification;
  if (!verification)
    return record.status === 'unchanged'
      ? null
      : {
          priority: 3,
          title: 'Task change needs static verification',
          detail: `${phase}. No associated post-change static capture is recorded.`,
        };
  if (verification.status === 'unavailable')
    return {
      priority: 3,
      title: 'Task verification unavailable',
      detail: `${phase}. The associated static capture could not be completed or verified.`,
    };
  if (!verification.sourceMatches)
    return {
      priority: 3,
      title: 'Task source not verified by capture',
      detail: `${phase}. The associated capture did not verify the expected task file bytes and mode.`,
    };
  if (!verification.complete)
    return {
      priority: 4,
      title: 'Workspace verification incomplete',
      detail: `${phase}. The associated static capture has coverage gaps; a matching task file does not establish complete workspace coverage.`,
    };
  return null;
}

/** Projects saved file/recovery evidence only. Reading a queue never starts a recheck or capture. */
export function workspaceTaskRows(
  state: unknown,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (
    !workspaceId ||
    !validateWorkspaceTaskState(state) ||
    state.workspaceId !== workspaceId ||
    !state.available
  )
    return [
      {
        key: 'workspace-task-history',
        title: 'Task change history unavailable',
        detail:
          'Retained task changes could not be verified for this workspace. No successful or empty recovery history was inferred.',
        href: workspaceReviewHref(),
        action: 'Inspect recovery',
        tone: 'orange',
      },
    ];
  const records = state.records
    .flatMap((record) => {
      const reason = attention(record);
      return reason ? [{ record, reason }] : [];
    })
    .toSorted(
      (left, right) =>
        left.reason.priority - right.reason.priority ||
        right.record.updatedAt.localeCompare(left.record.updatedAt) ||
        left.record.id.localeCompare(right.record.id),
    );
  const context = `.vscode/tasks.json · Checked ${new Date(state.generatedAt).toLocaleString('en-GB')}`;
  const rows: ProtectionEvidenceRow[] = records
    .slice(0, WORKSPACE_TASK_ATTENTION_LIMIT)
    .map(({ record, reason }) => ({
      key: `workspace-task:${record.id}`,
      title: reason.title,
      context,
      detail: reason.detail,
      href: workspaceTaskRecoveryHref(record),
      action: 'Inspect change',
      tone: 'orange',
    }));
  const omitted = records.slice(WORKSPACE_TASK_ATTENTION_LIMIT);
  if (omitted.length)
    rows.push({
      key: 'workspace-task-overflow',
      title: `${omitted.length} more task ${omitted.length === 1 ? 'change needs' : 'changes need'} attention`,
      context,
      detail:
        'Additional retained task changes need attention. Every record remains available in task change recovery.',
      href: workspaceTaskRecoveryHref(omitted[0]!.record),
      action: 'Inspect more changes',
      tone: 'orange',
    });
  return rows;
}
