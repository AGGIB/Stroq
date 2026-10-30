import {
  CREDENTIAL_FILTER_TARGETS,
  type CredentialFilterTarget,
  type CredentialFilterRow,
  type CredentialFiltersState,
} from './credential-filters';
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const isTarget = (value: string | null): value is CredentialFilterTarget =>
  value !== null && Object.hasOwn(CREDENTIAL_FILTER_TARGETS, value);
export interface CredentialFilterLocationSelection {
  requested: boolean;
  invalid: boolean;
  target: CredentialFilterTarget | null;
  agent: 'claude-code' | 'cursor' | null;
  scope: 'project' | 'user';
  workspaceId: string | null;
}
export function credentialFilterSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): CredentialFilterLocationSelection {
  const target = params.get('filter'),
    workspace = params.get('workspace'),
    scope = params.get('scope');
  const requested = params.has('filter') || params.has('workspace');
  const duplicate = ['filter', 'workspace', 'scope'].some((key) => params.getAll(key).length > 1);
  const exact =
    requested &&
    !duplicate &&
    isTarget(target) &&
    workspace !== null &&
    WORKSPACE.test(workspace) &&
    !params.has('scope');
  const overview =
    !requested && !duplicate && (scope === null || scope === 'project' || scope === 'user');
  const fixed = exact ? CREDENTIAL_FILTER_TARGETS[target] : null;
  return {
    requested,
    invalid: !exact && !overview,
    target: exact ? target : null,
    agent: fixed?.agent ?? null,
    scope: fixed?.scope ?? (overview && scope === 'user' ? 'user' : 'project'),
    workspaceId: exact ? workspace : null,
  };
}
export function credentialFilterHref(
  target: CredentialFilterTarget | null,
  workspaceId: string | null,
  scope: 'project' | 'user' = 'project',
) {
  if (target === null) return scope === 'user' ? '/agents/?scope=user' : '/agents/';
  if (!isTarget(target) || workspaceId === null || !WORKSPACE.test(workspaceId)) return '/agents/';
  const params = new URLSearchParams({ workspace: workspaceId, filter: target });
  return `/agents/?${params}#${CREDENTIAL_FILTER_TARGETS[target].agent}`;
}
export function credentialFilterReadAllowed(
  selection: CredentialFilterLocationSelection,
  workspaceId: string | null,
) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}
export function resolveCredentialFilterSelection(
  selection: CredentialFilterLocationSelection,
  workspaceId: string | null,
  state: CredentialFiltersState | null,
): {
  status:
    | 'invalid'
    | 'context-pending'
    | 'workspace-mismatch'
    | 'loading'
    | 'missing'
    | 'selected'
    | 'overview';
  row: CredentialFilterRow | null;
} {
  if (selection.invalid) return { status: 'invalid', row: null };
  if (workspaceId === null) return { status: 'context-pending', row: null };
  if (!credentialFilterReadAllowed(selection, workspaceId))
    return { status: 'workspace-mismatch', row: null };
  if (!selection.requested) return { status: 'overview', row: null };
  if (!state || state.workspaceId !== workspaceId) return { status: 'loading', row: null };
  const row = state.targets.find((value) => value.id === selection.target) ?? null;
  return { status: row ? 'selected' : 'missing', row };
}
