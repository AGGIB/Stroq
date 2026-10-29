import { describe, expect, it } from 'vitest';
import { hookCheckEvidence } from './hook-check-evidence';
import { validateHookCheckState, type HookCheckJob, type HookCheckState } from './hook-checks';

const workspaceId = `workspace-${'a'.repeat(24)}`;
const otherWorkspace = `workspace-${'f'.repeat(24)}`;
const startedAt = '2026-10-24T00:00:00.000Z';
const laterAt = '2026-10-24T00:01:00.000Z';
const binding = {
  workspaceId,
  agent: 'cursor' as const,
  scope: 'project' as const,
  sourceSha256: 'b'.repeat(64),
  policySha256: null,
  policySemanticSha256: 'c'.repeat(64),
  runtimeSha256: 'd'.repeat(64),
};
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
function passed(): HookCheckJob {
  return {
    schema: 'stroq-hook-check-job/1',
    id: '11111111-1111-4111-8111-111111111111',
    previewId: '22222222-2222-4222-8222-222222222222',
    binding: { ...binding },
    status: 'completed',
    startedAt,
    finishedAt: '2026-10-24T00:00:01.000Z',
    result: {
      status: 'passed',
      probes: [probe('ordinary', 'allow'), probe('encoded-fetch', 'deny')],
      standard: { ordinaryAllowed: true, encodedDenied: true },
      evidence: 'isolated-hook-execution',
      isolated: true,
      providerRequests: 0,
      hostEnforcement: false,
    },
  };
}
function attempt(status: 'running' | 'failed' | 'cancelled'): HookCheckJob {
  return {
    schema: 'stroq-hook-check-job/1',
    id: '33333333-3333-4333-8333-333333333333',
    previewId: '44444444-4444-4444-8444-444444444444',
    binding: { ...binding },
    status,
    startedAt: laterAt,
    ...(status === 'running'
      ? {}
      : {
          finishedAt: '2026-10-24T00:01:01.000Z',
          error: status === 'failed' ? ('server-stopped' as const) : ('cancelled' as const),
        }),
  };
}
function state(jobs: HookCheckJob[] = []): HookCheckState {
  const value: HookCheckState = {
    schema: 'stroq-hook-checks/1',
    workspaceId,
    engine: { available: true, version: '0.28.0' },
    agents: ['claude-code', 'cursor', 'codex'].map((id) => ({
      id: id as HookCheckState['agents'][number]['id'],
      supported: true,
      reason: null,
    })),
    history: { status: 'ready' },
    jobs,
  };
  expect(validateHookCheckState(value)).toBe(true);
  return value;
}

describe('recorded offline hook evidence', () => {
  it('does not turn a captured pass into current or native protection', () => {
    const job = passed();
    const report = state([job]);
    const summary = hookCheckEvidence(report, workspaceId, 'cursor', 'project');
    expect(summary).toEqual({
      status: 'passed',
      label: 'Recorded pass',
      tone: 'muted',
      recordedAt: job.finishedAt,
      job,
    });
    expect(Object.keys(summary)).not.toContain('protected');
    expect(report.jobs[0]?.result?.hostEnforcement).toBe(false);
  });

  it.each(['running', 'failed', 'cancelled'] as const)(
    'keeps a newer %s attempt instead of an older pass, regardless of array order',
    (status) => {
      const latest = attempt(status);
      for (const jobs of [
        [passed(), latest],
        [latest, passed()],
      ]) {
        const summary = hookCheckEvidence(state(jobs), workspaceId, 'cursor', 'project');
        expect(summary.status).toBe(status);
        expect(summary.job?.id).toBe(latest.id);
        expect(summary.label).not.toBe('Recorded pass');
        expect(summary.recordedAt).toBe(latest.finishedAt ?? latest.startedAt);
      }
    },
  );

  it('reports a matching permissive policy as attention and a mismatch as mismatch', () => {
    const attention = passed();
    attention.result!.status = 'attention';
    attention.result!.probes[1] = probe('encoded-fetch', 'allow');
    attention.result!.standard.encodedDenied = false;
    expect(hookCheckEvidence(state([attention]), workspaceId, 'cursor', 'project')).toMatchObject({
      status: 'attention',
      label: 'Recorded attention',
      tone: 'orange',
    });
    const mismatch = passed();
    mismatch.result!.status = 'failed';
    Object.assign(mismatch.result!.probes[1], {
      observedEffect: null,
      auditConfirmed: false,
      matched: false,
    });
    mismatch.result!.standard.encodedDenied = false;
    expect(hookCheckEvidence(state([mismatch]), workspaceId, 'cursor', 'project')).toMatchObject({
      status: 'mismatch',
      label: 'Recorded mismatch',
      tone: 'red',
    });
  });

  it('separates exact agent and scope instead of borrowing another captured pass', () => {
    const report = state([passed()]);
    for (const selected of [
      ['cursor', 'user'],
      ['claude-code', 'project'],
    ] as const)
      expect(hookCheckEvidence(report, workspaceId, selected[0], selected[1])).toMatchObject({
        status: 'not-checked',
        job: null,
        recordedAt: null,
      });
  });

  it('refuses unknown, foreign or malformed state rather than inspecting foreign jobs', () => {
    const report = state([passed()]);
    for (const [value, selectedWorkspace] of [
      [null, workspaceId],
      [report, null],
      [report, otherWorkspace],
      [
        {
          ...report,
          jobs: [{ ...passed(), binding: { ...binding, workspaceId: otherWorkspace } }],
        },
        workspaceId,
      ],
    ] as const)
      expect(
        hookCheckEvidence(value as HookCheckState | null, selectedWorkspace, 'cursor', 'project'),
      ).toMatchObject({ status: 'unavailable', job: null, recordedAt: null });
  });

  it.each(['error', 'disabled'] as const)(
    'never shows an old pass when history is %s',
    (status) => {
      const report = state([passed()]);
      report.history = { status, ...(status === 'error' ? { error: 'invalid-history' } : {}) };
      expect(hookCheckEvidence(report, workspaceId, 'cursor', 'project')).toMatchObject({
        status: 'unavailable',
        tone: 'orange',
        job: null,
        recordedAt: null,
      });
    },
  );

  it('retains a recorded result when the engine is now unavailable, without offering current proof', () => {
    const report = state([passed()]);
    report.engine = { available: false, version: null };
    expect(hookCheckEvidence(report, workspaceId, 'cursor', 'project').status).toBe('passed');
    report.jobs = [];
    expect(hookCheckEvidence(report, workspaceId, 'cursor', 'project')).toMatchObject({
      status: 'unavailable',
      label: 'Check engine unavailable',
      job: null,
    });
  });

  it('separates platform support from a check that has never been recorded', () => {
    const report = state();
    expect(hookCheckEvidence(report, workspaceId, 'cursor', 'project')).toMatchObject({
      status: 'not-checked',
      label: 'Not checked',
      tone: 'muted',
    });
    report.agents = report.agents.map((agent) => ({
      ...agent,
      supported: false,
      reason: 'platform-unsupported',
    }));
    expect(hookCheckEvidence(report, workspaceId, 'cursor', 'project')).toMatchObject({
      status: 'unavailable',
      label: 'Platform unsupported',
      job: null,
    });
  });

  it('does not prefer a pass when timestamps cannot order a failed attempt', () => {
    const failed = attempt('failed');
    failed.startedAt = startedAt;
    for (const jobs of [
      [passed(), failed],
      [failed, passed()],
    ])
      expect(hookCheckEvidence(state(jobs), workspaceId, 'cursor', 'project').job?.id).toBe(
        failed.id,
      );
  });
});
