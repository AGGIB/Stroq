import { describe, expect, it } from 'vitest';
import { formatReport } from '../../src/attack/report.js';
import type { AttackReport, ScenarioResult } from '../../src/attack/run.js';

const incident = { name: 'Some incident', url: 'https://example.com/', date: '2026-05' };
const blocked: ScenarioResult = {
  id: '01-readme-pipe-to-shell',
  title: 't',
  incident,
  outcome: 'blocked',
  ok: true,
  ruleId: 'deny-encoded-exec',
  steps: [
    { phase: 'post', tool: 'Read', expect: 'suspect', actual: 'suspect', ruleId: null },
    { phase: 'pre', tool: 'Bash', expect: 'deny', actual: 'deny', ruleId: 'deny-encoded-exec' },
  ],
};
const passed: ScenarioResult = {
  ...blocked,
  id: '08-rm-rf-home',
  outcome: 'passed',
  ok: false,
  ruleId: null,
  steps: [{ phase: 'pre', tool: 'Bash', expect: 'ask', actual: 'allow', ruleId: null }],
};

const report = (scenarios: ScenarioResult[], ok: boolean): AttackReport => ({
  version: 1,
  policy: 'default',
  scenarios,
  totals: {
    blocked: scenarios.filter((s) => s.outcome === 'blocked').length,
    asked: scenarios.filter((s) => s.outcome === 'asked').length,
    passed: scenarios.filter((s) => s.outcome === 'passed').length,
  },
  ok,
});

describe('formatReport', () => {
  it('prints one line per scenario and a summary when everything was stopped', () => {
    const text = formatReport(report([blocked], true));
    expect(text).toContain('stroq attack: 1 recorded incident');
    expect(text).toContain('against policy default');
    expect(text).toMatch(
      /✔ 01-readme-pipe-to-shell\s+blocked\s+deny-encoded-exec\s+Some incident \(2026-05\)/,
    );
    expect(text).toContain(
      '1 scenario: 1 blocked, 0 asked, 0 passed through — every attack was stopped.',
    );
  });

  it('names the first mismatching step and warns when an attack got through', () => {
    const text = formatReport(report([blocked, passed], false));
    expect(text).toMatch(
      /✘ 08-rm-rf-home\s+passed\s+-\s+Some incident \(2026-05\) \(step 1 pre Bash: expected ask, got allow\)/,
    );
    expect(text).toContain('2 scenarios: 1 blocked, 0 asked, 1 passed through');
    expect(text).toContain('1 scenario did not behave as expected');
    expect(text).toContain('policies/default.yaml');
  });

  it('never claims "every attack was stopped" when a scenario passed through, even if ok is forced true', () => {
    // Synthetic: a caller-constructed report where `ok` says success but `totals.passed`
    // says an attack got through. formatReport must not trust `ok` alone for this claim.
    const text = formatReport(report([passed], true));
    expect(text).not.toContain('every attack was stopped');
  });
});
