import { describe, expect, it } from 'vitest';
import { AGENT_NAMES, validateAgentStatus, type AgentStatusState } from './agent-status';
import { hookCheckRows } from './hook-check-queue';
import { validateHookCheckState, type HookCheckJob, type HookCheckState } from './hook-checks';

const workspaceId = `workspace-${'a'.repeat(24)}`;
const stamp = '2026-10-24T00:00:00.000Z';
const id = '11111111-1111-4111-8111-111111111111';
function agents(configured = false): AgentStatusState {
  return {
    schema: 'stroq-agents/1',
    source: 'local',
    generatedAt: stamp,
    agents: (Object.keys(AGENT_NAMES) as (keyof typeof AGENT_NAMES)[]).map((agent) => ({
      id: agent,
      hostVersion: null,
      scopes: (['project', 'user'] as const).map((scope) => ({
        scope,
        state: configured && agent === 'claude-code' && scope === 'project' ? 'present' : 'missing',
        reason: 'hooks-missing',
        events: [],
        approval: agent === 'codex' ? 'unknown' : 'not-required',
        recordedAt: null,
      })),
      observation: { scope: 'machine', lastHookAt: null, state: 'missing' },
      proof: {
        scope: 'machine',
        state: 'missing',
        checkedAt: null,
        hostVersion: null,
        freshness: 'not-checked',
        reason: 'no-live-proof',
      },
    })),
  };
}
function job(status: HookCheckJob['status'] = 'running'): HookCheckJob {
  return {
    schema: 'stroq-hook-check-job/1',
    id,
    previewId: '22222222-2222-4222-8222-222222222222',
    binding: {
      workspaceId,
      agent: 'claude-code',
      scope: 'project',
      sourceSha256: 'a'.repeat(64),
      policySha256: null,
      policySemanticSha256: 'b'.repeat(64),
      runtimeSha256: 'c'.repeat(64),
    },
    status,
    startedAt: stamp,
    ...(status === 'running'
      ? {}
      : {
          finishedAt: stamp,
          error: status === 'cancelled' ? ('cancelled' as const) : ('server-stopped' as const),
        }),
  };
}
function state(jobs: HookCheckJob[] = []): HookCheckState {
  const value: HookCheckState = {
    schema: 'stroq-hook-checks/1',
    workspaceId,
    engine: { available: true, version: '0.28.0' },
    agents: (Object.keys(AGENT_NAMES) as (keyof typeof AGENT_NAMES)[]).map((id) => ({
      id,
      supported: true,
      reason: null,
    })),
    history: { status: 'ready' },
    jobs,
  };
  expect(validateHookCheckState(value)).toBe(true);
  return value;
}

describe('recorded Stroq hook evidence in the work queue', () => {
  it('keeps first run quiet for supported agents with no configured hook', () => {
    expect(validateAgentStatus(agents())).toBe(true);
    expect(hookCheckRows(state(), agents(), workspaceId)).toEqual([]);
    expect(hookCheckRows(state(), null, workspaceId)).toEqual([]);
  });
  it('offers an explicit first check only for configured scopes', () => {
    const rows = hookCheckRows(state(), agents(true), workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: 'muted',
      action: 'Test Stroq hook',
      href: `/agents/hooks/?workspace=${workspaceId}&agent=claude-code&scope=project`,
    });
  });
  it.each(['running', 'failed', 'cancelled'] as const)(
    'links the exact latest %s attempt even when setup was removed',
    (status) => {
      const rows = hookCheckRows(state([job(status)]), agents(), workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tone: status === 'running' ? 'muted' : 'orange',
        href: `/agents/hooks/?workspace=${workspaceId}&job=${id}`,
      });
      expect(rows[0]?.detail).toContain(stamp);
      expect(rows[0]?.detail).toContain('isolated');
    },
  );
  it('does not invent empty healthy history from missing, foreign or failed state', () => {
    for (const value of [
      null,
      { ...state(), workspaceId: `workspace-${'b'.repeat(24)}` },
      { ...state(), history: { status: 'error' as const, error: 'invalid-history' } },
    ]) {
      const rows = hookCheckRows(value, agents(), workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tone: 'orange', href: '/agents/hooks/' });
    }
  });
  it('shows unavailable runtime once instead of making four supported agents look broken', () => {
    const value = state();
    value.engine = { available: false, version: null };
    const rows = hookCheckRows(value, agents(true), workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toMatch(/runtime unavailable/);
  });
  it('keeps unsupported configured sources visible as one platform gap without inventing setup issues', () => {
    const value = state();
    value.agents = value.agents.map((agent) => ({
      ...agent,
      supported: false,
      reason: 'platform-unsupported',
    }));
    expect(validateHookCheckState(value)).toBe(true);
    expect(hookCheckRows(value, agents(), workspaceId)).toEqual([]);
    const rows = hookCheckRows(value, agents(true), workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: 'orange',
      title: 'Stroq hook checks unavailable on this platform',
    });
    value.engine = { available: false, version: null };
    expect(hookCheckRows(value, agents(true), workspaceId)).toHaveLength(1);
  });
  it('keeps a historical pass out of attention without promoting native protection', () => {
    const value = job();
    const probe = (id: 'ordinary' | 'encoded-fetch', effect: 'allow' | 'deny') => ({
      id,
      expectedEffect: effect,
      expectedWire: effect,
      observedEffect: effect,
      wireEffect: effect,
      auditConfirmed: true,
      exitCode: 0,
      durationMs: 1,
      matched: true,
    });
    Object.assign(value, {
      status: 'completed',
      finishedAt: stamp,
      result: {
        status: 'passed',
        probes: [probe('ordinary', 'allow'), probe('encoded-fetch', 'deny')],
        standard: { ordinaryAllowed: true, encodedDenied: true },
        evidence: 'isolated-hook-execution',
        isolated: true,
        providerRequests: 0,
        hostEnforcement: false,
      },
    });
    const report = state([value]);
    expect(hookCheckRows(report, agents(true), workspaceId)).toEqual([]);
    const latest = job('failed');
    latest.id = '33333333-3333-4333-8333-333333333333';
    latest.startedAt = '2026-10-24T00:01:00.000Z';
    latest.finishedAt = latest.startedAt;
    expect(hookCheckRows(state([value, latest]), agents(true), workspaceId)[0]?.href).toContain(
      latest.id,
    );
  });
  it('keeps attention and mismatched wire/audit results as different severities', () => {
    const probe = (id: 'ordinary' | 'encoded-fetch', effect: 'allow' | 'deny') => ({
      id,
      expectedEffect: effect,
      expectedWire: effect,
      observedEffect: effect,
      wireEffect: effect,
      auditConfirmed: true,
      exitCode: 0,
      durationMs: 1,
      matched: true,
    });
    const value = job();
    Object.assign(value, {
      status: 'completed',
      finishedAt: stamp,
      result: {
        status: 'attention',
        probes: [probe('ordinary', 'allow'), probe('encoded-fetch', 'allow')],
        standard: { ordinaryAllowed: true, encodedDenied: false },
        evidence: 'isolated-hook-execution',
        isolated: true,
        providerRequests: 0,
        hostEnforcement: false,
      },
    });
    expect(hookCheckRows(state([value]), agents(), workspaceId)[0]?.tone).toBe('orange');
    value.result!.status = 'failed';
    Object.assign(value.result!.probes[1], {
      observedEffect: null,
      auditConfirmed: false,
      matched: false,
    });
    expect(hookCheckRows(state([value]), agents(), workspaceId)[0]?.tone).toBe('red');
  });
});
