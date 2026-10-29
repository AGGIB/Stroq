import { describe, expect, it } from 'vitest';
import {
  validateHookCheckJob,
  validateHookCheckPreview,
  validateHookCheckResult,
  validateHookCheckState,
} from './hook-checks';

const digest = 'a'.repeat(64);
const binding = {
  workspaceId: `workspace-${'b'.repeat(24)}`,
  agent: 'cursor',
  scope: 'project',
  sourceSha256: digest,
  policySha256: null,
  policySemanticSha256: digest,
  runtimeSha256: digest,
};
const probe = (id: string, effect: string) => ({
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
const result = () => ({
  status: 'passed',
  probes: [probe('ordinary', 'allow'), probe('encoded-fetch', 'deny')],
  standard: { ordinaryAllowed: true, encodedDenied: true },
  evidence: 'isolated-hook-execution',
  isolated: true,
  providerRequests: 0,
  hostEnforcement: false,
});
const job = () => ({
  schema: 'stroq-hook-check-job/1',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  binding,
  status: 'completed',
  startedAt: '2026-10-23T00:00:00.000Z',
  finishedAt: '2026-10-23T00:00:01.000Z',
  result: result(),
});

describe('isolated hook-check boundary', () => {
  it('accepts captured derived reports without claiming host enforcement', () =>
    expect(validateHookCheckJob(job())).toBe(true));
  it('requires audit evidence, exact probe IDs and derived matches', () => {
    for (const change of [
      { auditConfirmed: false },
      { observedEffect: null },
      { wireEffect: 'unreadable' },
      { id: 'invented' },
    ]) {
      const value = result();
      Object.assign(value.probes[0]!, change);
      expect(validateHookCheckResult(value)).toBe(false);
    }
  });
  it('rejects invented host proof, request usage and raw data', () => {
    for (const change of [
      { hostEnforcement: true },
      { providerRequests: 1 },
      { stdout: 'private' },
      { evidence: 'live' },
    ])
      expect(validateHookCheckResult({ ...result(), ...change })).toBe(false);
  });
  it('refuses contradictory exit codes or unaudited observed decisions', () => {
    const value = job();
    value.result.probes[1]!.exitCode = 2;
    expect(validateHookCheckJob(value)).toBe(false);
    const unaudited = result();
    Object.assign(unaudited.probes[1]!, { auditConfirmed: false, matched: false });
    unaudited.status = 'failed';
    unaudited.standard.encodedDenied = false;
    expect(validateHookCheckResult(unaudited)).toBe(false);
  });
  it('derives attention for a matching permissive policy', () => {
    const value = result();
    value.probes[1] = probe('encoded-fetch', 'allow');
    value.status = 'attention';
    value.standard.encodedDenied = false;
    expect(validateHookCheckResult(value)).toBe(true);
    expect(validateHookCheckResult({ ...value, status: 'passed' })).toBe(false);
  });
  it('derives failed when a response or audit does not match', () => {
    const value = result();
    Object.assign(value.probes[1]!, {
      observedEffect: null,
      auditConfirmed: false,
      matched: false,
    });
    value.standard.encodedDenied = false;
    value.status = 'failed';
    expect(validateHookCheckResult(value)).toBe(true);
  });
  it('does not accept impossible lifecycle, arbitrary errors or unbound results', () => {
    expect(validateHookCheckJob({ ...job(), status: 'running' })).toBe(false);
    expect(validateHookCheckJob({ ...job(), binding: { ...binding, workspaceId: 'other' } })).toBe(
      false,
    );
    const { result: _result, ...failed } = job();
    expect(validateHookCheckJob({ ...failed, status: 'failed', error: '/private/path' })).toBe(
      false,
    );
    expect(validateHookCheckJob({ ...failed, status: 'failed', error: 'cleanup-failed' })).toBe(
      true,
    );
  });
  it('binds preview identity and refuses expired intervals or missing readiness evidence', () => {
    const value = {
      schema: 'stroq-hook-check-preview/1',
      id: job().id,
      agent: 'cursor',
      scope: 'project',
      createdAt: job().startedAt,
      expiresAt: '2026-10-23T00:02:00.000Z',
      engineVersion: '0.28.0',
      canStart: true,
      reason: null,
      binding,
    };
    expect(validateHookCheckPreview(value)).toBe(true);
    for (const change of [
      { binding: null },
      { agent: 'codex' },
      { expiresAt: value.createdAt },
      { reason: 'policy-unavailable' },
    ])
      expect(validateHookCheckPreview({ ...value, ...change })).toBe(false);
  });
  it('requires every unique agent support and bounded unique history', () => {
    const state = {
      schema: 'stroq-hook-checks/1',
      workspaceId: binding.workspaceId,
      engine: { available: true, version: '0.28.0' },
      agents: ['claude-code', 'codex', 'cursor'].map((id) => ({
        id,
        supported: true,
        reason: null,
      })),
      history: { status: 'ready' },
      jobs: [job()],
    };
    expect(validateHookCheckState(state)).toBe(true);
    expect(validateHookCheckState({ ...state, jobs: [job(), job()] })).toBe(false);
    expect(validateHookCheckState({ ...state, agents: state.agents.slice(1) })).toBe(false);
    expect(
      validateHookCheckState({
        ...state,
        agents: [...state.agents, { id: 'windsurf', supported: true, reason: null }],
      }),
    ).toBe(false);
  });
});
