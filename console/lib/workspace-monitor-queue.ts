import { validateWorkspaceMonitorState, type WorkspaceMonitorState } from './workspace-monitor';
import { workspaceReviewHref } from './workspace-review-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** Watch intent is separate from captured changes, which workspaceReviewRows already reports. */
export function workspaceMonitorRows(
  state: WorkspaceMonitorState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const row = (
    key: string,
    title: string,
    detail: string,
    action = 'Inspect watch',
    tone: ProtectionEvidenceRow['tone'] = 'orange',
  ): ProtectionEvidenceRow[] => [
    {
      key: `workspace-monitor-${key}`,
      title,
      detail,
      href: workspaceReviewHref(),
      action,
      tone,
    },
  ];
  if (!workspaceId || !validateWorkspaceMonitorState(state) || state.workspaceId !== workspaceId)
    return row(
      'unavailable',
      'Change watch state unavailable',
      'Saved watch intent could not be verified. No active watch was inferred.',
    );
  if (state.status === 'needs-review')
    return row(
      'needs-review',
      'Change watch needs review',
      'The saved watch must be reviewed for the current workspace and runtime before checks resume.',
      'Review watch',
    );
  if (state.status === 'in-use')
    return row(
      'in-use',
      'Change watch is open in another console',
      'Another local console owns the workspace watch. Inspect its state before changing settings.',
      'Inspect watch',
      'muted',
    );
  if (state.status === 'unavailable')
    return row(
      'unavailable',
      'Change watch state unavailable',
      'Private watch storage, workspace identity or the analysis runtime could not be verified.',
    );
  return [];
}
