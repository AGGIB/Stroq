const JOB = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;

export interface SecretSelection {
  jobId: string | null;
  workspaceId: string | null;
  requested: boolean;
  invalid: boolean;
}

export function secretSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): SecretSelection {
  const job = params.get('job'),
    workspace = params.get('workspace');
  const requested = params.has('job') || params.has('workspace');
  const valid =
    job !== null &&
    JOB.test(job) &&
    workspace !== null &&
    WORKSPACE.test(workspace) &&
    params.getAll('job').length === 1 &&
    params.getAll('workspace').length === 1;
  return {
    jobId: requested && valid ? job : null,
    workspaceId: requested && valid ? workspace : null,
    requested,
    invalid: requested && !valid,
  };
}

export function secretHref(jobId: string | null, workspaceId: string | null) {
  const params = new URLSearchParams();
  if (jobId && JOB.test(jobId) && workspaceId && WORKSPACE.test(workspaceId)) {
    params.set('workspace', workspaceId);
    params.set('job', jobId);
  }
  return '/keys/' + (params.size ? '?' + params : '');
}

export function secretContextMatches(selection: SecretSelection, workspaceId: string | null) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}

export function resolveSecretSelection<T extends { id: string; startedAt: string }>(
  selection: SecretSelection,
  workspaceId: string | null,
  jobs: readonly T[] | null,
): {
  status:
    | 'invalid'
    | 'context-pending'
    | 'workspace-mismatch'
    | 'loading'
    | 'missing'
    | 'selected'
    | 'empty';
  job: T | null;
} {
  if (selection.invalid) return { status: 'invalid', job: null };
  if (workspaceId === null) return { status: 'context-pending', job: null };
  if (!secretContextMatches(selection, workspaceId))
    return { status: 'workspace-mismatch', job: null };
  if (jobs === null) return { status: 'loading', job: null };
  const job = selection.requested
    ? jobs.find((item) => item.id === selection.jobId)
    : [...jobs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  return { status: job ? 'selected' : selection.requested ? 'missing' : 'empty', job: job ?? null };
}
