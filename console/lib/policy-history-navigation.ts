const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
export interface PolicyHistorySelection {
  requested: boolean;
  invalid: boolean;
  entryId: string | null;
}
export function policyHistorySelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): PolicyHistorySelection {
  const requested = params.has('entry') || params.has('workspace'),
    entryId = params.get('entry');
  const valid =
    requested &&
    !params.has('workspace') &&
    params.getAll('entry').length === 1 &&
    entryId !== null &&
    UUID.test(entryId);
  return { requested, invalid: requested && !valid, entryId: valid ? entryId : null };
}
export function policyHistoryHref(entryId: string | null = null) {
  return entryId && UUID.test(entryId)
    ? `/policies/history/?${new URLSearchParams({ entry: entryId })}`
    : '/policies/history/';
}
export function policyHistoryReadAllowed(
  selection: PolicyHistorySelection,
  workspaceId: string | null,
) {
  return !selection.invalid && workspaceId !== null && WORKSPACE.test(workspaceId);
}
