import type { ToolCall } from './data';
import { incidentHref } from './incident-navigation';

const SHA = /^[a-f0-9]{64}$/;
const journalId = (id: string) => {
  const match = /^audit-([1-9]\d*)$/.exec(id);
  return match !== null && Number.isSafeInteger(Number(match[1]));
};
const bound = (call: ToolCall) =>
  journalId(call.id) && typeof call.evidenceSha === 'string' && SHA.test(call.evidenceSha);

/** Legacy IDs remain readable; new journal links select their captured version. */
export function activityEventHref(call: ToolCall) {
  const params = new URLSearchParams({ id: call.id });
  if (bound(call)) params.set('evidence', call.evidenceSha!);
  return `/activity/event/?${params}`;
}

export type ActivityBinding = 'exact' | 'current-window' | 'demo';
export interface ActivitySelection {
  call: ToolCall | null;
  binding: ActivityBinding | null;
  error: 'invalid' | 'stale' | 'missing' | null;
}
export function activityEventSelection(
  params: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>,
  calls: readonly ToolCall[],
  source: 'local' | 'demo',
): ActivitySelection {
  const evidence = params.get('evidence');
  if (
    params.getAll('id').length > 1 ||
    params.getAll('evidence').length > 1 ||
    (params.has('evidence') && (source !== 'local' || evidence === null || !SHA.test(evidence)))
  )
    return { call: null, binding: null, error: 'invalid' };
  const call = calls.find((item) => item.id === params.get('id')) ?? null;
  if (!call) return { call: null, binding: null, error: 'missing' };
  if (evidence !== null && (!bound(call) || call.evidenceSha !== evidence))
    return { call: null, binding: null, error: 'stale' };
  return {
    call,
    binding: source === 'demo' ? 'demo' : evidence !== null ? 'exact' : 'current-window',
    error: null,
  };
}

/** The destination reselects this exact finding; navigation grants no authority. */
export function activityFindingHref(call: ToolCall, source: 'local' | 'demo') {
  return source === 'local' && bound(call) && ['block', 'ask', 'flag'].includes(call.decision)
    ? incidentHref(`incident-${call.evidenceSha}`, 'all')
    : null;
}
