import { WORKSPACE_REVIEW_ERRORS, type WorkspaceReviewError } from './workspace-review';
export const WORKSPACE_REVIEW_ERROR_MESSAGES: Record<WorkspaceReviewError, string> = {
  'runtime-unavailable': 'The local analysis runtime is unavailable.',
  'context-unavailable': 'The selected workspace is unavailable.',
  'platform-unsupported': 'Workspace checks are unavailable on this platform.',
  'workspace-review-busy': 'A workspace check is already running.',
  'history-unavailable': 'Saved workspace checks could not be verified.',
  'baseline-unavailable': 'The reviewed baseline could not be verified.',
  'stale-capture':
    'The captured sources changed. Check the workspace again before recording review.',
  'stale-baseline':
    'The reviewed baseline changed. Check the workspace again before recording review.',
  'incomplete-capture': 'This incomplete capture cannot become the reviewed baseline.',
  'deadline-exceeded': 'The workspace check reached its time limit.',
  'output-limit': 'The workspace check reached its output limit.',
  'invalid-report': 'No verifiable workspace report was returned.',
  'server-stopped': 'The local server stopped before the check finished.',
  cancelled: 'The workspace check was cancelled.',
  'write-unconfirmed': 'Review completion is unknown. Recheck saved reports before another action.',
  'workspace-review-failed': 'The workspace check did not finish.',
};
export function workspaceReviewError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const code = WORKSPACE_REVIEW_ERRORS.find(
    (value) => value === error.message || WORKSPACE_REVIEW_ERROR_MESSAGES[value] === error.message,
  );
  return code ? WORKSPACE_REVIEW_ERROR_MESSAGES[code] : fallback;
}
