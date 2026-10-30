import { describe, expect, it } from 'vitest';
import { validateDoctorDiagnostic } from './doctor-diagnostics';
import { validateControl, validateRun } from './control';
const hook = () => ({
  kind: 'agent-hooks',
  observations: [{ code: 'not-configured', scope: 'project', agent: 'claude-code', client: null }],
});
const run = () => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'doctor',
  status: 'completed',
  startedAt: '2026-10-23T00:00:00.000Z',
  finishedAt: '2026-10-23T00:00:01.000Z',
  result: {
    source: 'local',
    evidence: 'configuration',
    diagnosticsVersion: 1,
    ok: true,
    passed: 1,
    total: 1,
    checks: [{ id: 'check-1', label: 'Claude Code hook check', ok: true, diagnostic: hook() }],
  },
});
describe('typed recorded diagnostics', () => {
  it('keeps the platform navigation identity distinct from diagnostic provenance', () => {
    const value = {
      schema: 'stroq-control/1',
      workspaceId: `workspace-${'a'.repeat(24)}`,
      context: { workspaceId: 'b'.repeat(64), policySha256: null, runtimeSha256: null },
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      runs: [],
    };
    expect(validateControl(value)).toBe(true);
    expect(validateControl({ ...value, workspaceId: 'b'.repeat(64) })).toBe(false);
    expect(validateControl({ ...value, workspaceId: '/private/work' })).toBe(false);
  });
  it('preserves passing CLI aggregation without claiming this agent is configured', () => {
    expect(validateDoctorDiagnostic(hook())).toBe(true);
    expect(validateRun(run())).toBe(true);
  });
  it('requires complete typed checks when version is declared', () => {
    const value = run();
    expect(validateRun({ ...value, result: { ...value.result, diagnosticsVersion: 2 } })).toBe(
      false,
    );
    expect(
      validateRun({
        ...value,
        result: { ...value.result, checks: [{ id: 'check-1', label: 'Hooks', ok: true }] },
      }),
    ).toBe(false);
    const { diagnosticsVersion: _, ...legacy } = value.result;
    expect(validateRun({ ...value, result: legacy })).toBe(false);
    expect(
      validateRun({
        ...value,
        result: { ...legacy, checks: [{ id: 'check-1', label: 'Hooks', ok: true }] },
      }),
    ).toBe(true);
  });
  it('refuses free-form details, identities, unknown codes and navigation', () => {
    const value = hook();
    for (const fields of [
      { code: 'arbitrary-secret' },
      { scope: '/private/home' },
      { agent: 'unknown-agent' },
      { client: 'custom-secret' },
      { href: 'https://example.com' },
      { detail: 'private' },
    ])
      expect(
        validateDoctorDiagnostic({
          ...value,
          observations: [{ ...value.observations[0], ...fields }],
        }),
      ).toBe(false);
    expect(validateDoctorDiagnostic({ ...value, detail: 'private' })).toBe(false);
  });
  it('rejects incompatible kinds, source scopes and agent/client identities', () => {
    expect(validateDoctorDiagnostic({ ...hook(), kind: 'secret-index' })).toBe(false);
    expect(
      validateDoctorDiagnostic({
        ...hook(),
        observations: [{ ...hook().observations[0], scope: 'data' }],
      }),
    ).toBe(false);
    expect(
      validateDoctorDiagnostic({
        ...hook(),
        observations: [{ ...hook().observations[0], client: 'cursor' }],
      }),
    ).toBe(false);
    expect(
      validateDoctorDiagnostic({
        kind: 'agent-hooks',
        observations: [{ code: 'not-configured', scope: 'machine', agent: null, client: null }],
      }),
    ).toBe(true);
  });
  it('bounds observations and rejects duplicates rather than inflating the report', () => {
    expect(validateDoctorDiagnostic({ ...hook(), observations: [] })).toBe(false);
    expect(
      validateDoctorDiagnostic({ ...hook(), observations: Array(17).fill(hook().observations[0]) }),
    ).toBe(false);
    expect(
      validateDoctorDiagnostic({ ...hook(), observations: Array(2).fill(hook().observations[0]) }),
    ).toBe(false);
  });
  it('rejects a failed check with only ready facts rather than overriding its recorded failure', () => {
    const value = run();
    value.result.checks[0]!.ok = false;
    value.result.ok = false;
    value.result.passed = 0;
    value.result.checks[0]!.diagnostic.observations[0]!.code = 'ready';
    expect(validateRun(value)).toBe(false);
  });
  it('accepts explicit unavailable index and uncovered sandbox information without a pass claim', () => {
    expect(
      validateDoctorDiagnostic({
        kind: 'secret-index',
        observations: [{ code: 'not-built', scope: 'data', agent: null, client: null }],
      }),
    ).toBe(true);
    expect(
      validateDoctorDiagnostic({
        kind: 'mcp-sandbox',
        observations: [
          { code: 'sandbox-launch-conflict', scope: 'unspecified', agent: null, client: null },
        ],
      }),
    ).toBe(true);
    expect(
      validateDoctorDiagnostic({
        kind: 'mcp-sandbox',
        observations: [{ code: 'ready', scope: 'unspecified', agent: null, client: null }],
      }),
    ).toBe(false);
  });
});
