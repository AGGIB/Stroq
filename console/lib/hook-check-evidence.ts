import type { AgentId } from './agent-status';
import {
  validateHookCheckState,
  type HookCheckJob,
  type HookCheckScope,
  type HookCheckState,
} from './hook-checks';

export interface HookCheckEvidence {
  status:
    | 'unavailable'
    | 'not-checked'
    | 'running'
    | 'passed'
    | 'attention'
    | 'mismatch'
    | 'failed'
    | 'cancelled';
  label: string;
  tone: 'muted' | 'orange' | 'red';
  recordedAt: string | null;
  job: HookCheckJob | null;
}

function unavailable(label = 'History unavailable'): HookCheckEvidence {
  return { status: 'unavailable', label, tone: 'orange', recordedAt: null, job: null };
}

function outcome(job: HookCheckJob): HookCheckEvidence['status'] {
  if (job.status !== 'completed') return job.status;
  return job.result!.status === 'failed' ? 'mismatch' : job.result!.status;
}

// Equal start timestamps cannot prove an order. Keep unresolved/adverse evidence
// ahead of a pass rather than allowing array order to choose the reassuring result.
const tiePriority: Record<HookCheckEvidence['status'], number> = {
  unavailable: 0,
  'not-checked': 0,
  running: 1,
  mismatch: 2,
  failed: 3,
  cancelled: 4,
  attention: 5,
  passed: 6,
};
const labels: Partial<Record<HookCheckEvidence['status'], string>> = {
  running: 'Check running',
  passed: 'Recorded pass',
  attention: 'Recorded attention',
  mismatch: 'Recorded mismatch',
  failed: 'Check incomplete',
  cancelled: 'Check cancelled',
};

/** Recorded isolated-hook evidence only; it never establishes current/native enforcement. */
export function hookCheckEvidence(
  state: HookCheckState | null,
  workspaceId: string | null,
  agent: AgentId,
  scope: HookCheckScope,
): HookCheckEvidence {
  if (
    !workspaceId ||
    !validateHookCheckState(state) ||
    state.workspaceId !== workspaceId ||
    !state.agents.some((item) => item.id === agent) ||
    !['project', 'user'].includes(scope)
  )
    return unavailable();
  if (state.history.status !== 'ready')
    return unavailable(state.history.status === 'disabled' ? 'History disabled' : undefined);

  const job = state.jobs
    .filter(
      (item) =>
        item.binding.workspaceId === workspaceId &&
        item.binding.agent === agent &&
        item.binding.scope === scope,
    )
    .toSorted(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        tiePriority[outcome(left)] - tiePriority[outcome(right)] ||
        right.id.localeCompare(left.id),
    )[0];
  if (!job) {
    if (!state.agents.find((item) => item.id === agent)?.supported)
      return unavailable('Platform unsupported');
    if (!state.engine.available) return unavailable('Check engine unavailable');
    return {
      status: 'not-checked',
      label: 'Not checked',
      tone: 'muted',
      recordedAt: null,
      job: null,
    };
  }
  const status = outcome(job);
  return {
    status,
    label: labels[status]!,
    tone:
      status === 'mismatch'
        ? 'red'
        : status === 'passed' || status === 'running'
          ? 'muted'
          : 'orange',
    recordedAt: job.finishedAt ?? job.startedAt,
    job,
  };
}
