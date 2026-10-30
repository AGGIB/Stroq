import {
  validateWorkspaceReviewReceipt,
  validateWorkspaceReviewRun,
  validateWorkspaceReviewState,
  type WorkspaceReviewRun,
  type WorkspaceReviewState,
} from './workspace-review';

export function workspaceReviewRunMatches(
  value: unknown,
  workspaceId: string,
  runId?: string | null,
): value is WorkspaceReviewRun {
  return (
    validateWorkspaceReviewRun(value) &&
    value.workspaceId === workspaceId &&
    (runId == null || value.id === runId)
  );
}
export function workspaceReviewCanRecord(
  run: WorkspaceReviewRun | null,
  state: WorkspaceReviewState | null,
  workspaceId: string | null,
): boolean {
  if (
    !run ||
    !state ||
    !workspaceId ||
    !validateWorkspaceReviewRun(run) ||
    !validateWorkspaceReviewState(state) ||
    state.workspaceId !== workspaceId ||
    !state.engine.available ||
    run.workspaceId !== workspaceId ||
    run.status !== 'completed' ||
    !run.result?.canReview ||
    !run.result.capture.complete ||
    state.history.status !== 'ready' ||
    state.baseline.status === 'invalid' ||
    state.runs.some((value) => value.status === 'running')
  )
    return false;
  const current = state.runs.find((value) => value.id === run.id);
  return (
    current?.status === 'completed' &&
    current.result?.capture.captureSha256 === run.result.capture.captureSha256 &&
    state.baseline.revision === run.result.baseline.revision
  );
}
export function workspaceReviewInput(
  run: WorkspaceReviewRun | null,
  state: WorkspaceReviewState | null,
  workspaceId: string | null,
  acknowledged: boolean,
) {
  return acknowledged && workspaceReviewCanRecord(run, state, workspaceId) && run?.result
    ? {
        runId: run.id,
        expectedCaptureSha256: run.result.capture.captureSha256,
        expectedReviewedRevision: run.result.baseline.revision,
        acknowledgeReviewOnly: true as const,
      }
    : null;
}
export function workspaceReviewReceiptMatches(
  value: unknown,
  run: WorkspaceReviewRun,
  workspaceId: string,
): boolean {
  return (
    validateWorkspaceReviewReceipt(value) &&
    run.status === 'completed' &&
    run.result !== undefined &&
    value.workspaceId === workspaceId &&
    run.workspaceId === workspaceId &&
    value.runId === run.id &&
    value.captureSha256 === run.result.capture.captureSha256 &&
    value.reviewedAt >= run.result.capture.capturedAt &&
    value.reviewedAt >= (run.finishedAt ?? run.startedAt)
  );
}
