import {
  validateInventoryItem,
  INVENTORY_AGENTS,
  type InventoryItem,
  type InventoryState,
} from './inventory';
import { inventoryHref } from './inventory-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';
import { SKILL_SOURCES, skillSourceOf } from './skill-sources';

/** Current means the last accepted read, never continuous monitoring or client adoption. */
export type InventoryFreshness = 'current' | 'historical' | 'unavailable';
export const INVENTORY_ATTENTION_LIMIT = 6;
const coverageHref = '/skills/?view=incomplete#inventory-coverage';
const incomplete = (item: InventoryItem) =>
  item.state === 'unverifiable' || item.scan.status === 'incomplete';
const suspect = (item: InventoryItem) => item.scan.status === 'suspect';
function sourceLabel(item: Pick<InventoryItem, 'kind' | 'agent' | 'scope' | 'skillSource'>) {
  const source = skillSourceOf(item);
  const label = source
    ? item.scope === 'project'
      ? SKILL_SOURCES[source].projectLabel
      : SKILL_SOURCES[source].userLabel
    : (INVENTORY_AGENTS[item.agent] ?? 'Source unavailable');
  return `${label} · ${item.scope === 'project' ? 'Workspace' : 'User'}`;
}
function captureLabel(state: InventoryState, freshness: InventoryFreshness) {
  return `${freshness === 'current' ? 'Captured' : 'Historical capture'} ${state.generatedAt}.`;
}
function exactRow(
  item: InventoryItem,
  state: InventoryState,
  freshness: InventoryFreshness,
): ProtectionEvidenceRow {
  const signals = suspect(item),
    context = sourceLabel(item);
  return {
    key: `inventory-item:${item.id}`,
    title: `${signals ? 'Matched signals' : 'Inspection incomplete'}: ${item.name}`,
    context,
    detail: `${context}. ${captureLabel(state, freshness)} ${
      signals
        ? `${item.scan.findings} static matched signals remain independent of the recorded review. This is not observed execution or a safety verdict.`
        : 'The selected capture could not establish complete evidence. It is not a clean result or a confirmed attack.'
    }${incomplete(item) && signals ? ' Capture completeness is also unavailable.' : ''}`,
    href: inventoryHref(
      item.id,
      state.workspace.id,
      item.sha256,
      item.kind,
      signals ? 'signals' : 'incomplete',
    ),
    action: signals ? 'Inspect signals' : 'Inspect gap',
    tone: 'orange',
  };
}
function coverageRows(
  state: InventoryState,
  freshness: InventoryFreshness,
): ProtectionEvidenceRow[] {
  const rows: ProtectionEvidenceRow[] = [],
    captured = captureLabel(state, freshness);
  if (state.baseline.status === 'invalid')
    rows.push({
      key: 'inventory-baseline',
      title: 'Artifact review baseline unavailable',
      detail: `${captured} Stored review evidence could not be validated. No empty or clean baseline was substituted.`,
      href: coverageHref,
      action: 'Inspect baseline',
      tone: 'orange',
    });
  if (state.signalDecisions?.status === 'unavailable')
    rows.push({
      key: 'inventory-signal-store',
      title: 'Skill signal decisions unavailable',
      detail: `${captured} Local signal assessments could not be validated. Matching signals remain in attention.`,
      href: coverageHref,
      action: 'Inspect coverage',
      tone: 'orange',
    });
  const sources = new Set<string>();
  for (const entry of state.skillSources ?? [])
    if (entry.status === 'partial') {
      const source = SKILL_SOURCES[entry.id];
      sources.add(
        `${entry.scope === 'project' ? source.projectLabel : source.userLabel} · ${entry.scope === 'project' ? 'Workspace' : 'User'}`,
      );
    }
  for (const gap of state.gaps) {
    if (gap.skillSource)
      sources.add(
        sourceLabel({
          kind: 'skill',
          agent: gap.agent as InventoryItem['agent'],
          scope: gap.scope as InventoryItem['scope'],
          skillSource: gap.skillSource,
        }),
      );
    else
      sources.add(
        `${INVENTORY_AGENTS[gap.agent] ?? 'Unsupported source'} · ${gap.scope === 'project' ? 'Workspace' : gap.scope === 'user' ? 'User' : 'Scope unavailable'}`,
      );
  }
  if (sources.size)
    rows.push({
      key: 'inventory-coverage',
      title: 'Inventory coverage incomplete',
      detail: `${captured} ${[...sources].slice(0, 6).join('; ')}${sources.size > 6 ? `; ${sources.size - 6} more sources` : ''}. Unsupported or unreadable content cannot establish absence or protection.`,
      href: coverageHref,
      action: 'Inspect coverage',
      tone: 'orange',
    });
  return rows;
}
function routineRows(
  state: InventoryState,
  freshness: InventoryFreshness,
): ProtectionEvidenceRow[] {
  const rows: ProtectionEvidenceRow[] = [],
    captured = captureLabel(state, freshness);
  const changed = state.items.filter((i) => i.state === 'changed' || i.state === 'missing').length;
  const fresh = state.items.filter((i) => i.state === 'unreviewed').length;
  if (changed)
    rows.push({
      key: 'inventory-changes',
      title: `${changed} artifacts changed since review`,
      detail: `${captured} Compare current fingerprints with the versions you reviewed. Changes are not automatically malicious.`,
      href: inventoryHref(null, null, null, 'all', 'changes'),
      action: 'Review changes',
      tone: 'orange',
    });
  if (fresh)
    rows.push({
      key: 'inventory-new',
      title: `${fresh} artifacts awaiting first review`,
      detail: `${captured} Inspect skill capabilities and MCP configuration before recording a baseline. Review grants no trust or protection.`,
      href: inventoryHref(null, null, null, 'all', 'unreviewed'),
      action: 'Inspect inventory',
      tone: 'muted',
    });
  return rows;
}
export function inventoryAttentionRows(
  state: InventoryState | null,
  workspaceId: string | null,
  freshness: InventoryFreshness,
): ProtectionEvidenceRow[] {
  if (!state || !workspaceId || state.workspace.id !== workspaceId)
    return [
      {
        key: 'inventory-unavailable',
        title: 'Artifact inventory unavailable',
        detail:
          'No matching inventory capture is available. Other checks do not establish artifact coverage.',
        href: '/skills/',
        action: 'Inspect inventory',
        tone: 'orange',
      },
    ];
  const attention = state.items
    .filter(
      (i) =>
        incomplete(i) ||
        (suspect(i) &&
          !(
            freshness === 'current' &&
            state.signalDecisions?.status === 'ready' &&
            validateInventoryItem(i) &&
            i.signalDecision?.standing === 'applies' &&
            i.signalDecision.record?.binding.workspaceId === workspaceId &&
            i.signalDecision.record.recordedAt <= state.generatedAt
          )),
    )
    .toSorted((a, b) => Number(suspect(b)) - Number(suspect(a)) || a.id.localeCompare(b.id));
  const visible = attention.slice(0, INVENTORY_ATTENTION_LIMIT),
    omitted = attention.slice(INVENTORY_ATTENTION_LIMIT);
  const rows = visible.map((item) => exactRow(item, state, freshness));
  for (const signals of [true, false]) {
    const count = omitted.filter((item) => suspect(item) === signals).length;
    if (count)
      rows.push({
        key: signals ? 'inventory-more-signals' : 'inventory-more-incomplete',
        title: `${count} more ${signals ? 'artifacts with matched signals' : 'incomplete artifact inspections'}`,
        detail: `${captureLabel(state, freshness)} Every remaining item is available in the matching inventory view.`,
        href: inventoryHref(null, null, null, 'all', signals ? 'signals' : 'incomplete'),
        action: signals ? 'Inspect all signals' : 'Inspect all gaps',
        tone: 'orange',
      });
  }
  rows.push(...coverageRows(state, freshness));
  if (freshness !== 'current')
    rows.push({
      key: 'inventory-historical',
      title: 'Inventory needs a fresh read',
      detail: `${captureLabel(state, freshness)} The latest inventory read has not completed successfully. Unrelated background checks do not refresh this capture.`,
      href: '/skills/',
      action: 'Refresh inventory',
      tone: 'orange',
    });
  return [...rows, ...routineRows(state, freshness)];
}
