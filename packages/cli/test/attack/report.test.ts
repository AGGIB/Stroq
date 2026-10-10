import { describe, expect, it } from 'vitest';
import { formatReport } from '../../src/attack/report.js';
import {
  totalsOf,
  type AttackReport,
  type ScenarioResult,
  type StepResult,
} from '../../src/attack/run.js';

const incident = { name: 'Some incident', url: 'https://example.com/', date: '2026-05' };

/** A step as the runner reports it when nothing out of the ordinary happened to it. */
const step = (
  over: Pick<StepResult, 'phase' | 'tool' | 'expect' | 'actual' | 'ruleId'>,
): StepResult => ({
  reason: null,
  signals: [],
  timedOut: false,
  ...over,
});

const blocked: ScenarioResult = {
  id: '01-readme-pipe-to-shell',
  title: 't',
  incident,
  class: null,
  outcome: 'blocked',
  inconclusive: false,
  reason: null,
  ok: true,
  ruleId: 'deny-encoded-exec',
  steps: [
    step({ phase: 'post', tool: 'Read', expect: 'suspect', actual: 'suspect', ruleId: null }),
    step({
      phase: 'pre',
      tool: 'Bash',
      expect: 'deny',
      actual: 'deny',
      ruleId: 'deny-encoded-exec',
    }),
  ],
};
const passed: ScenarioResult = {
  ...blocked,
  id: '08-rm-rf-home',
  outcome: 'passed',
  ok: false,
  ruleId: null,
  steps: [step({ phase: 'pre', tool: 'Bash', expect: 'ask', actual: 'allow', ruleId: null })],
};
const synthetic: ScenarioResult = {
  ...blocked,
  id: '13-padded-secret-exfil',
  incident: null,
  class: 'padding a known secret past the scan window',
};
const askedAtLimit: ScenarioResult = {
  ...blocked,
  id: '40-too-large',
  outcome: 'asked-by-limit',
  ruleId: 'ask-shell-unparsed',
  steps: [
    step({
      phase: 'pre',
      tool: 'Bash',
      expect: 'ask',
      actual: 'ask',
      ruleId: 'ask-shell-unparsed',
    }),
  ],
};
const timedOut: ScenarioResult = {
  ...blocked,
  id: '41-scan-budget',
  outcome: 'timeout',
  inconclusive: true,
  reason: 'step 1 (post Read): the scan ran out of its time budget',
  ok: false,
};
const errored: ScenarioResult = {
  ...blocked,
  id: '42-malformed',
  outcome: 'error',
  inconclusive: true,
  reason: 'scenario 42-malformed step 1 (PreToolUse Bash): boom',
  ok: false,
  ruleId: null,
  steps: [
    {
      phase: 'pre',
      tool: 'Bash',
      expect: 'deny',
      actual: null,
      ruleId: null,
      reason: null,
      signals: [],
      timedOut: false,
      error: 'scenario 42-malformed step 1 (PreToolUse Bash): boom',
    },
  ],
};

const report = (scenarios: ScenarioResult[], ok: boolean): AttackReport => ({
  version: 1,
  policy: 'default',
  scenarios,
  totals: totalsOf(scenarios),
  ok,
});

describe('formatReport', () => {
  it('prints one line per scenario and a summary when everything was stopped', () => {
    const text = formatReport(report([blocked], true));
    expect(text).toContain('stroq attack: 1 scenario against policy default');
    expect(text).toContain('(1 from public reports, 0 synthetic)');
    expect(text).toMatch(
      /✔ 01-readme-pipe-to-shell\s+blocked\s+deny-encoded-exec\s+Some incident \(2026-05\)/,
    );
    expect(text).toContain(
      '1 scenario: 1 blocked, 0 asked, 0 passed through — each was blocked or put to you as a question.',
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

  it('never claims each scenario was blocked or asked when one passed through, even if ok is forced true', () => {
    // Synthetic: a caller-constructed report where `ok` says success but `totals.passed`
    // says an attack got through. formatReport must not trust `ok` alone for this claim.
    const text = formatReport(report([passed], true));
    expect(text).not.toContain('each was blocked or put to you as a question');
  });

  it('renders a null incident as its class, marked synthetic, never as a citation', () => {
    const text = formatReport(report([synthetic], true));
    expect(text).toMatch(
      /✔ 13-padded-secret-exfil\s+blocked\s+deny-encoded-exec\s+padding a known secret past the scan window \(synthetic\)/,
    );
    expect(text).not.toContain('Some incident');
  });

  it('counts an ask at a limit apart, and keeps the sentence for a run that was all blocks and questions', () => {
    const text = formatReport(report([blocked, askedAtLimit], true));
    expect(text).toMatch(/✔ 40-too-large\s+asked-by-limit\s+ask-shell-unparsed/);
    expect(text).toContain(
      '2 scenarios: 1 blocked, 0 asked, 1 asked at a limit, 0 passed through — each was blocked or put to you as a question.',
    );
  });

  it('shows a scenario that could not be judged with a question mark and the reason, not as blocked', () => {
    const text = formatReport(report([blocked, timedOut, errored], false));
    expect(text).toMatch(
      /\? 41-scan-budget\s+timeout\s+deny-encoded-exec\s+Some incident \(2026-05\) \(inconclusive: step 1 \(post Read\): the scan ran out of its time budget\)/,
    );
    expect(text).toMatch(
      /\? 42-malformed\s+error\s+-\s+Some incident \(2026-05\) \(inconclusive: scenario 42-malformed step 1 \(PreToolUse Bash\): boom\)/,
    );
    expect(text).not.toMatch(/✔ 41-scan-budget/);
    expect(text).not.toMatch(/✘ 41-scan-budget/);
  });

  it('says in the summary how many could not be judged, and never that each was blocked or asked', () => {
    const text = formatReport(report([blocked, timedOut, errored], false));
    expect(text).toContain(
      '3 scenarios: 1 blocked, 0 asked, 0 passed through, 1 timed out, 1 errored',
    );
    expect(text).toContain('2 scenarios could not be judged');
    expect(text).not.toContain('each was blocked or put to you as a question');
    // They are not the policy being weak: nothing in them says it is.
    expect(text).not.toContain('did not behave as expected');
  });

  it('keeps an inconclusive scenario and a wrong one apart when both are in the run', () => {
    const text = formatReport(report([timedOut, passed], false));
    expect(text).toContain('1 scenario could not be judged');
    expect(text).toContain('1 scenario did not behave as expected');
  });

  it('shows an attack that passed after an earlier step timed out as passed, and inconclusive', () => {
    const both: ScenarioResult = {
      ...passed,
      id: '43-both',
      inconclusive: true,
      reason: 'step 1 (post Read): the scan ran out of its time budget',
    };
    const text = formatReport(report([both], false));
    expect(text).toMatch(/\? 43-both\s+passed\s+-/);
    expect(text).toContain('1 passed through');
    expect(text).toContain('1 scenario could not be judged');
  });
});
