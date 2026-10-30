import { PROTECTION_STEPS, type ProtectionStepId } from './protection-check';
import {
  workspaceReviewReadAllowed,
  workspaceReviewSelection,
  type WorkspaceReviewSelection,
} from './workspace-review-navigation';
export const protectionRunSelection = workspaceReviewSelection;
export const protectionRunReadAllowed = workspaceReviewReadAllowed;
export type ProtectionRunSelection = WorkspaceReviewSelection;
export function protectionStageTarget(hash: string): string | null {
  return PROTECTION_STEPS.some((step) => hash === `#protection-check-${step}`)
    ? hash.slice(1)
    : null;
}
export function protectionRunHref(
  runId: string | null = null,
  workspaceId: string | null = null,
  step?: ProtectionStepId,
) {
  const selection = protectionRunSelection(
    new URLSearchParams({ run: runId ?? '', workspace: workspaceId ?? '' }),
  );
  return selection.invalid
    ? '/protection/'
    : `/protection/?${new URLSearchParams({ workspace: workspaceId!, run: runId! })}${step ? `#protection-check-${step}` : '#protection-check'}`;
}
