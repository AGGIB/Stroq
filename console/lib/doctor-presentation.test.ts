import { describe, expect, it } from 'vitest';
import { doctorInstallationRows, doctorSetupMissing } from './doctor-presentation';
const legacy = { checks: [{ id: 'check-1', label: 'Codex hook check', ok: true }] };
describe('recorded diagnostic presentation', () => {
  it('surfaces one recorded setup gap only when typed registrations are all absent and not peer-covered', () => {
    const absent = (agent: string, ok: boolean) => ({
      id: agent,
      label: agent,
      ok,
      diagnostic: {
        kind: 'agent-hooks',
        observations: [
          { code: 'not-configured', scope: 'project', agent, client: null },
          { code: 'not-configured', scope: 'user', agent, client: null },
        ],
      },
    });
    expect(
      doctorSetupMissing({
        diagnosticsVersion: 1,
        checks: [absent('claude-code', false), absent('cursor', false)],
      }),
    ).toBe(true);
    expect(
      doctorSetupMissing({ diagnosticsVersion: 1, checks: [absent('claude-code', true)] }),
    ).toBe(false);
    const ready = {
      ...absent('cursor', true),
      diagnostic: {
        kind: 'agent-hooks',
        observations: [{ code: 'ready', scope: 'user', agent: 'cursor', client: null }],
      },
    };
    expect(
      doctorSetupMissing({ diagnosticsVersion: 1, checks: [absent('claude-code', true), ready] }),
    ).toBe(false);
    expect(
      doctorSetupMissing({ diagnosticsVersion: 1, checks: [absent('claude-code', false), ready] }),
    ).toBe(false);
  });
  it('never derives a missing setup from legacy, mixed or malformed diagnostic evidence', () => {
    expect(doctorSetupMissing(legacy)).toBe(false);
    expect(
      doctorSetupMissing({ diagnosticsVersion: 1, checks: [{ ...legacy.checks[0]!, ok: false }] }),
    ).toBe(false);
    expect(
      doctorSetupMissing({
        diagnosticsVersion: 1,
        checks: [
          {
            ...legacy.checks[0]!,
            diagnostic: {
              kind: 'agent-hooks',
              observations: [
                { code: 'not-configured', scope: 'project', agent: 'bad', client: null },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
  });
  it('names the inferred pinned-launch conflict without claiming a measured sandbox coverage gap', () => {
    const [row] = doctorInstallationRows({
      diagnosticsVersion: 1,
      checks: [
        {
          ...legacy.checks[0]!,
          diagnostic: {
            kind: 'mcp-sandbox',
            observations: [
              { code: 'sandbox-launch-conflict', scope: 'data', agent: null, client: null },
            ],
          },
        },
      ],
    });
    expect(row?.reason).toBe('Pinned server launch conflicts with sandbox rules');
    expect(row?.attention).toBe(true);
  });
  it('distinguishes an unsupported Node version from an unsupported hook platform', () => {
    const result = (kind: string, scope: string, agent: string | null) => ({
      diagnosticsVersion: 1,
      checks: [
        {
          ...legacy.checks[0]!,
          ok: false,
          diagnostic: {
            kind,
            observations: [{ code: 'platform-unsupported', scope, agent, client: null }],
          },
        },
      ],
    });
    expect(doctorInstallationRows(result('runtime', 'runtime', null))[0]?.reason).toBe(
      'Node version is unsupported',
    );
    expect(doctorInstallationRows(result('agent-hooks', 'project', 'cursor'))[0]?.reason).toBe(
      'Unsupported on this platform',
    );
  });
  it('never turns a legacy OK result into installed or Passed', () => {
    const [row] = doctorInstallationRows(legacy);
    expect(row?.reason).toBe('Recorded OK');
    expect(row?.attention).toBe(false);
    expect(row?.legacy).toBe(true);
    expect(row?.diagnostic).toBeNull();
  });
  it('shows absent peer-covered agents as neutral not configured, never passed', () => {
    const [row] = doctorInstallationRows({
      diagnosticsVersion: 1,
      checks: [
        {
          ...legacy.checks[0]!,
          diagnostic: {
            kind: 'agent-hooks',
            observations: [
              { code: 'not-configured', scope: 'project', agent: 'codex', client: null },
            ],
          },
        },
      ],
    });
    expect(row?.reason).toBe('Not configured');
    expect(row?.attention).toBe(false);
    expect(row?.scopeLabel).toBe('Codex CLI · Workspace');
    expect(row?.legacy).toBe(false);
  });
  it('preserves per-scope actionable reasons even when the aggregate check passed', () => {
    const rows = doctorInstallationRows({
      diagnosticsVersion: 1,
      checks: [
        {
          ...legacy.checks[0]!,
          diagnostic: {
            kind: 'agent-hooks',
            observations: [
              { code: 'ready', scope: 'project', agent: 'codex', client: null },
              { code: 'approval-required', scope: 'user', agent: 'codex', client: null },
            ],
          },
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reason).toBe('Recorded ready');
    expect(rows[1]?.reason).toBe('Host approval required');
    expect(rows[1]?.attention).toBe(true);
    expect(rows[1]?.scopeLabel).toBe('Codex CLI · User');
  });
  it('falls back as a whole for partial or invalid typed reports without inventing reasons', () => {
    for (const candidate of [
      { diagnosticsVersion: 1, checks: legacy.checks },
      {
        checks: [
          {
            ...legacy.checks[0]!,
            diagnostic: {
              kind: 'agent-hooks',
              observations: [{ code: 'ready', scope: 'project', agent: 'codex', client: null }],
            },
          },
        ],
      },
      {
        diagnosticsVersion: 1,
        checks: [
          {
            ...legacy.checks[0]!,
            diagnostic: {
              kind: 'agent-hooks',
              observations: [{ code: 'bad', scope: 'project', agent: 'codex', client: null }],
            },
          },
        ],
      },
    ]) {
      expect(doctorInstallationRows(candidate)[0]?.legacy).toBe(true);
      expect(doctorInstallationRows(candidate)[0]?.reason).toBe('Recorded OK');
    }
    expect(
      doctorInstallationRows({ checks: [{ ...legacy.checks[0]!, ok: false }] })[0]?.reason,
    ).toBe('Recorded issue');
  });
});
