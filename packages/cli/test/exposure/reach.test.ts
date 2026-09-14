import { describe, expect, it } from 'vitest';
import type { AttackReport } from '../../src/attack/run.js';
import { reachFindings, reachFrom } from '../../src/exposure/reach.js';

const report = (blocked: number, asked: number, passed: number): AttackReport => ({
  version: 1,
  policy: 'default',
  scenarios: [],
  totals: { blocked, asked, passed },
  ok: passed === 0,
});

describe('reachFrom', () => {
  it('counts every scenario as reaching the user when no agent is protected', () => {
    const reach = reachFrom(report(9, 4, 0), [
      { agent: 'cursor', detected: true, protected: false },
    ]);
    expect(reach.anyAgentProtected).toBe(false);
    expect(reach.total).toBe(13);
    expect(reach.passedPolicy).toBe(13);
  });

  it('ignores an undetected agent that somehow carries a hook', () => {
    const reach = reachFrom(report(9, 4, 0), [
      { agent: 'cursor', detected: false, protected: true },
    ]);
    expect(reach.anyAgentProtected).toBe(false);
    expect(reach.passedPolicy).toBe(13);
  });

  it('falls back to the policy result when at least one agent is protected', () => {
    const reach = reachFrom(report(9, 4, 0), [
      { agent: 'cursor', detected: true, protected: true },
    ]);
    expect(reach.anyAgentProtected).toBe(true);
    expect(reach.passedPolicy).toBe(0);
  });

  it('reports a policy that lets scenarios through even when an agent is protected', () => {
    expect(
      reachFrom(report(8, 4, 1), [{ agent: 'codex', detected: true, protected: true }]).passedPolicy,
    ).toBe(1);
  });
});

describe('reachFindings', () => {
  it('raises a critical finding when nothing is enforced anywhere', () => {
    const findings = reachFindings({ total: 13, passedPolicy: 13, anyAgentProtected: false });
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.class).toBe('incident-reaches-you');
    expect(findings[0]?.detail).toContain('13');
  });

  it('raises a high finding when the policy lets some through', () => {
    expect(
      reachFindings({ total: 13, passedPolicy: 2, anyAgentProtected: true })[0]?.severity,
    ).toBe('high');
  });

  it('raises nothing when the policy stops everything and an agent is protected', () => {
    expect(reachFindings({ total: 13, passedPolicy: 0, anyAgentProtected: true })).toHaveLength(0);
  });
});
