import { describe, expect, it } from 'vitest';
import {
  validateControl,
  validateRun,
  contentBytes,
  runMatchesContext,
  latestContextRun,
  controlRunOwned,
  type ControlRun,
  type ControlState,
} from './control';

const context = {
  workspaceId: 'a'.repeat(64),
  policySha256: 'b'.repeat(64),
  runtimeSha256: 'c'.repeat(64),
};

const running = {
  id: 'ae3cc9ae-532e-43aa-93c4-e1775830c8e7',
  kind: 'doctor',
  status: 'running',
  startedAt: '2026-10-23T01:02:03.000Z',
};
const completed = {
  ...running,
  status: 'completed',
  finishedAt: '2026-10-23T01:02:04.000Z',
  result: {
    source: 'local',
    evidence: 'configuration',
    ok: false,
    passed: 0,
    total: 1,
    checks: [{ id: 'check-1', label: 'Agent hooks', ok: false }],
  },
};
describe('local control evidence boundary', () => {
  it('binds active ownership to an exact running record without inferring a foreign worker stopped', () => {
    const state: ControlState = {
      schema: 'stroq-control/1',
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      context,
      activeRunId: running.id,
      activeProtectionCheckId: null,
      runs: [running as ControlRun],
    };
    expect(validateControl(state)).toBe(true);
    expect(controlRunOwned(state.runs[0]!, state)).toBe(true);
    const observed = { ...state, activeRunId: null };
    expect(validateControl(observed)).toBe(true);
    expect(controlRunOwned(state.runs[0]!, observed)).toBe(false);
    expect(observed.runs[0]!.status).toBe('running');
    for (const activeRunId of [false, 3, '', 'not-a-uuid', completed.id + '-other'])
      expect(validateControl({ ...state, activeRunId })).toBe(false);
    expect(validateControl({ ...state, runs: [completed] })).toBe(false);
    expect(validateControl({ ...state, activeProtectionCheckId: running.id })).toBe(false);
  });
  it('keeps compatibility with a server that predates generic ownership', () => {
    const legacy: ControlState = {
      schema: 'stroq-control/1',
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      context,
      runs: [running as ControlRun],
    };
    expect(validateControl(legacy)).toBe(true);
    expect(controlRunOwned(legacy.runs[0]!, legacy)).toBe(true);
    expect(controlRunOwned(completed as ControlRun, legacy)).toBe(false);
    expect(controlRunOwned(legacy.runs[0]!, null)).toBe(false);
  });
  it('accepts incomplete configuration evidence without calling the host protected', () => {
    expect(validateRun(running)).toBe(true);
    expect(validateRun(completed)).toBe(true);
    expect(
      validateControl({
        schema: 'stroq-control/1',
        engine: { available: true, version: '0.28.0' },
        history: { status: 'ready' },
        context,
        runs: [completed],
      }),
    ).toBe(true);
  });
  it('rejects premature results, contradictory counts, and unknown protection claims', () => {
    expect(validateRun({ ...running, result: completed.result })).toBe(false);
    expect(validateRun({ ...completed, result: { ...completed.result, passed: 1 } })).toBe(false);
    expect(validateRun({ ...completed, result: { ...completed.result, protected: true } })).toBe(
      false,
    );
    expect(
      validateRun({ ...completed, result: { ...completed.result, evidence: 'live-proof' } }),
    ).toBe(false);
  });
  it('requires results to match the requested operation and rejects raw input leaks', () => {
    expect(validateRun({ ...completed, kind: 'content-scan' })).toBe(false);
    expect(
      validateRun({ ...completed, result: { ...completed.result, raw: 'sensitive data' } }),
    ).toBe(false);
    expect(
      validateRun({
        ...completed,
        result: {
          ...completed.result,
          checks: [{ ...completed.result.checks[0], detail: 'secret' }],
        },
      }),
    ).toBe(false);
  });
  it('requires terminal timestamps and safe, known failure codes', () => {
    expect(
      validateRun({
        ...running,
        status: 'failed',
        finishedAt: completed.finishedAt,
        error: 'deadline-exceeded',
      }),
    ).toBe(true);
    expect(validateRun({ ...running, status: 'failed', error: 'deadline-exceeded' })).toBe(false);
    expect(
      validateRun({
        ...running,
        status: 'failed',
        finishedAt: completed.finishedAt,
        error: 'raw command output',
      }),
    ).toBe(false);
    expect(validateRun({ ...completed, finishedAt: '2026-10-22T01:02:03.000Z' })).toBe(false);
  });
  it('rejects duplicates, unbounded results, unknown versions and malformed dates', () => {
    const state = {
      schema: 'stroq-control/1',
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      context,
      runs: [completed],
    };
    expect(validateControl({ ...state, runs: [completed, completed] })).toBe(false);
    expect(validateControl({ ...state, schema: 'stroq-control/2' })).toBe(false);
    expect(validateRun({ ...running, startedAt: '2026-02-31T01:02:03.000Z' })).toBe(false);
    expect(
      validateRun({
        ...completed,
        result: {
          ...completed.result,
          checks: Array(129).fill(completed.result.checks[0]),
          total: 129,
        },
      }),
    ).toBe(false);
  });
  it('keeps clean scan, incomplete scan and simulation evidence distinct', () => {
    const scan = {
      ...completed,
      kind: 'content-scan',
      result: {
        source: 'local',
        evidence: 'content-scan',
        target: 'skill',
        verdict: 'clean',
        score: 0,
        timedOut: false,
        matches: [],
        characters: 12,
        sha256: 'a'.repeat(64),
      },
    };
    expect(validateRun(scan)).toBe(true);
    expect(validateRun({ ...scan, result: { ...scan.result, timedOut: true } })).toBe(true);
    expect(validateRun({ ...scan, result: { ...scan.result, sha256: 'not a digest' } })).toBe(
      false,
    );
    expect(validateRun({ ...scan, result: { ...scan.result, verdict: 'safe' } })).toBe(false);
    const policy = {
      ...completed,
      kind: 'guard-test',
      result: {
        source: 'local',
        evidence: 'simulation',
        ok: true,
        replayed: { attack: 12, ordinary: 10, cases: 22 },
        attacksPassing: 0,
        newInterruptions: 0,
        relieved: 0,
        violations: 0,
        notJudged: 0,
      },
    };
    expect(validateRun(policy)).toBe(true);
    expect(validateRun({ ...policy, result: { ...policy.result, replayed: {} } })).toBe(false);
    expect(
      validateRun({ ...policy, result: { ...policy.result, evidence: 'configuration' } }),
    ).toBe(false);
  });
  it('counts content by UTF-8 bytes, including multibyte characters', () => {
    expect(contentBytes('a')).toBe(1);
    expect(contentBytes('я')).toBe(2);
    expect(contentBytes('🔒')).toBe(4);
  });

  it('old, unbound and unknown-context runs cannot establish current diagnostics', () => {
    const current = { ...completed, provenance: context };
    expect(validateRun(current)).toBe(true);
    expect(runMatchesContext(current, context)).toBe(true);
    expect(runMatchesContext(completed, context)).toBe(false);
    for (const key of ['workspaceId', 'policySha256', 'runtimeSha256']) {
      const other = { ...context, [key]: 'd'.repeat(64) };
      expect(runMatchesContext(current, other)).toBe(false);
    }
    expect(runMatchesContext(current, { ...context, policySha256: null })).toBe(false);
    expect(
      runMatchesContext({ ...current, provenance: { ...context, runtimeSha256: null } }, context),
    ).toBe(false);
    expect(validateRun({ ...current, provenance: { ...context, path: '/private' } })).toBe(false);
    expect(validateRun({ ...current, provenance: { ...context, workspaceId: '../private' } })).toBe(
      false,
    );
  });

  it('latest matching diagnostics never fall back to a successful check from another context', () => {
    const success = {
      ...completed,
      id: 'ad3cc9ae-532e-43aa-93c4-e1775830c8e7',
      provenance: { ...context, workspaceId: 'd'.repeat(64) },
    };
    const current = { ...completed, provenance: context };
    expect(latestContextRun([success, current], 'doctor', context)).toEqual(current);
    expect(latestContextRun([success, completed], 'doctor', context)).toBeUndefined();
    expect(
      latestContextRun([current], 'doctor', { ...context, runtimeSha256: null }),
    ).toBeUndefined();
  });
});
