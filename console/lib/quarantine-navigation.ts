export type QuarantineFilter = 'all' | 'quarantined' | 'attention';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
export function quarantineSelection(params: Pick<URLSearchParams, 'get' | 'has'>) {
  const record = params.get('record'),
    workspace = params.get('workspace'),
    filter = params.get('view');
  const requested = params.has('record');
  const valid =
    record !== null && UUID.test(record) && workspace !== null && WORKSPACE.test(workspace);
  return {
    recordId: requested && valid ? record : null,
    workspaceId: requested && valid ? workspace : null,
    invalid: requested && !valid,
    filter: (filter === 'quarantined' || filter === 'attention'
      ? filter
      : 'all') as QuarantineFilter,
  };
}
export function quarantineHref(
  recordId: string | null,
  workspaceId: string | null,
  filter: QuarantineFilter = 'all',
) {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('view', filter);
  if (recordId && UUID.test(recordId) && workspaceId && WORKSPACE.test(workspaceId)) {
    params.set('workspace', workspaceId);
    params.set('record', recordId);
  }
  return '/skills/quarantine/' + (params.size ? '?' + params : '');
}
