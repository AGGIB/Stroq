import type { AgentId } from './agent-status';
import type { HookCheckBinding, HookCheckJob, HookCheckPreview } from './hook-checks';
import { hash } from './local-guards';

export interface HookCheckSelection {
  workspaceId: string;
  agent: AgentId;
  scope: 'project' | 'user';
}

export function hookCheckSelectionKey(
  workspaceId: string | null,
  agent: AgentId,
  scope: 'project' | 'user',
  generation: number,
) {
  if (
    !workspaceId ||
    !/^workspace-[a-f0-9]{24}$/.test(workspaceId) ||
    !['claude-code', 'cursor', 'codex'].includes(agent) ||
    !['project', 'user'].includes(scope) ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return null;
  return `${workspaceId}:${agent}:${scope}:${generation}`;
}

const selectedBinding = (binding: HookCheckBinding, selection: HookCheckSelection) =>
  binding.workspaceId === selection.workspaceId &&
  binding.agent === selection.agent &&
  binding.scope === selection.scope;

export function hookCheckBindingMatches(left: HookCheckBinding, right: HookCheckBinding) {
  return (
    selectedBinding(left, right) &&
    left.sourceSha256 === right.sourceSha256 &&
    left.policySha256 === right.policySha256 &&
    left.policySemanticSha256 === right.policySemanticSha256 &&
    left.runtimeSha256 === right.runtimeSha256
  );
}

export function hookCheckPreviewMatches(preview: HookCheckPreview, selected: HookCheckSelection) {
  return (
    preview.agent === selected.agent &&
    preview.scope === selected.scope &&
    (preview.binding === null ? !preview.canStart : selectedBinding(preview.binding, selected))
  );
}

/** A setup handoff authorizes testing only the bytes acknowledged by that receipt. */
export function hookCheckSourceMatches(preview: HookCheckPreview, expectedSourceSha256?: string) {
  return (
    expectedSourceSha256 === undefined ||
    (hash(expectedSourceSha256) && preview.binding?.sourceSha256 === expectedSourceSha256)
  );
}

export function hookCheckStartInput(preview: HookCheckPreview, now = Date.now()) {
  return preview.canStart &&
    preview.binding !== null &&
    now >= Date.parse(preview.createdAt) &&
    now < Date.parse(preview.expiresAt)
    ? { previewId: preview.id }
    : null;
}

export function hookCheckStartMatches(job: HookCheckJob, preview: HookCheckPreview) {
  return (
    preview.binding !== null &&
    job.previewId === preview.id &&
    Date.parse(job.startedAt) >= Date.parse(preview.createdAt) &&
    hookCheckBindingMatches(job.binding, preview.binding)
  );
}

export function hookCheckJobMatches(job: HookCheckJob, previous: HookCheckJob) {
  return (
    job.id === previous.id &&
    job.previewId === previous.previewId &&
    job.startedAt === previous.startedAt &&
    hookCheckBindingMatches(job.binding, previous.binding)
  );
}

export function scopedHookCheckJobs(jobs: readonly HookCheckJob[], selected: HookCheckSelection) {
  return jobs
    .filter((job) => selectedBinding(job.binding, selected))
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
}
