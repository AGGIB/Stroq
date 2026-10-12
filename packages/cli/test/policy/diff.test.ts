import { describe, expect, it } from 'vitest';
import { compare } from '../../src/policy/diff.js';
import type { ScenarioRecord, StepRecord, Suite } from '../../src/policy/records.js';

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

describe('compare: decisions that changed', () => {
  it('finds nothing when both runs said the same', () => {
    const same = [
      scenario('attack', '01-a', [step(1, 'clean', { phase: 'post' }), step(2, 'deny')]),
    ];
    expect(compare(same, same)).toEqual({ changes: [], notJudged: [] });
  });

  it('calls a deny that became an allow looser, and names the scenario and the step', () => {
    const base = [
      scenario('attack', '01-a', [
        step(1, 'clean', { phase: 'post' }),
        step(2, 'deny', { ruleId: 'r1' }),
      ]),
    ];
    const cand = [
      scenario('attack', '01-a', [step(1, 'clean', { phase: 'post' }), step(2, 'allow')]),
    ];
    const { changes } = compare(base, cand);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      suite: 'attack',
      id: '01-a',
      step: 2,
      baseline: 'deny',
      candidate: 'allow',
      direction: 'looser',
      baselineRuleId: 'r1',
      candidateRuleId: null,
    });
  });

  it.each([
    ['allow', 'ask', 'stricter'],
    ['allow', 'deny', 'stricter'],
    ['ask', 'deny', 'stricter'],
    ['deny', 'ask', 'looser'],
    ['ask', 'allow', 'looser'],
    ['deny', 'allow', 'looser'],
  ] as const)('%s -> %s is %s', (from, to, direction) => {
    const { changes } = compare(
      [scenario('ordinary', 'a', [step(1, from)])],
      [scenario('ordinary', 'a', [step(1, to)])],
    );
    expect(changes.map((c) => c.direction)).toEqual([direction]);
  });

  it('reads a tool result that began to be flagged as stricter, and the reverse as looser', () => {
    const clean = [scenario('ordinary', 'a', [step(1, 'clean', { phase: 'post' })])];
    const flagged = [scenario('ordinary', 'a', [step(1, 'suspect', { phase: 'post' })])];
    expect(compare(clean, flagged).changes[0]).toMatchObject({ direction: 'stricter' });
    expect(compare(flagged, clean).changes[0]).toMatchObject({ direction: 'looser' });
  });

  it('does not call a change of the rule behind the same answer a change of the decision', () => {
    const { changes } = compare(
      [scenario('attack', 'a', [step(1, 'deny', { ruleId: 'one' })])],
      [scenario('attack', 'a', [step(1, 'deny', { ruleId: 'other' })])],
    );
    expect(changes).toEqual([]);
  });

  it('lists the changes in the order of the scenarios and of their steps', () => {
    const base = [
      scenario('attack', 'b', [step(1, 'deny'), step(2, 'deny')]),
      scenario('attack', 'a', [step(1, 'ask')]),
    ];
    const cand = [
      scenario('attack', 'b', [step(1, 'allow'), step(2, 'allow')]),
      scenario('attack', 'a', [step(1, 'allow')]),
    ];
    expect(compare(base, cand).changes.map((c) => `${c.id}/${c.step}`)).toEqual([
      'b/1',
      'b/2',
      'a/1',
    ]);
  });

  it('tells apart two suites that use one id', () => {
    const base = [
      scenario('attack', 'same', [step(1, 'deny')]),
      scenario('cases', 'same', [step(1, 'deny')]),
    ];
    const cand = [
      scenario('attack', 'same', [step(1, 'deny')]),
      scenario('cases', 'same', [step(1, 'allow')]),
    ];
    expect(compare(base, cand).changes.map((c) => c.suite)).toEqual(['cases']);
  });
});

describe('compare: what cannot be judged', () => {
  it('leaves a timeout out of the changes and names the scenario', () => {
    const base = [scenario('attack', 'a', [step(1, 'deny')])];
    const cand = [
      scenario('attack', 'a', [step(1, 'ask', { kind: 'timeout' })], { inconclusive: true }),
    ];
    expect(compare(base, cand)).toEqual({
      changes: [],
      notJudged: [{ suite: 'attack', id: 'a', why: 'candidate' }],
    });
  });

  it('names the baseline when it was the baseline that could not be judged', () => {
    const base = [
      scenario('attack', 'a', [step(1, null, { kind: 'error' })], { inconclusive: true }),
    ];
    const cand = [scenario('attack', 'a', [step(1, 'deny')])];
    expect(compare(base, cand).notJudged).toEqual([{ suite: 'attack', id: 'a', why: 'baseline' }]);
  });

  it('names both when neither could be judged', () => {
    const bad = scenario('attack', 'a', [step(1, null, { kind: 'error' })], { inconclusive: true });
    expect(compare([bad], [bad]).notJudged).toEqual([{ suite: 'attack', id: 'a', why: 'both' }]);
  });

  it('leaves out even a clear change in a scenario that was not judged as a whole', () => {
    // A timed-out scan taints the session, so a later denial may be the clock's.
    const base = [
      scenario('ordinary', 'a', [step(1, 'clean', { phase: 'post' }), step(2, 'allow')]),
    ];
    const cand = [
      scenario(
        'ordinary',
        'a',
        [step(1, 'suspect', { phase: 'post', kind: 'timeout' }), step(2, 'deny')],
        { inconclusive: true },
      ),
    ];
    expect(compare(base, cand).changes).toEqual([]);
  });

  it('counts a scenario one side lacks as not judged', () => {
    const base = [scenario('attack', 'a', [step(1, 'deny')])];
    expect(compare(base, []).notJudged).toEqual([{ suite: 'attack', id: 'a', why: 'candidate' }]);
    expect(compare([], base).notJudged).toEqual([{ suite: 'attack', id: 'a', why: 'baseline' }]);
  });

  it('counts a scenario whose runs have a different number of steps as not judged', () => {
    const base = [scenario('attack', 'a', [step(1, 'deny'), step(2, 'deny')])];
    const cand = [scenario('attack', 'a', [step(1, 'allow')])];
    const result = compare(base, cand);
    expect(result.changes).toEqual([]);
    expect(result.notJudged).toHaveLength(1);
  });

  it('judges a step that was asked at a limit like any other ask', () => {
    const base = [scenario('attack', 'a', [step(1, 'ask', { kind: 'asked-by-limit' })])];
    const cand = [scenario('attack', 'a', [step(1, 'deny')])];
    expect(compare(base, cand).changes[0]).toMatchObject({ baseline: 'ask', candidate: 'deny' });
  });
});
