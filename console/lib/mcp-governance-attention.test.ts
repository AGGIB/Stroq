import { describe, expect, it } from 'vitest';
import {
  governanceId,
  governanceRecord,
  governanceState,
  governancePreview,
  governanceWorkspace,
} from './mcp-governance-fixtures';
import {
  mcpGovernanceAttentionRows,
  mergeMcpGovernanceUnknowns,
  sortProtectionAttention,
} from './mcp-governance-attention';
import { validateMcpGovernanceState } from './mcp-governance';
const workspaceId = governanceWorkspace;
const state = (records: ReturnType<typeof governanceRecord>[] = []) => ({
  ...governanceState(records),
  history: 'ready' as const,
});
const unknown = () => governanceRecord({ status: 'unknown', historyRef: null, current: 'changed' });
const empty = { records: [], limited: false };
describe('passive MCP governance attention', () => {
  it('keeps missing gate, matching applied and not-applied history quiet', () => {
    for (const s of [
      state(),
      state([governanceRecord()]),
      state([governanceRecord({ status: 'not-applied', current: 'changed' })]),
    ]) {
      expect(validateMcpGovernanceState(s)).toBe(true);
      expect(mcpGovernanceAttentionRows({ state: s, workspaceId })).toEqual([]);
    }
  });
  it('links every exact unknown operation without claiming current protection', () => {
    const record = unknown(),
      rows = mcpGovernanceAttentionRows({ state: state([record]), workspaceId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priority).toBe('uncertain-operation');
    expect(rows[0]!.href).toContain('governanceOperation=' + record.operationId);
    expect(rows[0]!.href).toContain('governanceContext=' + record.binding.contextId);
    expect(rows[0]!.href).toContain('governanceWorkspace=' + workspaceId);
    expect(rows[0]!.detail).toContain('Recheck');
    expect(JSON.stringify(rows)).not.toMatch(
      /server stopped|host verified|credential|candidateRawSha256/,
    );
  });
  it('deduplicates same exact pending/backend operation while GET cannot resolve browser pending', () => {
    const preview = governancePreview(),
      pending = { preview, startedAt: preview.createdAt };
    const rows = mcpGovernanceAttentionRows({
      state: state([governanceRecord()]),
      workspaceId,
      pending: [pending],
    });
    expect(rows.filter((r) => r.priority === 'uncertain-operation')).toHaveLength(1);
    expect(rows[0]!.href).toContain(preview.operationId);
    expect(pending.preview).toBe(preview);
  });
  it('keeps old pending operation when current context changes, fails or has no record', () => {
    const preview = governancePreview(),
      pending = [{ preview, startedAt: preview.createdAt }];
    const foreign = state();
    foreign.contextId = 'governance-context-' + '2'.repeat(64);
    for (const s of [foreign, null, state()]) {
      const rows = mcpGovernanceAttentionRows({ state: s, workspaceId, pending });
      expect(rows.some((r) => r.href.includes(preview.operationId))).toBe(true);
      expect(pending).toHaveLength(1);
    }
  });
  it('uses one aggregate current drift and any matching historical candidate suppresses it', () => {
    const changed = governanceRecord({ current: 'changed' }),
      other = governanceRecord({
        id: governanceId(9),
        operationId: governanceId(10),
        current: 'changed',
      });
    const uncertain = unknown();
    uncertain.id = governanceId(20);
    uncertain.operationId = governanceId(21);
    const rows = mcpGovernanceAttentionRows({
      state: state([changed, other, uncertain]),
      workspaceId,
    });
    expect(rows.filter((r) => r.priority === 'current-change')).toHaveLength(1);
    expect(rows.find((r) => r.priority === 'current-change')!.href).not.toContain(
      'governanceOperation=',
    );
    expect(
      mcpGovernanceAttentionRows({
        state: state([
          changed,
          governanceRecord({ id: governanceId(11), operationId: governanceId(12) }),
        ]),
        workspaceId,
      }),
    ).toEqual([]);
  });
  it('shows history failure and current unavailability independently from unknown writes', () => {
    const unavailable = state();
    unavailable.history = 'unavailable' as any;
    unavailable.editable = false;
    unavailable.error = 'mcp-governance-store-unavailable' as any;
    const rows = mcpGovernanceAttentionRows({
      state: unavailable,
      workspaceId,
      pending: [{ preview: governancePreview(), startedAt: governancePreview().createdAt }],
    });
    expect(rows.some((r) => r.key === 'mcp-governance-history-unavailable')).toBe(true);
    expect(rows.some((r) => r.priority === 'uncertain-operation')).toBe(true);
    expect(mcpGovernanceAttentionRows({ state: null, workspaceId, loading: true })).toEqual([]);
  });
  it('rejects foreign workspace and malformed authority without raw fallback', () => {
    const foreign = state([unknown()]);
    foreign.workspaceId = 'workspace-' + '2'.repeat(24);
    const rows = mcpGovernanceAttentionRows({ state: foreign, workspaceId });
    expect(rows.every((r) => !r.href.includes('governanceOperation='))).toBe(true);
    expect(mcpGovernanceAttentionRows({ state: state([unknown()]), workspaceId: null })).toEqual(
      [],
    );
  });
});
describe('bounded retained server unknown ledger', () => {
  it('does not erase unknown when a same-context GET omits it or switches context', () => {
    const prior = mergeMcpGovernanceUnknowns(empty, state([unknown()]), workspaceId);
    expect(prior.records).toHaveLength(1);
    expect(mergeMcpGovernanceUnknowns(prior, state(), workspaceId).records).toHaveLength(1);
    const foreign = state();
    foreign.contextId = 'governance-context-' + '2'.repeat(64);
    expect(mergeMcpGovernanceUnknowns(prior, foreign, workspaceId).records).toHaveLength(1);
    expect(mergeMcpGovernanceUnknowns(prior, null, workspaceId).records).toHaveLength(1);
    expect(
      mergeMcpGovernanceUnknowns(prior, state([governanceRecord()]), workspaceId).records,
    ).toEqual([]);
  });
  it('retains at most32 without evicting unresolved records and exposes overflow', () => {
    const records = Array.from({ length: 32 }, (_, i) => unknown());
    records.forEach((r, i) => {
      r.id = governanceId(i + 50);
      r.operationId = governanceId(i + 100);
    });
    const prior = mergeMcpGovernanceUnknowns(empty, state(records), workspaceId);
    const next = mergeMcpGovernanceUnknowns(prior, state([unknown()]), workspaceId);
    expect(next.records).toHaveLength(32);
    expect(next.limited).toBe(true);
    expect(next.records.map((r) => r.id)).toEqual(prior.records.map((r) => r.id));
    expect(
      mcpGovernanceAttentionRows({ state: state(), workspaceId, retained: next }).some(
        (r) => r.key === 'mcp-governance-retained-limit',
      ),
    ).toBe(true);
  });
});
it('orders unknown/current/failure before historical gaps with explicit priority independent of color', () => {
  const row = (key: string, tone: 'red' | 'orange' | 'muted' = 'muted') => ({
    key,
    title: key,
    detail: '',
    href: '/',
    action: 'Inspect',
    tone,
  });
  const rows = sortProtectionAttention([
    row('live-never', 'red'),
    row('policy', 'muted'),
    { ...row('unknown'), priority: 'uncertain-operation' as const },
    { ...row('drift'), priority: 'current-change' as const },
  ]);
  expect(rows.map((r) => r.key)).toEqual(['unknown', 'drift', 'policy', 'live-never']);
});
it('puts first steps after current findings, in the order a new user takes them', () => {
  const row = (key: string) => ({
    key,
    title: key,
    detail: '',
    href: '/',
    action: 'Open',
    tone: 'muted' as const,
  });
  const rows = sortProtectionAttention([
    row('secret-never'),
    row('live-never'),
    row('workspace-review-first'),
    row('install'),
    row('policy'),
    row('hook-approval'),
  ]);
  expect(rows.map((r) => r.key)).toEqual([
    'policy',
    'hook-approval',
    'install',
    'workspace-review-first',
    'secret-never',
    'live-never',
  ]);
});
