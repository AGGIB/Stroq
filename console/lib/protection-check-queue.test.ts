import { describe, expect, it } from 'vitest';
import { protectionCheckRows, protectionEvidenceHref } from './protection-check-queue';
import type { ControlRun } from './control';
const workspace = `workspace-${'a'.repeat(24)}`;
const parent: ControlRun = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'protection-check',
  status: 'failed',
  startedAt: '2026-10-24T10:00:00.000Z',
  finishedAt: '2026-10-24T10:00:00.000Z',
  error: 'interrupted',
  progress: {
    steps: ['doctor', 'policy-check', 'guard-test', 'saved-policy-checks', 'workspace-review'].map(
      (id) => ({
        id: id as any,
        status: 'skipped',
        startedAt: null,
        finishedAt: '2026-10-24T10:00:00.000Z',
        error: 'interrupted',
        result: null,
      }),
    ),
  },
  result: {
    source: 'local',
    evidence: 'local-checks',
    outcome: 'incomplete',
    completed: 0,
    total: 5,
    hostEnforcement: false,
  },
};
describe('protection attempt attention and exact embedded evidence', () => {
  it('keeps an incomplete attempt actionable without claiming its process stopped', () => {
    const rows = protectionCheckRows([parent], workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Protection check incomplete');
    expect(rows[0]?.href).toContain(`run=${parent.id}`);
    expect(rows[0]?.detail).not.toContain('process stopped');
    expect(protectionCheckRows([parent], null)).toEqual([]);
  });
  it('links a projected diagnostic to its exact parent stage and preserves unbound anchors', () => {
    const child = { ...parent, kind: 'doctor' } as ControlRun;
    expect(protectionEvidenceHref(child, [parent], workspace, 'doctor')).toContain(
      '#protection-check-doctor',
    );
    expect(protectionEvidenceHref(child, [], null, 'doctor')).toBe('#protection-doctor');
  });
  it('replaces a historical selection with the exact individual result, including when evicted', () => {
    const leaf: ControlRun = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'doctor',
      status: 'failed',
      startedAt: parent.startedAt,
      finishedAt: parent.finishedAt,
      error: 'engine-failed',
    };
    for (const runs of [[leaf, parent], []]) {
      const href = protectionEvidenceHref(leaf, runs, workspace, 'doctor');
      const destination = new URL(href, `http://127.0.0.1/protection/?run=${parent.id}`);
      expect(destination.searchParams.get('run')).toBe(leaf.id);
      expect(destination.searchParams.get('workspace')).toBe(workspace);
      expect(destination.hash).toBe('#protection-doctor');
    }
  });
});

import { mcpCallControlRows } from './protection-check-queue';
import type {
  McpCallControlOverview,
  McpCallControlOverviewRow,
} from './mcp-call-control-overview';
const controlId = '00000000-0000-4000-8000-000000000001',
  eventId = '00000000-0000-4000-8000-000000000002',
  contextId = 'context-' + 'c'.repeat(64);
const controlRow: McpCallControlOverviewRow = {
  controlId,
  artifact: {
    id: 'item-' + 'b'.repeat(24),
    kind: 'mcp',
    name: 'notes',
    agent: 'claude-code',
    scope: 'project',
    sha256: 'd'.repeat(64),
    digestFormat: 'mcp-entry-canonical-json/1',
    configSource: 'claude-code-project',
  },
  retainedSetupId: eventId,
  proxyWorkspaceId: workspace,
  invocationSha256: 'e'.repeat(64),
  capability: 'supported',
  reason: null,
  current: {
    controlId,
    invocationSha256: 'e'.repeat(64),
    mode: 'paused',
    eventId,
    at: parent.startedAt,
  },
  observation: {
    status: 'unobserved',
    at: null,
    eventId: null,
    invocationSha256: null,
    reason: null,
  },
  setup: 'configuration-confirmed',
  setupConfiguration: 'confirmed',
  setupCandidate: {
    operationId: eventId,
    artifact: {
      id: 'item-' + 'b'.repeat(24),
      kind: 'mcp',
      name: 'notes',
      agent: 'claude-code',
      scope: 'project',
      sha256: '9'.repeat(64),
      digestFormat: 'mcp-entry-canonical-json/1',
      configSource: 'claude-code-project',
    },
    invocationSha256: 'e'.repeat(64),
  },
};
const overview = (
  controls: McpCallControlOverviewRow[] = [controlRow],
): McpCallControlOverview => ({
  schema: 'stroq-mcp-call-controls/1',
  workspaceId: workspace,
  contextId,
  checkedAt: parent.startedAt,
  authority: 'ready',
  revision: 'f'.repeat(64),
  gaps: [],
  controls,
  hostEnforcement: false,
});
describe('MCP call-control attention independent of inventory review', () => {
  it('keeps a confirmed intentional pause quiet without inferring observation or adoption', () => {
    expect(mcpCallControlRows(overview(), workspace)).toEqual([]);
    expect(
      mcpCallControlRows(
        { ...overview([]), authority: 'missing', revision: null, gaps: ['runtime-unavailable'] },
        workspace,
      ),
    ).toEqual([]);
  });
  it('surfaces exact invocation drift, ambiguity and incomplete setup with stable control/profile links', () => {
    for (const patch of [
      { capability: 'drifted', reason: 'invocation-drift' },
      { capability: 'ambiguous', reason: 'duplicate-control' },
      { setup: 'authority-recorded', setupConfiguration: 'unconfirmed' },
      { setup: 'configuration-unconfirmed', setupConfiguration: 'unconfirmed' },
    ] as const) {
      const rows = mcpCallControlRows(overview([{ ...controlRow, ...patch }]), workspace);
      expect(rows).toHaveLength(1);
      const link = new URL(rows[0]!.href, 'http://local');
      expect(link.pathname).toBe('/skills/mcp/');
      expect(link.searchParams.get('control')).toBe(controlId);
      expect(link.searchParams.get('context')).toBe(contextId);
      expect(rows[0]!.detail).not.toContain('process stopped');
    }
  });
  it('keeps removed-registration enabled authority actionable through retained setup, while retained pause stays quiet', () => {
    const row = {
      ...controlRow,
      artifact: null,
      capability: 'missing-registration' as const,
      setupConfiguration: 'unavailable' as const,
    };
    expect(mcpCallControlRows(overview([row]), workspace)).toEqual([]);
    const rows = mcpCallControlRows(
      overview([{ ...row, current: { ...row.current!, mode: 'enabled' } }]),
      workspace,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('registration not in this view');
    expect(rows[0]!.action).toBe('Review call control');
  });
  it('rejects foreign/malformed overview and exposes bounded authority/source gaps', () => {
    expect(
      mcpCallControlRows(
        { ...overview(), workspaceId: 'workspace-' + '9'.repeat(24) },
        workspace,
      )[0]!.key,
    ).toBe('mcp-call-control-unavailable');
    expect(mcpCallControlRows({ ...overview(), private: 'bad' } as any, workspace)[0]!.key).toBe(
      'mcp-call-control-unavailable',
    );
    const rows = mcpCallControlRows(
      { ...overview([]), authority: 'unavailable', revision: null, gaps: ['source-limit'] },
      workspace,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('authority unavailable');
  });
});

describe('MCP setup journal phase and fresh configuration evidence', () => {
  it('does not keep a journal-finish partial in attention when exact candidate and native authority are confirmed', () => {
    for (const setup of ['prepared', 'authority-recorded', 'configuration-unconfirmed'] as const) {
      const state = overview([{ ...controlRow, setup, setupConfiguration: 'confirmed' }]);
      expect(mcpCallControlRows(state, workspace)).toEqual([]);
      expect(state.controls[0]!.setup).toBe(setup);
    }
  });
  it('keeps unfinished setup actionable if configuration cannot be confirmed or native authority is missing', () => {
    for (const setupConfiguration of ['unconfirmed', 'unavailable'] as const) {
      const rows = mcpCallControlRows(
        overview([{ ...controlRow, setup: 'authority-recorded', setupConfiguration }]),
        workspace,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toContain('setup needs recheck');
    }
    const invalid = mcpCallControlRows(
      overview([{ ...controlRow, setup: 'authority-recorded', setupConfiguration: null }]),
      workspace,
    );
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.key).toBe('mcp-call-control-unavailable');
    const rows = mcpCallControlRows(
      overview([
        {
          ...controlRow,
          setup: 'authority-recorded',
          setupConfiguration: 'confirmed',
          capability: 'unavailable',
          reason: 'storage-unavailable',
          current: null,
        },
      ]),
      workspace,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('setup needs recheck');
  });
  it('still surfaces missing authority after a historically confirmed setup and does not erase invocation drift', () => {
    const rows = mcpCallControlRows(
      overview([
        { ...controlRow, current: null, capability: 'unavailable', reason: 'storage-unavailable' },
      ]),
      workspace,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('authority unavailable');
    const drift = mcpCallControlRows(
      overview([
        {
          ...controlRow,
          setup: 'authority-recorded',
          setupConfiguration: 'confirmed',
          capability: 'drifted',
          reason: 'invocation-drift',
          invocationSha256: '8'.repeat(64),
        },
      ]),
      workspace,
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]!.title).toContain('invocation changed');
  });
});

import { mcpCallControlPendingRows } from './protection-check-queue';
import { callPreview } from './mcp-call-control-fixtures';
const pendingCall = () => ({
  preview: { ...callPreview(), contextId },
  startedAt: parent.startedAt,
});
describe('Protection keeps unknown MCP writes separate from passive desired state', () => {
  it('keeps a lost Pause acknowledgement actionable even when GET confirms a normal paused control', () => {
    const pending = [pendingCall()];
    expect(mcpCallControlRows(overview(), workspace)).toEqual([]);
    const rows = mcpCallControlPendingRows(pending, overview(), workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('completion unknown');
    expect(rows[0]!.context).toBe('Selected local profile');
    const href = new URL(rows[0]!.href, 'http://local');
    expect(href.searchParams.get('control')).toBe(pending[0]!.preview.controlId);
    expect(href.searchParams.get('context')).toBe(contextId);
    expect(
      mcpCallControlPendingRows(
        pending,
        { ...overview([]), authority: 'missing', revision: null },
        workspace,
      ),
    ).toHaveLength(1);
    expect(pending).toHaveLength(1);
  });
  it('labels retained unknowns from another profile and links their recorded context without promising a current-profile recheck', () => {
    const pending = [pendingCall()],
      other = { ...overview(), contextId: 'context-' + '8'.repeat(64) },
      rows = mcpCallControlPendingRows(pending, other, workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toBe('Different local profile');
    expect(rows[0]!.detail).toContain('Switch to the recorded profile');
    expect(rows[0]!.action).toBe('Inspect recorded control');
    expect(new URL(rows[0]!.href, 'http://local').searchParams.get('context')).toBe(contextId);
    expect(pending[0]!.preview.contextId).toBe(contextId);
  });
  it('keeps unknown completion visible while the current profile cannot be verified and excludes another workspace', () => {
    const pending = [pendingCall()],
      rows = mcpCallControlPendingRows(pending, null, workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toBe('Profile not verified');
    expect(mcpCallControlPendingRows(pending, overview(), 'workspace-' + '7'.repeat(24))).toEqual(
      [],
    );
    expect(mcpCallControlPendingRows(pending, overview(), null)).toEqual([]);
  });
});
