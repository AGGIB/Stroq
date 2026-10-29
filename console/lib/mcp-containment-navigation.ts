export type McpContainmentFilter = 'all' | 'removed' | 'configured' | 'attention';
const RECORD = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
export interface McpContainmentSelection {
  recordId: string | null;
  workspaceId: string | null;
  requested: boolean;
  invalid: boolean;
  filter: McpContainmentFilter;
}
export function mcpContainmentSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
): McpContainmentSelection {
  const record = params.get('record'),
    workspace = params.get('workspace'),
    view = params.get('view');
  const requested = params.has('record') || params.has('workspace');
  const duplicate = ['record', 'workspace', 'view'].some((key) => params.getAll(key).length > 1);
  const valid =
    !duplicate &&
    record !== null &&
    RECORD.test(record) &&
    workspace !== null &&
    WORKSPACE.test(workspace);
  return {
    recordId: requested && valid ? record : null,
    workspaceId: requested && valid ? workspace : null,
    requested,
    invalid: duplicate || (requested && !valid),
    filter: view === 'removed' || view === 'configured' || view === 'attention' ? view : 'all',
  };
}
export function mcpContainmentHref(
  recordId: string | null,
  workspaceId: string | null,
  filter: McpContainmentFilter = 'all',
) {
  const params = new URLSearchParams();
  if (filter === 'removed' || filter === 'configured' || filter === 'attention')
    params.set('view', filter);
  if (recordId && RECORD.test(recordId) && workspaceId && WORKSPACE.test(workspaceId)) {
    params.set('workspace', workspaceId);
    params.set('record', recordId);
  }
  return '/skills/mcp/' + (params.size ? '?' + params : '');
}
export function mcpContainmentReadAllowed(
  selection: McpContainmentSelection,
  workspaceId: string | null,
) {
  return (
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    !selection.invalid &&
    (!selection.requested || selection.workspaceId === workspaceId)
  );
}
export function resolveMcpContainmentSelection<T extends { id: string }>(
  selection: McpContainmentSelection,
  workspaceId: string | null,
  records: readonly T[] | null,
): {
  status:
    | 'invalid'
    | 'context-pending'
    | 'workspace-mismatch'
    | 'loading'
    | 'missing'
    | 'selected'
    | 'overview';
  record: T | null;
} {
  if (selection.invalid) return { status: 'invalid', record: null };
  if (workspaceId === null) return { status: 'context-pending', record: null };
  if (!mcpContainmentReadAllowed(selection, workspaceId))
    return { status: 'workspace-mismatch', record: null };
  if (records === null) return { status: 'loading', record: null };
  if (!selection.requested) return { status: 'overview', record: null };
  const record = records.find((item) => item.id === selection.recordId) ?? null;
  return { status: record ? 'selected' : 'missing', record };
}
