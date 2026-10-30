import { describe, expect, it } from 'vitest';
import {
  INVENTORY_SIGNAL_LIMITATIONS,
  validateInventorySignalBinding,
  validateInventorySignalState,
  validateInventorySignalPreview,
  validateInventorySignalReceipt,
  type InventorySignalState,
} from './inventory-signal-decision';

function state(): InventorySignalState {
  const binding = {
    workspaceId: `workspace-${'a'.repeat(24)}`,
    itemId: `item-${'b'.repeat(24)}`,
    agent: 'shared' as const,
    skillSource: 'agents-skills' as const,
    scope: 'project' as const,
    artifactSha256: 'c'.repeat(64),
    sourceSha256: 'd'.repeat(64),
    analysisSha256: 'e'.repeat(64),
  };
  const record = {
    id: '12345678-abcd-4123-8123-123456789abc',
    binding,
    decision: 'accepted-risk' as const,
    reason: 'required-use' as const,
    recordedAt: '2026-10-24T01:00:00.000Z',
  };
  return {
    schema: 'stroq-inventory-signal-state/1',
    source: 'local',
    generatedAt: '2026-10-24T01:00:01.000Z',
    workspaceId: binding.workspaceId,
    artifact: {
      id: binding.itemId,
      name: 'notes',
      agent: binding.agent,
      skillSource: binding.skillSource,
      scope: binding.scope,
      sha256: binding.artifactSha256,
    },
    binding: structuredClone(binding),
    eligible: true,
    reason: 'ready',
    store: { status: 'ready', revision: 'f'.repeat(64) },
    standing: 'applies',
    decision: structuredClone(record),
    history: { records: [record], omitted: 0 },
    findings: 2,
    limitations: INVENTORY_SIGNAL_LIMITATIONS,
  };
}
describe('exact skill signal decisions', () => {
  it('validates an explicit local assessment without granting trust', () => {
    expect(validateInventorySignalState(state())).toBe(true);
  });
  it('requires a known source with its exact agent, never a null or missing source', () => {
    for (const patch of [
      { skillSource: null, agent: 'unknown' },
      { skillSource: undefined },
      { skillSource: 'agents-skills', agent: 'claude-code' },
    ])
      expect(validateInventorySignalBinding({ ...state().binding, ...patch })).toBe(false);
    const s = state();
    Object.assign(s.artifact, { skillSource: null, agent: 'unknown' });
    expect(validateInventorySignalState(s)).toBe(false);
  });
  it('never lets a historical source, scope, bytes or analysis suppress current signals', () => {
    for (const [key, value] of Object.entries({
      workspaceId: `workspace-${'f'.repeat(24)}`,
      itemId: `item-${'f'.repeat(24)}`,
      scope: 'user',
      skillSource: 'cursor-skills',
      artifactSha256: 'f'.repeat(64),
      sourceSha256: 'f'.repeat(64),
      analysisSha256: 'f'.repeat(64),
    })) {
      const s = state();
      Object.assign(s.decision!.binding, { [key]: value });
      expect(validateInventorySignalState(s)).toBe(false);
    }
  });
  it('allows stale decisions and explicit reopening while preserving original findings', () => {
    const stale = state();
    stale.standing = 'stale';
    stale.binding!.sourceSha256 = 'f'.repeat(64);
    expect(validateInventorySignalState(stale)).toBe(true);
    const reopened = state();
    reopened.standing = 'reopened';
    for (const r of [reopened.decision!, ...reopened.history.records]) {
      r.decision = 'reopened';
      r.reason = 'reconsidered';
    }
    expect(validateInventorySignalState(reopened)).toBe(true);
    reopened.standing = 'applies';
    expect(validateInventorySignalState(reopened)).toBe(false);
  });
  it('requires the entire latest record to match the history, not just its UUID', () => {
    for (const mutate of [
      (s: InventorySignalState) => {
        s.decision!.reason = 'controlled-environment';
      },
      (s: InventorySignalState) => {
        s.history.records[0]!.binding.sourceSha256 = 'f'.repeat(64);
      },
    ]) {
      const s = state();
      mutate(s);
      expect(validateInventorySignalState(s)).toBe(false);
    }
  });
  it('refuses a foreign source or scope anywhere in the retained history', () => {
    for (const patch of [{ agent: 'cursor', skillSource: 'cursor-skills' }, { scope: 'user' }]) {
      const s = state();
      const older = structuredClone(s.decision!);
      older.id = '22345678-abcd-4123-8123-123456789abc';
      Object.assign(older.binding, patch);
      s.history.records.push(older);
      expect(validateInventorySignalState(s)).toBe(false);
    }
  });
  it('bounds the complete retained history and refuses holes or omitted-only histories', () => {
    const s = state();
    s.history.omitted = 512;
    expect(validateInventorySignalState(s)).toBe(false);
    s.history = { records: [], omitted: 1 };
    s.decision = null;
    s.standing = 'unresolved';
    expect(validateInventorySignalState(s)).toBe(false);
    s.history = { records: new Array(1), omitted: 0 };
    expect(validateInventorySignalState(s)).toBe(false);
  });
  it('refuses incomplete evidence, unavailable persistence and authority-changing extras', () => {
    for (const patch of [
      { reason: 'incomplete', eligible: false },
      { store: { status: 'unavailable', revision: null } },
      { trusted: true },
    ]) {
      expect(validateInventorySignalState({ ...state(), ...patch })).toBe(false);
    }
    const s = state();
    s.store = { status: 'unavailable', revision: null };
    s.reason = 'store-unavailable';
    s.eligible = false;
    s.standing = 'unavailable';
    s.decision = null;
    s.history = { records: [], omitted: 0 };
    expect(validateInventorySignalState(s)).toBe(true);
  });
  it('binds a short-lived preview to the latest decision and a compatible finite reason', () => {
    const s = state();
    const preview = {
      schema: 'stroq-inventory-signal-preview/1',
      source: 'local',
      workspaceId: s.workspaceId,
      previewId: '32345678-abcd-4123-8123-123456789abc',
      expiresAt: '2026-10-24T01:02:01.000Z',
      decision: 'false-positive',
      reason: 'incorrect-match',
      expectedDecisionId: s.decision!.id,
      state: s,
      limitations: INVENTORY_SIGNAL_LIMITATIONS,
    };
    expect(validateInventorySignalPreview(preview)).toBe(true);
    for (const patch of [
      { expectedDecisionId: null },
      { reason: 'required-use' },
      { expiresAt: '2026-10-24T01:02:01.001Z' },
      { expiresAt: s.decision!.recordedAt },
    ])
      expect(validateInventorySignalPreview({ ...preview, ...patch })).toBe(false);
  });
  it('accepts a receipt only for the verified saved record with unchanged authority', () => {
    const s = state();
    const r = s.decision!;
    const receipt = {
      schema: 'stroq-inventory-signal-receipt/1',
      source: 'local',
      workspaceId: s.workspaceId,
      previewId: '32345678-abcd-4123-8123-123456789abc',
      recordId: r.id,
      decision: r.decision,
      recordedAt: r.recordedAt,
      state: s,
      baselineChanged: false,
      permissionsChanged: false,
    };
    expect(validateInventorySignalReceipt(receipt)).toBe(true);
    for (const patch of [
      { permissionsChanged: true },
      { baselineChanged: true },
      { recordId: '42345678-abcd-4123-8123-123456789abc' },
      { decision: 'false-positive' },
    ])
      expect(validateInventorySignalReceipt({ ...receipt, ...patch })).toBe(false);
  });
});
