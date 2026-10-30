import type { InventoryItem } from './inventory';

export type InventoryFilter = 'all' | 'skill' | 'mcp';
export type InventoryView = 'all' | 'signals' | 'changes' | 'unreviewed' | 'incomplete';
const VIEWS: InventoryView[] = ['all', 'signals', 'changes', 'unreviewed', 'incomplete'];
export function inventoryViewMatches(
  item: Pick<InventoryItem, 'state' | 'scan'>,
  view: InventoryView,
) {
  if (view === 'signals') return item.scan.status === 'suspect';
  if (view === 'changes') return item.state === 'changed' || item.state === 'missing';
  if (view === 'unreviewed') return item.state === 'unreviewed';
  if (view === 'incomplete')
    return item.state === 'unverifiable' || item.scan.status === 'incomplete';
  return true;
}
const ITEM = /^item-[a-f0-9]{24}$/;
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
export function inventorySelection(params: Pick<URLSearchParams, 'get' | 'has'>) {
  const item = params.get('item'),
    workspace = params.get('workspace'),
    sha = params.get('sha');
  const kind = params.get('kind');
  const view = params.get('view');
  const requested = params.has('item');
  const valid =
    item !== null &&
    ITEM.test(item) &&
    workspace !== null &&
    WORKSPACE.test(workspace) &&
    (sha === null || SHA.test(sha));
  return {
    id: requested && valid ? item : null,
    workspaceId: requested && valid ? workspace : null,
    sha256: requested && valid ? sha : null,
    invalid: requested && !valid,
    kind: kind === 'skill' || kind === 'mcp' ? kind : ('all' as InventoryFilter),
    view: VIEWS.includes(view as InventoryView) ? (view as InventoryView) : 'all',
  };
}
export function inventoryHref(
  id: string | null,
  workspaceId: string | null,
  sha256: string | null,
  kind: InventoryFilter = 'all',
  view: InventoryView = 'all',
) {
  const params = new URLSearchParams();
  if (kind !== 'all') params.set('kind', kind);
  if (view !== 'all' && VIEWS.includes(view)) params.set('view', view);
  if (
    id !== null &&
    ITEM.test(id) &&
    workspaceId !== null &&
    WORKSPACE.test(workspaceId) &&
    (sha256 === null || SHA.test(sha256))
  ) {
    params.set('workspace', workspaceId);
    params.set('item', id);
    if (sha256 !== null) params.set('sha', sha256);
  }
  return `/skills/${params.size ? `?${params}` : ''}`;
}
