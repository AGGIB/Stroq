import { describe, expect, it } from 'vitest';
import {
  inventorySignalApplyInput,
  inventorySignalPreviewInput,
  inventorySignalPreviewMatches,
  inventorySignalReceiptMatches,
  inventorySignalSelectionKey,
  inventorySignalStateMatches,
} from './inventory-signal-binding';
import {
  INVENTORY_SIGNAL_LIMITATIONS,
  type InventorySignalState,
  type InventorySignalPreview,
  type InventorySignalReceipt,
} from './inventory-signal-decision';
import type { InventoryItem } from './inventory';

const ws = `workspace-${'a'.repeat(24)}`;
const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const at = '2026-10-24T10:00:00.000Z';
const item: InventoryItem = {
  id: `item-${'b'.repeat(24)}`,
  kind: 'skill',
  name: 'Release notes',
  agent: 'shared',
  skillSource: 'agents-skills',
  scope: 'project',
  fileType: 'skill-tree',
  sha256: 'c'.repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'suspect', findings: 1 },
  capabilities: [],
};
const state = (): InventorySignalState => ({
  schema: 'stroq-inventory-signal-state/1',
  source: 'local',
  generatedAt: at,
  workspaceId: ws,
  artifact: {
    id: item.id,
    name: item.name,
    agent: 'shared',
    skillSource: 'agents-skills',
    scope: 'project',
    sha256: item.sha256!,
  },
  binding: {
    workspaceId: ws,
    itemId: item.id,
    agent: 'shared',
    skillSource: 'agents-skills',
    scope: 'project',
    artifactSha256: item.sha256!,
    sourceSha256: 'd'.repeat(64),
    analysisSha256: 'e'.repeat(64),
  },
  eligible: true,
  reason: 'ready',
  store: { status: 'missing', revision: null },
  standing: 'unresolved',
  decision: null,
  history: { records: [], omitted: 0 },
  findings: 1,
  limitations: [...INVENTORY_SIGNAL_LIMITATIONS],
});
const preview = (): InventorySignalPreview => ({
  schema: 'stroq-inventory-signal-preview/1',
  source: 'local',
  workspaceId: ws,
  previewId: uuid(1),
  expiresAt: '2026-10-24T10:02:00.000Z',
  decision: 'accepted-risk',
  reason: 'required-use',
  expectedDecisionId: null,
  state: state(),
  limitations: [...INVENTORY_SIGNAL_LIMITATIONS],
});
const receipt = (): InventorySignalReceipt => {
  const saved = state();
  const record = {
    id: uuid(2),
    binding: saved.binding!,
    decision: 'accepted-risk' as const,
    reason: 'required-use' as const,
    recordedAt: at,
  };
  Object.assign(saved, {
    store: { status: 'ready', revision: 'f'.repeat(64) },
    standing: 'applies',
    decision: record,
    history: { records: [record], omitted: 0 },
  });
  return {
    schema: 'stroq-inventory-signal-receipt/1',
    source: 'local',
    workspaceId: ws,
    previewId: uuid(1),
    recordId: record.id,
    decision: record.decision,
    recordedAt: at,
    state: saved,
    baselineChanged: false,
    permissionsChanged: false,
  };
};
describe('signal decisions bind exact source and independent analysis', () => {
  it('keys canonical provenance and SHA while baseline review stays independent', () => {
    const key = inventorySignalSelectionKey(item, ws);
    expect(key).not.toBeNull();
    const reviewed = { ...item, reviewedSha256: '1'.repeat(64) };
    expect(inventorySignalSelectionKey(reviewed, ws)).toBe(key);
    for (const change of [
      { sha256: '2'.repeat(64) },
      { scope: 'user' as const },
      { agent: 'codex' as const, skillSource: 'codex-skills' as const },
      { kind: 'mcp' as const },
    ])
      expect(inventorySignalSelectionKey({ ...item, ...change }, ws)).not.toBe(key);
    expect(inventorySignalSelectionKey({ ...item, skillSource: undefined }, ws)).toBeNull();
    expect(
      inventorySignalSelectionKey({ ...item, agent: 'claude-code', skillSource: undefined }, ws),
    ).not.toBeNull();
  });
  it('accepts only a separately validated state for this workspace, source and captured revision', () => {
    expect(inventorySignalStateMatches(state(), item, ws)).toBe(true);
    expect(inventorySignalStateMatches(state(), { ...item, scope: 'user' }, ws)).toBe(false);
    expect(inventorySignalStateMatches(state(), { ...item, sha256: '3'.repeat(64) }, ws)).toBe(
      false,
    );
    expect(inventorySignalStateMatches(state(), item, `workspace-${'0'.repeat(24)}`)).toBe(false);
    expect(inventorySignalStateMatches({ ...state(), findings: -1 }, item, ws)).toBe(false);
  });
  it('builds closed exact requests, rejects wrong reasons and incomplete evidence', () => {
    expect(inventorySignalPreviewInput(state(), item, ws, 'accepted-risk', 'required-use')).toEqual(
      {
        id: item.id,
        expectedSha256: item.sha256,
        expectedDecisionId: null,
        decision: 'accepted-risk',
        reason: 'required-use',
      },
    );
    expect(
      inventorySignalPreviewInput(state(), item, ws, 'accepted-risk', 'test-or-example'),
    ).toBeNull();
    const partial = { ...state(), eligible: false, binding: null, reason: 'incomplete' as const };
    expect(
      inventorySignalPreviewInput(partial, item, ws, 'false-positive', 'test-or-example'),
    ).toBeNull();
  });
  it('refuses preview source/analysis/store drift, unrelated decisions and expired nonce', () => {
    const plan = preview();
    const now = Date.parse(at);
    expect(
      inventorySignalPreviewMatches(plan, state(), item, ws, 'accepted-risk', 'required-use', now),
    ).toBe(true);
    for (const change of [{ sourceSha256: '1'.repeat(64) }, { analysisSha256: '2'.repeat(64) }]) {
      const forged = structuredClone(plan);
      Object.assign(forged.state.binding!, change);
      expect(
        inventorySignalPreviewMatches(
          forged,
          state(),
          item,
          ws,
          'accepted-risk',
          'required-use',
          now,
        ),
      ).toBe(false);
    }
    expect(
      inventorySignalPreviewMatches(
        plan,
        state(),
        item,
        ws,
        'false-positive',
        'test-or-example',
        now,
      ),
    ).toBe(false);
    expect(
      inventorySignalPreviewMatches(
        plan,
        state(),
        item,
        ws,
        'accepted-risk',
        'required-use',
        Date.parse(plan.expiresAt),
      ),
    ).toBe(false);
    expect(inventorySignalApplyInput(plan, false, now)).toBeNull();
    expect(inventorySignalApplyInput(plan, true, now)).toEqual({
      previewId: uuid(1),
      acknowledgeSignalOnly: true,
    });
    expect(inventorySignalApplyInput(plan, true, Date.parse(plan.expiresAt))).toBeNull();
  });
  it('accepts only matching receipt nonce, exact binding and selected assessment', () => {
    expect(inventorySignalReceiptMatches(receipt(), preview(), item, ws)).toBe(true);
    for (const change of [
      { previewId: uuid(9) },
      { baselineChanged: true },
      { decision: 'false-positive' },
    ])
      expect(inventorySignalReceiptMatches({ ...receipt(), ...change }, preview(), item, ws)).toBe(
        false,
      );
    const wrong = receipt();
    wrong.state.binding!.analysisSha256 = '1'.repeat(64);
    wrong.state.decision!.binding = { ...wrong.state.binding! };
    expect(inventorySignalReceiptMatches(wrong, preview(), item, ws)).toBe(false);
  });
});
