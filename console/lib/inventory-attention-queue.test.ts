import { describe, expect, it } from 'vitest';
import { inventoryAttentionRows, INVENTORY_ATTENTION_LIMIT } from './inventory-attention-queue';
import { validateInventory, type InventoryItem, type InventoryState } from './inventory';

const workspace = `workspace-${'a'.repeat(24)}`;
const capturedAt = '2026-10-24T01:00:00.000Z';
const sha = 'b'.repeat(64);
function skill(n = 1, patch: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `item-${n.toString(16).padStart(24, '0')}`,
    name: 'review-notes',
    kind: 'skill',
    agent: 'shared',
    skillSource: 'agents-skills',
    scope: 'project',
    fileType: 'skill-tree',
    sha256: sha,
    reviewedSha256: sha,
    state: 'unchanged',
    scan: { status: 'suspect', findings: 2 },
    capabilities: [],
    quarantineSupported: false,
    ...patch,
  };
}
function state(items: InventoryItem[] = [skill()]): InventoryState {
  const result: InventoryState = {
    schema: 'stroq-inventory/1',
    source: 'local',
    generatedAt: capturedAt,
    workspace: { id: workspace, label: 'Fixture' },
    baseline: { status: 'ready', reviewedAt: capturedAt },
    items,
    gaps: [],
    limitations: [],
  };
  expect(validateInventory(result)).toBe(true);
  return result;
}
const rows = (
  v: InventoryState | null,
  freshness: 'current' | 'historical' | 'unavailable' = 'current',
) => inventoryAttentionRows(v, workspace, freshness);

describe('artifact conditions remain separate from a recorded review', () => {
  it('keeps a reviewed suspect source in attention with an exact qualified link', () => {
    const result = rows(state());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tone: 'orange', action: 'Inspect signals' });
    const target = new URL(result[0]!.href, 'http://local.test');
    expect(target.searchParams.get('workspace')).toBe(workspace);
    expect(target.searchParams.get('item')).toBe(skill().id);
    expect(target.searchParams.get('sha')).toBe(sha);
    expect(target.searchParams.get('view')).toBe('signals');
    expect(result[0]!.detail).toContain('.agents/skills · Workspace');
    expect(result[0]!.detail).toContain(capturedAt);
    expect(result[0]!.detail).toMatch(/static/i);
  });
  it('does not turn below-threshold matched signals into suspect or remediation', () => {
    expect(rows(state([skill(1, { scan: { status: 'clean', findings: 1 } })]))).toEqual([]);
  });
  it('does not merge identically named skills from different origins/scopes', () => {
    const result = rows(
      state([
        skill(),
        skill(2, { agent: 'cursor', skillSource: 'cursor-skills' }),
        skill(3, { scope: 'user' }),
      ]),
    );
    expect(new Set(result.map((v) => v.key)).size).toBe(3);
    expect(new Set(result.map((v) => v.href)).size).toBe(3);
    expect(result.map((v) => v.detail).join(' ')).toContain('~/.agents/skills · User');
    expect(result.map((v) => v.detail).join(' ')).toContain('.cursor/skills · Workspace');
  });
  it('surfaces incomplete and unverifiable captures without classifying an attack', () => {
    for (const item of [
      skill(1, { state: 'unverifiable', scan: { status: 'clean', findings: 0 } }),
      skill(1, { scan: { status: 'incomplete', findings: 0 } }),
    ]) {
      const result = rows(state([item]));
      expect(result[0]?.title).toMatch(/incomplete/i);
      expect(result[0]?.tone).toBe('orange');
      expect(result[0]?.href).toContain('view=incomplete');
    }
  });
  it('bounds exact rows but exposes every omitted condition through a matching filter', () => {
    const total = INVENTORY_ATTENTION_LIMIT + 3;
    const result = rows(state(Array.from({ length: total }, (_, n) => skill(n + 1))));
    expect(result.filter((v) => v.key.startsWith('inventory-item:'))).toHaveLength(
      INVENTORY_ATTENTION_LIMIT,
    );
    expect(result.at(-1)?.title).toContain('3 more');
    expect(result.at(-1)?.href).toBe('/skills/?view=signals');
  });
  it('links routine change and first-review summaries to their actual filter', () => {
    const result = rows(
      state([
        skill(1, {
          state: 'changed',
          sha256: 'c'.repeat(64),
          scan: { status: 'clean', findings: 0 },
        }),
        skill(2, {
          state: 'unreviewed',
          reviewedSha256: null,
          scan: { status: 'clean', findings: 0 },
        }),
      ]),
    );
    expect(result.map((v) => v.href)).toEqual([
      '/skills/?view=changes',
      '/skills/?view=unreviewed',
    ]);
  });
  it('keeps missing baseline routine, invalid baseline and per-source partial coverage explicit', () => {
    const initial = state([]);
    initial.baseline = { status: 'missing', reviewedAt: null };
    expect(rows(initial)).toEqual([]);
    const invalid = state([]);
    invalid.baseline.status = 'invalid';
    expect(rows(invalid)[0]?.title).toMatch(/baseline.*unavailable/i);
    const partial = state([]);
    partial.skillSources = [
      { id: 'agents-skills', scope: 'user', status: 'partial', candidates: 0 },
    ];
    const result = rows(partial);
    expect(result).toHaveLength(1);
    expect(result[0]?.detail).toContain('~/.agents/skills · User');
    expect(result[0]?.href).toBe('/skills/?view=incomplete#inventory-coverage');
  });
  it('never substitutes a clean empty state for absent or foreign inventory', () => {
    for (const v of [
      null,
      { ...state([]), workspace: { id: `workspace-${'f'.repeat(24)}`, label: 'Other' } },
    ])
      expect(rows(v, 'unavailable')[0]?.title).toMatch(/inventory.*unavailable/i);
  });
  it('retains historical evidence with its original capture time and an explicit refresh action', () => {
    const result = rows(state(), 'historical');
    expect(result.some((v) => v.action === 'Refresh inventory')).toBe(true);
    expect(result.find((v) => v.key.startsWith('inventory-item:'))?.detail).toMatch(/historical/i);
    expect(result.find((v) => v.key.startsWith('inventory-item:'))?.detail).toContain(capturedAt);
    expect(
      rows(state([skill(1, { scan: { status: 'clean', findings: 0 } })]), 'historical'),
    ).toHaveLength(1);
  });
});

function decided(patch: Partial<InventoryItem> = {}) {
  const item = skill(1, patch);
  const record = {
    id: '12345678-abcd-4123-8123-123456789abc',
    binding: {
      workspaceId: workspace,
      itemId: item.id,
      agent: 'shared' as const,
      skillSource: 'agents-skills' as const,
      scope: 'project' as const,
      artifactSha256: item.sha256!,
      sourceSha256: 'd'.repeat(64),
      analysisSha256: 'e'.repeat(64),
    },
    decision: 'accepted-risk' as const,
    reason: 'required-use' as const,
    recordedAt: capturedAt,
  };
  return { ...item, signalDecision: { standing: 'applies' as const, record } };
}
describe('current signal assessment affects only static-signal attention', () => {
  it('acknowledges one current source while preserving independent change and coverage rows', () => {
    const s = {
      ...state([]),
      items: [decided({ state: 'unreviewed', reviewedSha256: null }), skill(2)],
      signalDecisions: { status: 'ready' as const },
    };
    expect(validateInventory(s)).toBe(true);
    const output = rows(s);
    expect(output.filter((r) => r.key.startsWith('inventory-item:')).map((r) => r.key)).toEqual([
      `inventory-item:${skill(2).id}`,
    ]);
    expect(output.some((r) => r.key === 'inventory-new')).toBe(true);
    s.gaps.push({
      code: 'limit',
      agent: 'shared',
      scope: 'project',
      kind: 'skill',
      skillSource: 'agents-skills',
    });
    expect(rows(s).some((r) => r.key === 'inventory-coverage')).toBe(true);
    expect(s.items[0]?.scan.findings).toBe(2);
  });
  it('never uses historical decisions or a missing store declaration to hide signals', () => {
    const s: InventoryState = {
      ...state([]),
      items: [decided()],
      signalDecisions: { status: 'ready' },
    };
    expect(rows(s, 'historical').some((r) => r.key.startsWith('inventory-item:'))).toBe(true);
    delete s.signalDecisions;
    expect(validateInventory(s)).toBe(false);
    expect(rows(s).some((r) => r.key.startsWith('inventory-item:'))).toBe(true);
  });
  it('rejects copied records, incomplete evidence and forged store readiness', () => {
    for (const mutate of [
      (s: InventoryState) => {
        s.items[0]!.signalDecision!.record!.binding.scope = 'user';
      },
      (s: InventoryState) => {
        s.items[0]!.signalDecision!.record!.binding.workspaceId = `workspace-${'f'.repeat(24)}`;
      },
      (s: InventoryState) => {
        s.items[0]!.scan.status = 'incomplete';
      },
      (s: InventoryState) => {
        s.items[0]!.sha256 = 'f'.repeat(64);
        s.items[0]!.state = 'changed';
      },
      (s: InventoryState) => {
        s.signalDecisions!.status = 'unavailable';
      },
    ]) {
      const s: InventoryState = {
        ...state([]),
        items: [decided()],
        signalDecisions: { status: 'ready' },
      };
      mutate(s);
      expect(validateInventory(s)).toBe(false);
    }
  });
  it('keeps an unavailable decision store visible as an inspection gap', () => {
    const s = { ...state([]), signalDecisions: { status: 'unavailable' as const } };
    expect(validateInventory(s)).toBe(true);
    expect(rows(s).some((r) => r.key === 'inventory-signal-store')).toBe(true);
  });
});
