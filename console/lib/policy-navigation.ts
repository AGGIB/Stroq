import { incidentHref } from './incident-navigation';

const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const INCIDENT = /^incident-[a-f0-9]{64}$/;

export interface PolicyLocationSelection {
  requested: boolean;
  invalid: boolean;
  incidentId: string | null;
  workspaceId: string | null;
}

export function policySelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): PolicyLocationSelection {
  const requested = params.has('workspace') || params.has('incident');
  const workspaceId = params.get('workspace');
  const incidentId = params.get('incident');
  const valid =
    requested &&
    params.getAll('workspace').length === 1 &&
    params.getAll('incident').length === 1 &&
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    incidentId !== null &&
    INCIDENT.test(incidentId);
  return {
    requested,
    invalid: requested && !valid,
    workspaceId: valid ? workspaceId : null,
    incidentId: valid ? incidentId : null,
  };
}

export function policyEventHref(incidentId: string | null, workspaceId: string | null) {
  if (
    incidentId === null ||
    !INCIDENT.test(incidentId) ||
    workspaceId === null ||
    !WORKSPACE.test(workspaceId)
  )
    return '/policies/';
  const params = new URLSearchParams({ workspace: workspaceId, incident: incidentId });
  return `/policies/?${params}`;
}

export function policyReadAllowed(selection: PolicyLocationSelection, workspaceId: string | null) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}

export function policyEventReturnHref(selection: PolicyLocationSelection) {
  return incidentHref(selection.invalid ? null : selection.incidentId, 'all');
}
