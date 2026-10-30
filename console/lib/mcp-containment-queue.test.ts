import { describe, expect, it } from 'vitest';
import { mcpContainmentRows } from './mcp-containment-queue';
import type { McpContainmentState, McpContainmentRecord } from './mcp-containment';
const workspaceId = 'workspace-' + 'a'.repeat(24);
const record: McpContainmentRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  originWorkspaceId: workspaceId,
  change: 'remove-registration',
  changedEntrySha256: null,
  proxy: null,
  artifact: {
    id: 'item-' + 'b'.repeat(24),
    kind: 'mcp',
    name: 'Notes',
    agent: 'cursor',
    scope: 'project',
    configSource: 'cursor-project',
    sha256: 'c'.repeat(64),
    digestFormat: 'mcp-entry-canonical-json/1',
  },
  createdAt: '2026-10-23T09:00:00.000Z',
  checkedAt: '2026-10-23T10:00:00.000Z',
  restoredAt: null,
  phase: 'removed',
  status: 'removed',
  slot: 'absent',
  payload: 'match',
  configSha256: 'd'.repeat(64),
  sourceMatchesChange: true,
};
const state = (records = [record]): McpContainmentState => ({
  schema: 'stroq-mcp-containment/2',
  source: 'local',
  generatedAt: record.checkedAt,
  workspaceId,
  available: true,
  reason: null,
  records,
  gaps: [],
  limitations: [],
});
describe('MCP recovery attention queue', () => {
  it('does not turn a successful configuration change into a protection finding', () => {
    expect(mcpContainmentRows(state(), workspaceId)).toEqual([]);
    expect(
      mcpContainmentRows(
        state([
          {
            ...record,
            phase: 'restored',
            status: 'restored',
            slot: 'same',
            restoredAt: record.checkedAt,
          },
        ]),
        workspaceId,
      ),
    ).toEqual([]);
  });
  it('links a reappeared registration and changed recovery to the exact local record', () => {
    const rows = mcpContainmentRows(
      state([{ ...record, status: 'reappeared', slot: 'same' }]),
      workspaceId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toContain('reappeared');
    expect(rows[0]?.href).toBe(`/skills/mcp/?workspace=${workspaceId}&record=${record.id}`);
    expect(rows[0]?.detail).toContain('configuration');
    expect(
      mcpContainmentRows(
        state([{ ...record, status: 'changed', payload: 'changed' }]),
        workspaceId,
      )[0]?.tone,
    ).toBe('orange');
  });
  it('does not present foreign-project unknown source state as a local reappearance', () => {
    const foreign = {
      ...record,
      originWorkspaceId: 'workspace-' + 'f'.repeat(24),
      status: 'unverifiable',
      slot: 'unverifiable',
      configSha256: null,
      sourceMatchesChange: null,
    } as McpContainmentRecord;
    expect(mcpContainmentRows(state([foreign]), workspaceId)).toEqual([]);
    expect(
      mcpContainmentRows(
        {
          ...state([foreign]),
          available: false,
          reason: 'storage-unavailable',
          gaps: [{ code: 'record-invalid' }],
        },
        workspaceId,
      )[0]?.title,
    ).toContain('recovery storage');
  });
  it('keeps missing or wrong-workspace reads explicit and never mutates the snapshot', () => {
    expect(mcpContainmentRows(null, workspaceId)[0]?.tone).toBe('orange');
    const source = state();
    const before = JSON.stringify(source);
    expect(mcpContainmentRows(source, 'workspace-' + 'e'.repeat(24))[0]?.title).toContain(
      'unavailable',
    );
    expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps exact proxy configuration quiet and routes changed or unverified runtime to its record', () => {
    const guarded: McpContainmentRecord = {
      ...record,
      change: 'protect-registration',
      changedEntrySha256: 'e'.repeat(64),
      proxy: { mode: 'strict', policyWorkspaceId: workspaceId, runtimeMatches: true },
      phase: 'configured',
      status: 'configured',
      slot: 'guarded',
    };
    expect(mcpContainmentRows(state([guarded]), workspaceId)).toEqual([]);
    for (const runtimeMatches of [false, null]) {
      const rows = mcpContainmentRows(
        state([{ ...guarded, proxy: { ...guarded.proxy!, runtimeMatches } }]),
        workspaceId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toContain(
        runtimeMatches === false ? 'runtime changed' : 'runtime unverified',
      );
      expect(rows[0]?.href).toBe(`/skills/mcp/?workspace=${workspaceId}&record=${record.id}`);
      expect(rows[0]?.tone).toBe('orange');
    }
  });
});
