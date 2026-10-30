import type { LiveAgent, LiveJob, LiveState } from './live-proof';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const AGENTS = new Set(['claude-code', 'codex', 'cursor']);
export interface LiveSelection {
  requested: boolean;
  invalid: boolean;
  jobId: string | null;
  agent: LiveAgent | null;
  workspaceId: string | null;
}

export function liveSelection(
  params: Pick<URLSearchParams, 'get' | 'has' | 'getAll'>,
): LiveSelection {
  const job = params.get('job'),
    agent = params.get('agent'),
    workspace = params.get('workspace');
  const requested = ['job', 'agent', 'workspace'].some((key) => params.has(key));
  const duplicate = ['job', 'agent', 'workspace'].some((key) => params.getAll(key).length > 1);
  const valid =
    !duplicate &&
    workspace !== null &&
    WORKSPACE.test(workspace) &&
    ((job !== null && UUID.test(job) && !params.has('agent')) ||
      (agent !== null && AGENTS.has(agent) && !params.has('job')));
  return {
    requested,
    invalid: requested && !valid,
    jobId: valid ? job : null,
    agent: valid ? (agent as LiveAgent | null) : null,
    workspaceId: valid ? workspace : null,
  };
}

export function liveHref({
  jobId,
  agent,
  workspaceId,
}: {
  jobId?: string | null;
  agent?: LiveAgent | null;
  workspaceId?: string | null;
} = {}) {
  const base = '/agents/checks/';
  if (!workspaceId || !WORKSPACE.test(workspaceId) || Boolean(jobId) === Boolean(agent))
    return base;
  const params = new URLSearchParams({ workspace: workspaceId });
  if (jobId && UUID.test(jobId)) params.set('job', jobId);
  else if (agent && AGENTS.has(agent)) params.set('agent', agent);
  else return base;
  return base + '?' + params;
}

export function liveReadAllowed(selection: LiveSelection, workspaceId: string | null): boolean {
  return (
    workspaceId !== null &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}

type LiveResolution =
  | {
      kind:
        | 'invalid'
        | 'workspace-mismatch'
        | 'disconnected'
        | 'loading'
        | 'overview'
        | 'missing-job'
        | 'missing-proof';
    }
  | { kind: 'job'; job: LiveJob }
  | { kind: 'proof'; agent: LiveAgent; proof: NonNullable<LiveState['agents'][number]['proof']> };

/** Exact links never resolve to another attempt, including after server eviction/restart. */
export function resolveLiveSelection(
  selection: LiveSelection,
  state: LiveState | null,
  workspaceId: string | null,
): LiveResolution {
  if (selection.invalid) return { kind: 'invalid' };
  if (!workspaceId) return { kind: 'disconnected' };
  if (selection.requested && selection.workspaceId !== workspaceId)
    return { kind: 'workspace-mismatch' };
  if (!state) return { kind: 'loading' };
  if (selection.jobId) {
    const job = state.jobs.find((item) => item.id === selection.jobId);
    return job ? { kind: 'job', job } : { kind: 'missing-job' };
  }
  if (selection.agent) {
    const proof = state.agents.find((item) => item.id === selection.agent)?.proof;
    return proof ? { kind: 'proof', agent: selection.agent, proof } : { kind: 'missing-proof' };
  }
  return { kind: 'overview' };
}
