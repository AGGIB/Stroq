const uuid = (v: string | null): v is string =>
  !!v && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const context = (v: string | null): v is string => !!v && /^codex-context-[a-f0-9]{64}$/.test(v);
const workspace = (v: string | null): v is string => !!v && /^workspace-[a-f0-9]{24}$/.test(v);
export interface CodexNetworkLocation {
  open: boolean;
  invalid: boolean;
  view: 'default' | 'history';
  controlContextId: string | null;
  recordId: string | null;
  jobId: string | null;
  workspaceId: string | null;
}
export function codexNetworkLocation(
  params: Pick<URLSearchParams, 'get' | 'getAll'>,
): CodexNetworkLocation {
  const value = params.get('codexNetwork'),
    ctx = params.get('context'),
    recordId = params.get('record'),
    jobId = params.get('check'),
    ws = params.get('networkWorkspace');
  const empty = {
    open: false,
    invalid: false,
    view: 'default' as const,
    controlContextId: null,
    recordId: null,
    jobId: null,
    workspaceId: null,
  };
  if (value === null) return empty;
  const invalid =
    !['default', 'history'].includes(value) ||
    ['codexNetwork', 'context', 'record', 'check', 'networkWorkspace'].some(
      (k) => params.getAll(k).length > 1,
    ) ||
    (ctx !== null && !context(ctx)) ||
    (recordId !== null &&
      (!uuid(recordId) || !context(ctx) || jobId !== null || value !== 'history' || ws !== null)) ||
    (jobId !== null && (!uuid(jobId) || !context(ctx) || !workspace(ws) || value !== 'history')) ||
    (ws !== null && jobId === null);
  return invalid
    ? { ...empty, open: true, invalid: true }
    : {
        open: true,
        invalid: false,
        view: value as 'default' | 'history',
        controlContextId: ctx,
        recordId,
        jobId,
        workspaceId: ws,
      };
}
export function codexNetworkHref(
  options: {
    view?: 'default' | 'history';
    controlContextId?: string;
    recordId?: string;
    jobId?: string;
    workspaceId?: string;
  } = {},
) {
  const query = new URLSearchParams({
    codexNetwork: options.recordId || options.jobId ? 'history' : (options.view ?? 'default'),
  });
  if (options.controlContextId) query.set('context', options.controlContextId);
  if (options.recordId) query.set('record', options.recordId);
  if (options.jobId) query.set('check', options.jobId);
  if (options.workspaceId) query.set('networkWorkspace', options.workspaceId);
  return codexNetworkLocation(query).invalid
    ? '/agents/?codexNetwork=default'
    : `/agents/?${query}`;
}
