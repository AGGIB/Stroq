const uuid = (v: string | null): v is string =>
  !!v && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const context = (v: string | null): v is string => !!v && /^codex-context-[a-f0-9]{64}$/.test(v);
export interface CodexPathGuardLocation {
  open: boolean;
  invalid: boolean;
  view: 'paths' | 'history';
  controlContextId: string | null;
  recordId: string | null;
}
export function codexPathGuardLocation(
  params: Pick<URLSearchParams, 'get' | 'getAll'>,
): CodexPathGuardLocation {
  const view = params.get('codexPaths'),
    ctx = params.get('pathContext'),
    record = params.get('pathRecord');
  const empty = {
    open: false,
    invalid: false,
    view: 'paths' as const,
    controlContextId: null,
    recordId: null,
  };
  if (view === null) return empty;
  if (
    !['paths', 'history'].includes(view) ||
    ['codexPaths', 'pathContext', 'pathRecord'].some((k) => params.getAll(k).length > 1) ||
    (ctx !== null && !context(ctx)) ||
    (record !== null && (!uuid(record) || !context(ctx) || view !== 'history'))
  )
    return { ...empty, open: true, invalid: true };
  return {
    open: true,
    invalid: false,
    view: view as 'paths' | 'history',
    controlContextId: ctx,
    recordId: record,
  };
}
export function codexPathGuardHref(
  options: { view?: 'paths' | 'history'; controlContextId?: string; recordId?: string } = {},
) {
  const query = new URLSearchParams({
    codexPaths: options.recordId ? 'history' : (options.view ?? 'paths'),
  });
  if (options.controlContextId) query.set('pathContext', options.controlContextId);
  if (options.recordId) query.set('pathRecord', options.recordId);
  return codexPathGuardLocation(query).invalid ? '/agents/?codexPaths=paths' : `/agents/?${query}`;
}
