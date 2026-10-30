import {
  validateMcpGovernanceState,
  validateMcpGovernanceRecord,
  validateMcpGovernancePreview,
  type McpGovernanceRecord,
} from './mcp-governance';
import type { McpGovernancePending } from './mcp-governance-client';
import { mcpGovernanceHref } from './mcp-governance-navigation';
import { closed, stamp } from './local-guards';
import type { ProtectionEvidenceRow } from './protection-evidence';

export type ProtectionAttentionPriority =
  | 'uncertain-operation'
  | 'current-change'
  | 'unavailable'
  | 'failure'
  | 'current-evidence'
  | 'historical-evidence';
export type ProtectionAttentionRow = ProtectionEvidenceRow & {
  priority?: ProtectionAttentionPriority;
};
export interface McpGovernanceUnknownLedger {
  records: McpGovernanceRecord[];
  limited: boolean;
}
const opKey = (r: Pick<McpGovernanceRecord, 'operationId' | 'binding'>) =>
  r.binding.contextId + ':' + r.operationId;
const validWorkspace = (v: unknown): v is string =>
  typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const scoped = (value: unknown, workspace: string) =>
  validateMcpGovernanceState(value) && value.workspaceId === workspace ? value : null;
const sameOperation = (a: McpGovernanceRecord, b: McpGovernanceRecord) =>
  a.id === b.id &&
  opKey(a) === opKey(b) &&
  a.candidateFingerprint === b.candidateFingerprint &&
  a.candidateRawSha256 === b.candidateRawSha256;
/** Only an observed exact durable terminal can retire a server-read unknown; missing/foreign GET cannot. */
export function mergeMcpGovernanceUnknowns(
  previous: McpGovernanceUnknownLedger,
  state: unknown,
  workspaceId: string,
): McpGovernanceUnknownLedger {
  const current = scoped(state, workspaceId),
    records: McpGovernanceRecord[] = [],
    seen = new Set<string>();
  let limited = previous.limited;
  for (const r of [...previous.records, ...(current?.records ?? [])]) {
    if (
      !validateMcpGovernanceRecord(r) ||
      r.binding.workspaceId !== workspaceId ||
      r.status !== 'unknown' ||
      seen.has(opKey(r))
    )
      continue;
    const observed = current?.records.find((v) => sameOperation(v, r));
    if (observed && observed.status !== 'unknown') continue;
    seen.add(opKey(r));
    if (records.length === 32) {
      limited = true;
      continue;
    }
    records.push(observed ?? r);
  }
  return { records, limited };
}
interface Input {
  state: unknown;
  workspaceId: string | null;
  pending?: readonly McpGovernancePending[];
  retained?: McpGovernanceUnknownLedger;
  loading?: boolean;
}
const validPending = (v: unknown): v is McpGovernancePending =>
  closed(v, ['preview', 'startedAt']) &&
  Reflect.ownKeys(v).length === 2 &&
  validateMcpGovernancePreview(v.preview) &&
  stamp(v.startedAt);
/** Passive configuration/history projection. No capture, recheck, mutation or host-adoption inference. */
export function mcpGovernanceAttentionRows(input: Input): ProtectionAttentionRow[] {
  const workspaceId = input.workspaceId;
  if (!validWorkspace(workspaceId)) return [];
  const state = scoped(input.state, workspaceId),
    rows: ProtectionAttentionRow[] = [],
    seen = new Set<string>();
  const history = (contextId?: string, operationId?: string) =>
    mcpGovernanceHref({
      view: 'history',
      workspaceId,
      ...(contextId ? { contextId } : {}),
      ...(operationId ? { operationId } : {}),
    });
  const unknownRow = (contextId: string, operationId: string, pending: boolean) => {
    const key = contextId + ':' + operationId;
    if (seen.has(key)) return;
    seen.add(key);
    const foreign = !!state?.contextId && state.contextId !== contextId;
    rows.push({
      key: 'mcp-governance-unknown:' + key,
      priority: 'uncertain-operation',
      title: 'MCP policy change needs confirmation',
      context: foreign ? 'Recorded Stroq home context' : 'Stroq home · all workspaces',
      detail:
        (foreign ? 'Return to the recorded connection to inspect this exact operation. ' : '') +
        (pending
          ? 'The response did not establish completion. '
          : 'This retained operation has no confirmed publication outcome. ') +
        'Recheck the exact change; do not repeat Apply. Ordinary refresh does not confirm it or establish client adoption.',
      href: history(contextId, operationId),
      action: 'Recheck change',
      tone: 'orange',
    });
  };
  for (const write of input.pending ?? []) {
    if (!validPending(write) || write.preview.binding.workspaceId !== workspaceId) continue;
    unknownRow(write.preview.binding.contextId, write.preview.operationId, true);
  }
  for (const r of [...(input.retained?.records ?? []), ...(state?.records ?? [])]) {
    if (
      validateMcpGovernanceRecord(r) &&
      r.binding.workspaceId === workspaceId &&
      r.status === 'unknown'
    )
      unknownRow(r.binding.contextId, r.operationId, false);
  }
  if (input.retained?.limited)
    rows.push({
      key: 'mcp-governance-retained-limit',
      priority: 'unavailable',
      title: 'MCP operation coverage limited',
      context: 'Retained unknown changes',
      detail:
        'More unknown operations were observed than this bounded view can retain. Earlier unresolved changes were not cleared.',
      href: history(),
      action: 'Inspect history',
      tone: 'orange',
    });
  if ((!state && !input.loading) || state?.history === 'unavailable')
    rows.push({
      key: 'mcp-governance-history-unavailable',
      priority: 'unavailable',
      title: 'MCP governance history unavailable',
      context: 'Stroq home · all workspaces',
      detail:
        'Saved operations could not be verified. Missing evidence does not establish an empty history or resolve an unknown change.',
      href: history(state?.contextId ?? undefined),
      action: 'Inspect history',
      tone: 'orange',
    });
  const applied = state?.records.filter((r) => r.status === 'applied') ?? [];
  if (
    state &&
    (state.current.gate === 'unavailable' || applied.some((r) => r.current === 'unavailable'))
  ) {
    rows.push({
      key: 'mcp-governance-current-unavailable',
      priority: 'unavailable',
      title: 'Current MCP policy is unverified',
      context: 'Stroq home · all workspaces',
      detail:
        'Historical publication receipts do not establish the current policy declaration. Inspect current settings separately; client adoption remains unverified.',
      href: history(state.contextId ?? undefined),
      action: 'Inspect policy',
      tone: 'orange',
    });
  } else if (applied.length && !applied.some((r) => r.current === 'matches')) {
    rows.push({
      key: 'mcp-governance-current-changed',
      priority: 'current-change',
      title: 'MCP policy differs from recorded configuration',
      context: 'Stroq home · all workspaces',
      detail:
        'No retained confirmed candidate matches the current policy. This is configuration drift, independent of exact unknown operations and historical write receipts.',
      href: history(state!.contextId ?? undefined),
      action: 'Inspect policy',
      tone: 'orange',
    });
  }
  return rows;
}
const priority: Record<ProtectionAttentionPriority, number> = {
  'uncertain-operation': 0,
  'current-change': 10,
  unavailable: 20,
  failure: 30,
  'current-evidence': 50,
  'historical-evidence': 90,
};
/** What a new user has not done yet, in the order they would do it: after any real finding. */
const FIRST_STEPS = ['install', 'workspace-review-first', 'secret-never', 'live-never'];
const FIRST_STEP_RANK = 60;
/** Priority describes the operator action, independently of color or historical test success. */
export function sortProtectionAttention(
  rows: readonly ProtectionAttentionRow[],
): ProtectionAttentionRow[] {
  const rank = (row: ProtectionEvidenceRow) => {
    const explicit = (row as ProtectionAttentionRow).priority;
    if (explicit && Object.hasOwn(priority, explicit)) return priority[explicit];
    const step = FIRST_STEPS.indexOf(row.key);
    if (step >= 0) return FIRST_STEP_RANK + step;
    if (
      [
        'policy',
        'scenarios',
        'scenarios-context',
        'protection-attempt',
        'journal-gap',
        'quarantine',
      ].includes(row.key)
    )
      return priority.failure;
    if (row.key.startsWith('live-')) return priority['historical-evidence'];
    return priority['current-evidence'];
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map((v) => v.row);
}
