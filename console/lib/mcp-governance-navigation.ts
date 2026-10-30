const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const CONTEXT = /^governance-context-[a-f0-9]{64}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
export interface McpGovernanceLocation {
  open: boolean;
  invalid: boolean;
  view: 'capture' | 'history';
  draft: 'deny-all' | null;
  contextId: string | null;
  operationId: string | null;
  workspaceId: string | null;
}
export function mcpGovernanceLocation(
  p: Pick<URLSearchParams, 'get' | 'getAll'>,
): McpGovernanceLocation {
  const mode = p.get('mcpGovernance'),
    contextId = p.get('governanceContext'),
    operationId = p.get('governanceOperation'),
    workspaceId = p.get('governanceWorkspace'),
    draft = p.get('governanceDraft');
  const empty = {
    open: false,
    invalid: false,
    view: 'capture' as const,
    draft: null,
    contextId: null,
    operationId: null,
    workspaceId: null,
  };
  if (mode === null) return draft !== null ? { ...empty, open: true, invalid: true } : empty;
  if (
    !['capture', 'history'].includes(mode) ||
    [
      'mcpGovernance',
      'governanceContext',
      'governanceOperation',
      'governanceWorkspace',
      'governanceDraft',
    ].some((k) => p.getAll(k).length > 1) ||
    (draft !== null && (draft !== 'deny-all' || mode !== 'capture')) ||
    (contextId !== null && !CONTEXT.test(contextId)) ||
    (workspaceId !== null && !WORKSPACE.test(workspaceId)) ||
    (operationId !== null &&
      (!UUID.test(operationId) || !contextId || !workspaceId || mode !== 'history'))
  )
    return { ...empty, open: true, invalid: true };
  return {
    open: true,
    invalid: false,
    view: mode as 'capture' | 'history',
    draft: draft as 'deny-all' | null,
    contextId,
    operationId,
    workspaceId,
  };
}
export function mcpGovernanceHref(
  options: {
    view?: 'capture' | 'history';
    draft?: 'deny-all';
    contextId?: string;
    operationId?: string;
    workspaceId?: string;
  } = {},
) {
  const q = new URLSearchParams({
    kind: 'mcp',
    mcpGovernance: options.operationId ? 'history' : (options.view ?? 'capture'),
  });
  if (options.draft) q.set('governanceDraft', options.draft);
  if (options.contextId) q.set('governanceContext', options.contextId);
  if (options.operationId) q.set('governanceOperation', options.operationId);
  if (options.workspaceId) q.set('governanceWorkspace', options.workspaceId);
  return mcpGovernanceLocation(q).invalid
    ? '/skills/?kind=mcp&mcpGovernance=capture'
    : `/skills/?${q}`;
}
