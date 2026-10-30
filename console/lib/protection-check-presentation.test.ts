import { describe, expect, it } from 'vitest';
import {
  protectionStageOutcome,
  protectionCheckOutcome,
  protectionStageSummary,
} from './protection-check-presentation';
import type { ControlRun } from './control';
import type { ProtectionCheckStep } from './protection-check';
const base = {
  id: 'saved-policy-checks',
  status: 'completed',
  startedAt: '2026-10-24T10:00:00.000Z',
  finishedAt: '2026-10-24T10:01:00.000Z',
  error: null,
  result: { total: 0, passed: 0, failed: 0, results: [] },
} as unknown as ProtectionCheckStep;
describe('local check presentation preserves evidence types', () => {
  it('does not call an empty saved-check set a passing protection or hide failed stages', () => {
    expect(protectionStageOutcome(base).label).toBe('No saved checks');
    expect(protectionStageOutcome({ ...base, status: 'failed', result: null }).label).toBe(
      'Could not complete',
    );
    expect(protectionStageOutcome({ ...base, status: 'skipped', result: null }).label).toBe(
      'Not run',
    );
  });
  it('retains attention after successful orchestration and never labels the host protected', () => {
    const step = { ...base, result: { total: 2, passed: 1, failed: 1 } } as ProtectionCheckStep;
    const run = {
      kind: 'protection-check',
      status: 'completed',
      progress: { steps: [step] },
    } as ControlRun;
    expect(protectionCheckOutcome(run)).toEqual({ label: 'Needs attention', tone: 'orange' });
    expect(protectionCheckOutcome({ ...run, status: 'failed' }).label).toBe('Incomplete');
    expect(protectionCheckOutcome({ ...run, status: 'cancelled' }).label).toBe('Cancelled');
    expect(protectionCheckOutcome({ ...run, progress: { steps: [base] } }).label).toBe(
      'Checks recorded',
    );
  });
  it('shows concrete producer facts before an evidence disclosure', () => {
    expect(protectionStageSummary(base)).toBe('No saved checks');
    expect(
      protectionStageSummary({
        ...base,
        result: { total: 3, passed: 2, failed: 1 },
      } as ProtectionCheckStep),
    ).toBe('1 of 3 expectations unmatched');
    expect(
      protectionStageSummary({
        ...base,
        id: 'guard-test',
        result: { attacksPassing: 2, newInterruptions: 1, notJudged: 3, violations: 4 },
      } as ProtectionCheckStep),
    ).toBe('2 attack scenarios allowed · 1 new interruptions · 3 unjudged · 4 unmet expectations');
    expect(
      protectionStageSummary({
        ...base,
        id: 'policy-check',
        result: {
          faults: 1,
          findings: [
            { severity: 'warning', count: 2 },
            { severity: 'info', count: 4 },
          ],
        },
      } as ProtectionCheckStep),
    ).toBe('1 faults · 2 findings to review');
    expect(
      protectionStageSummary({
        ...base,
        id: 'workspace-review',
        result: { complete: false, errors: 2, warnings: 3, coverage: { gaps: 4 } },
      } as ProtectionCheckStep),
    ).toBe('2 errors · 3 warnings · partial · 4 gaps');
  });
});
