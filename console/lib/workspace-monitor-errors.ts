import { WORKSPACE_REVIEW_ERROR_MESSAGES } from './workspace-review-errors';
export const WORKSPACE_MONITOR_ERROR_MESSAGES: Record<string, string> = {
  ...WORKSPACE_REVIEW_ERROR_MESSAGES,
  'monitor-store-invalid':
    'Saved watch settings could not be verified. Existing settings were preserved.',
  'monitor-store-unavailable':
    'Local watch settings are unavailable. Refresh before another action.',
  'monitor-store-stale': 'Watch settings changed. Refresh and review a new preview.',
  'monitor-store-limit':
    'The local watch settings limit was reached. Existing settings were preserved.',
  'monitor-store-write-unconfirmed':
    'Watch completion is unknown. Refresh saved state before another action.',
  'monitor-in-use':
    'Another local console owns this watch. Pause there or restart after it closes.',
  'monitor-preview-expired':
    'This preview expired or was already used. Refresh and prepare it again.',
};
