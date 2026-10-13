import { describe, expect, it } from 'vitest';
import type { ScenarioRecord, StepRecord, Suite } from '../../src/policy/records.js';
import { buildTestReport } from '../../src/policy/test-report.js';

const step = (
  n: number,
  verdict: StepRecord['verdict'],
  extra: Partial<StepRecord> = {},
): StepRecord => ({
  step: n,
  phase: 'pre',
  tool: 'Bash',
  verdict,
  kind: 'decided',
  ruleId: null,
  subject: '',
  ...extra,
});

const scenario = (
  suite: Suite,
  id: string,
  steps: readonly StepRecord[],
  extra: Partial<ScenarioRecord> = {},
): ScenarioRecord => ({
  suite,
  id,
  steps,
  inconclusive: false,
  attack: false,
  passed: false,
  ...extra,
});

const attack = (
  id: string,
  verdict: StepRecord['verdict'],
  suite: Suite = 'attack',
): ScenarioRecord =>
  scenario(suite, id, [step(1, verdict, { expect: 'deny' })], {
    attack: true,
    passed: verdict === 'allow',
  });

const report = (
  baseline: readonly ScenarioRecord[],
  candidate: readonly ScenarioRecord[],
  maxNewInterruptions: number | null = null,
) =>
  buildTestReport({
    candidate: { source: 'cand.yaml', sha256: 'c'.repeat(64) },
    baseline: { source: 'default', sha256: 'b'.repeat(64) },
    baselineRecords: baseline,
    candidateRecords: candidate,
    maxNewInterruptions,
  });

describe('buildTestReport: a policy against itself', () => {
  const records = [
    attack('01-a', 'deny'),
    scenario('ordinary', 'o1', [step(1, 'allow')]),
    scenario('ordinary', 'o2', [step(1, 'ask')]),
  ];

  it('has no change, no pass, no interruption, and is ok', () => {
    const r = report(records, records);
    expect(r).toMatchObject({
      version: 1,
      ok: true,
      changes: [],
      attacksPassing: [],
      newInterruptions: [],
      relieved: [],
      violations: [],
      notJudged: [],
      failures: [],
      replayed: { attack: 1, ordinary: 2, cases: 0 },
    });
  });
});

describe('buildTestReport: attacks that pass', () => {
  it('names an attack the candidate lets through that the baseline stopped, with its step', () => {
    const r = report([attack('05-x', 'deny')], [attack('05-x', 'allow')]);
    expect(r.attacksPassing).toEqual([{ suite: 'attack', id: '05-x', step: 1, new: true }]);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['1 attack passes']);
  });

  it('says an attack that the baseline let through as well is not new, and still fails', () => {
    const r = report([attack('05-x', 'allow')], [attack('05-x', 'allow')]);
    expect(r.attacksPassing).toEqual([{ suite: 'attack', id: '05-x', step: 1, new: false }]);
    expect(r.ok).toBe(false);
  });

  it('names the last step of a longer attack', () => {
    const long = (verdict: StepRecord['verdict']): ScenarioRecord =>
      scenario(
        'attack',
        '09-two',
        [step(1, 'clean', { phase: 'post' }), step(2, verdict, { expect: 'deny' })],
        { attack: true, passed: verdict === 'allow' },
      );
    expect(report([long('deny')], [long('allow')]).attacksPassing[0]?.step).toBe(2);
  });

  it('counts an attack of the person’s own cases as well', () => {
    const r = report([attack('mine', 'deny', 'cases')], [attack('mine', 'allow', 'cases')]);
    expect(r.attacksPassing).toEqual([{ suite: 'cases', id: 'mine', step: 1, new: true }]);
  });

  it('does not count an attack the candidate asks about instead of denying', () => {
    const r = report([attack('05-x', 'deny')], [attack('05-x', 'ask')]);
    expect(r.attacksPassing).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.changes).toHaveLength(1);
  });

  it('pluralizes the reason', () => {
    const r = report(
      [attack('a', 'deny'), attack('b', 'deny')],
      [attack('a', 'allow'), attack('b', 'allow')],
    );
    expect(r.failures).toEqual(['2 attacks pass']);
  });
});

describe('buildTestReport: interruptions of ordinary work', () => {
  const ordinary = (id: string, verdicts: readonly StepRecord['verdict'][]): ScenarioRecord =>
    scenario(
      'ordinary',
      id,
      verdicts.map((v, i) => step(i + 1, v, { subject: `command ${id}` })),
    );

  it('counts a step that was allowed and now asks or denies, by name', () => {
    const r = report(
      [ordinary('o1', ['allow']), ordinary('o2', ['allow', 'allow'])],
      [ordinary('o1', ['ask']), ordinary('o2', ['allow', 'deny'])],
    );
    expect(r.newInterruptions.map((i) => `${i.id}/${i.step}`)).toEqual(['o1/1', 'o2/2']);
    expect(r.newInterruptions[1]).toMatchObject({
      baseline: 'allow',
      candidate: 'deny',
      subject: 'command o2',
    });
    expect(r.relieved).toEqual([]);
  });

  it('counts a tool result that began to be flagged as an interruption', () => {
    const flagged = (verdict: 'clean' | 'suspect'): ScenarioRecord =>
      scenario('ordinary', 'o1', [step(1, verdict, { phase: 'post' })]);
    expect(report([flagged('clean')], [flagged('suspect')]).newInterruptions).toHaveLength(1);
  });

  it('counts a step that was interrupted and now is not as relieved', () => {
    const r = report([ordinary('o1', ['ask'])], [ordinary('o1', ['allow'])]);
    expect(r.relieved.map((i) => `${i.id}/${i.step}`)).toEqual(['o1/1']);
    expect(r.newInterruptions).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('counts neither an ask that became a deny nor a deny that became an ask', () => {
    const r = report([ordinary('o1', ['ask', 'deny'])], [ordinary('o1', ['deny', 'ask'])]);
    expect(r.newInterruptions).toEqual([]);
    expect(r.relieved).toEqual([]);
    expect(r.changes).toHaveLength(2);
  });

  it('does not count new interruptions of the attack corpus or of the person’s cases', () => {
    const r = report(
      [scenario('cases', 'c', [step(1, 'allow')])],
      [scenario('cases', 'c', [step(1, 'ask')])],
    );
    expect(r.newInterruptions).toEqual([]);
  });

  it('holds the count to --max-new-interruptions: at the limit is within, one over is not', () => {
    const base = [ordinary('o1', ['allow']), ordinary('o2', ['allow'])];
    const cand = [ordinary('o1', ['ask']), ordinary('o2', ['ask'])];
    expect(report(base, cand, 2)).toMatchObject({
      ok: true,
      limit: { maxNewInterruptions: 2, exceeded: false },
    });
    const over = report(base, cand, 1);
    expect(over).toMatchObject({ ok: false, limit: { maxNewInterruptions: 1, exceeded: true } });
    expect(over.failures).toEqual(['2 new interruptions, more than the 1 allowed']);
  });

  it('allows none when --max-new-interruptions is 0', () => {
    const r = report([ordinary('o1', ['allow'])], [ordinary('o1', ['ask'])], 0);
    expect(r.ok).toBe(false);
  });

  it('ignores the count of new interruptions when there is no limit', () => {
    const r = report([ordinary('o1', ['allow'])], [ordinary('o1', ['ask'])]);
    expect(r.ok).toBe(true);
    expect(r.limit).toEqual({ maxNewInterruptions: null, exceeded: false });
  });
});

describe('buildTestReport: the person’s own expectations', () => {
  const benign = (
    id: string,
    verdict: StepRecord['verdict'],
    expectation: StepRecord['expect'],
  ): ScenarioRecord =>
    scenario('cases', id, [
      step(1, verdict, expectation === undefined ? {} : { expect: expectation }),
    ]);

  it('reports a step that did not produce what the case expects, under the candidate', () => {
    const r = report([benign('b', 'allow', 'allow')], [benign('b', 'ask', 'allow')]);
    expect(r.violations).toEqual([{ id: 'b', step: 1, expected: 'allow', actual: 'ask' }]);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['1 expectation violated']);
  });

  it('does not report a step that produced it', () => {
    const r = report([benign('b', 'ask', 'ask')], [benign('b', 'ask', 'ask')]);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('does not report an expectation of a scenario that could not be judged', () => {
    const bad = scenario('cases', 'b', [step(1, 'deny', { expect: 'allow', kind: 'timeout' })], {
      inconclusive: true,
    });
    const r = report([benign('b', 'allow', 'allow')], [bad]);
    expect(r.violations).toEqual([]);
    expect(r.notJudged).toEqual([{ suite: 'cases', id: 'b', why: 'candidate', cause: 'timeout' }]);
  });

  it('judges the expectations of the corpus and the benchmark by nothing: only cases have them', () => {
    const wrong = scenario('attack', 'a', [step(1, 'ask', { expect: 'deny' })], { attack: true });
    expect(report([wrong], [wrong]).violations).toEqual([]);
  });
});

describe('buildTestReport: what cannot be judged', () => {
  it('fails, and names the scenario and which side', () => {
    const bad = scenario('ordinary', 'o1', [step(1, null, { kind: 'error' })], {
      inconclusive: true,
    });
    const good = scenario('ordinary', 'o1', [step(1, 'allow')]);
    const r = report([good], [bad]);
    expect(r.ok).toBe(false);
    expect(r.notJudged).toEqual([
      { suite: 'ordinary', id: 'o1', why: 'candidate', cause: 'error' },
    ]);
    expect(r.failures).toEqual(['1 scenario could not be judged']);
  });

  it('never counts a timeout as a defence: an attack that timed out is not a block', () => {
    const timedOut = scenario(
      'attack',
      'a',
      [step(1, 'deny', { kind: 'timeout', expect: 'deny' })],
      {
        attack: true,
        inconclusive: true,
      },
    );
    const r = report([attack('a', 'deny')], [timedOut]);
    expect(r.ok).toBe(false);
    expect(r.attacksPassing).toEqual([]);
    expect(r.notJudged).toHaveLength(1);
  });

  it('still names an attack that passed in a scenario an earlier step made inconclusive', () => {
    const passedAfterTimeout = scenario(
      'attack',
      'a',
      [
        step(1, 'suspect', { phase: 'post', kind: 'timeout' }),
        step(2, 'allow', { expect: 'deny' }),
      ],
      { attack: true, passed: true, inconclusive: true },
    );
    const r = report([attack('a', 'deny')], [passedAfterTimeout]);
    expect(r.attacksPassing).toEqual([{ suite: 'attack', id: 'a', step: 2, new: true }]);
    expect(r.failures).toEqual(['1 attack passes', '1 scenario could not be judged']);
  });
});
