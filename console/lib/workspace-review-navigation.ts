const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export interface WorkspaceReviewSelection {
  requested: boolean;
  invalid: boolean;
  workspaceId: string | null;
  runId: string | null;
}
export function workspaceReviewSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): WorkspaceReviewSelection {
  const run = params.get('run'),
    workspace = params.get('workspace'),
    requested = params.has('run') || params.has('workspace');
  const valid =
    requested &&
    params.getAll('run').length === 1 &&
    params.getAll('workspace').length === 1 &&
    run !== null &&
    UUID.test(run) &&
    workspace !== null &&
    WORKSPACE.test(workspace);
  return {
    requested,
    invalid: requested && !valid,
    workspaceId: valid ? workspace : null,
    runId: valid ? run : null,
  };
}
export function workspaceReviewHref(
  runId: string | null = null,
  workspaceId: string | null = null,
) {
  return runId && UUID.test(runId) && workspaceId && WORKSPACE.test(workspaceId)
    ? `/protection/workspace/?${new URLSearchParams({ workspace: workspaceId, run: runId })}`
    : '/protection/workspace/';
}
export function workspaceReviewReadAllowed(
  selection: WorkspaceReviewSelection,
  workspaceId: string | null,
) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}
