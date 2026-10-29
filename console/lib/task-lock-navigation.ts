const TASK = /^task-[a-f0-9]{64}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
const INCIDENT = /^incident-[a-f0-9]{64}$/;
export interface TaskLockSelection {
  requested: boolean;
  invalid: boolean;
  taskId: string | null;
  workspaceId: string | null;
  expectedPermitSha256: string | null;
  originIncidentId: string | null;
}
export function taskLockSelection(
  params: Pick<URLSearchParams, 'has' | 'get' | 'getAll'>,
): TaskLockSelection {
  const fields = ['task', 'workspace', 'permit', 'incident'];
  const requested = fields.some((key) => params.has(key));
  const task = params.get('task'),
    workspace = params.get('workspace'),
    permit = params.get('permit'),
    incident = params.get('incident');
  const valid =
    requested &&
    ['task', 'workspace'].every((key) => params.getAll(key).length === 1) &&
    fields.every((key) => params.getAll(key).length <= 1) &&
    task !== null &&
    TASK.test(task) &&
    workspace !== null &&
    WORKSPACE.test(workspace) &&
    (permit === null || SHA.test(permit)) &&
    (incident === null || (INCIDENT.test(incident) && permit !== null));
  return {
    requested,
    invalid: requested && !valid,
    taskId: valid ? task : null,
    workspaceId: valid ? workspace : null,
    expectedPermitSha256: valid ? permit : null,
    originIncidentId: valid ? incident : null,
  };
}
export function taskLockHref(
  taskId: string | null = null,
  workspaceId: string | null = null,
  origin: { permitSha256?: string | null; incidentId?: string | null } = {},
) {
  if (
    !taskId ||
    !TASK.test(taskId) ||
    !workspaceId ||
    !WORKSPACE.test(workspaceId) ||
    (origin.permitSha256 != null && !SHA.test(origin.permitSha256)) ||
    (origin.incidentId != null && (!INCIDENT.test(origin.incidentId) || !origin.permitSha256))
  )
    return '/agents/tasks/';
  const params = new URLSearchParams({ workspace: workspaceId, task: taskId });
  if (origin.permitSha256) params.set('permit', origin.permitSha256);
  if (origin.incidentId) params.set('incident', origin.incidentId);
  return `/agents/tasks/?${params}`;
}
export function taskLockReadAllowed(selection: TaskLockSelection, workspaceId: string | null) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}
