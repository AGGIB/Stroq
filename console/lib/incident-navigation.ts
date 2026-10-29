export type IncidentFilter = 'open' | 'reviewed' | 'all';
const ID = /^incident-[a-f0-9]{64}$/;
export function incidentSelection(params: Pick<URLSearchParams, 'get' | 'has'>) {
  const status = params.get('status');
  const id = params.get('id');
  return {
    filter: status === 'reviewed' || status === 'all' ? status : ('open' as IncidentFilter),
    id: id !== null && ID.test(id) ? id : null,
    invalid: params.has('id') && (id === null || !ID.test(id)),
  };
}
export function incidentHref(id: string | null, filter: IncidentFilter = 'open') {
  const params = new URLSearchParams();
  if (filter !== 'open') params.set('status', filter);
  if (id !== null && ID.test(id)) params.set('id', id);
  return `/incidents/${params.size ? `?${params}` : ''}`;
}
