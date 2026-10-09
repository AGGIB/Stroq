import { describe, expect, it } from 'vitest';
import type { ProbeOutcome } from '../../src/live/evidence.js';
import {
  caveatsFor,
  downgradeUnarmed,
  nothing,
  overallState,
  toProbeResult,
  type Row,
} from '../../src/live/result.js';
import type { ProbeEvidence, ProbeKind, ProbeMark } from '../../src/live/types.js';

/**
 * How the marks of the probes become the one state of a host. The rule is the one the check stands
 * on: a verified needs the allow to have passed and at least one deny to have been stopped, nothing to
 * have failed, and (when a control was asked for) the probe to have been shown to be armed.
 */
const SEEN: ProbeEvidence = { E1: true, E2: true, E3: true, E4: true };
const NONE: ProbeEvidence = { E1: null, E2: null, E3: null, E4: null };

const outcome = (mark: ProbeMark, reason = 'r', evidence: ProbeEvidence = SEEN): ProbeOutcome => ({
  mark,
  reason,
  evidence,
});
const row = (kind: ProbeKind, mark: ProbeMark, reason?: string, id: string = kind): Row => ({
  id,
  kind,
  outcome: outcome(mark, reason),
});

const marks = (allow: ProbeMark, deny: ProbeMark, egress: ProbeMark): Row[] => [
  row('allow', allow),
  row('deny', deny),
  row('secret-egress', egress),
];

describe('overallState', () => {
  const cases: ReadonlyArray<readonly [string, [ProbeMark, ProbeMark, ProbeMark], string]> = [
    ['everything passed', ['passed', 'passed', 'passed'], 'verified'],
    [
      'one deny passed and the other could not tell',
      ['passed', 'passed', 'inconclusive'],
      'verified',
    ],
    [
      'one deny passed and the other was never issued',
      ['passed', 'not-issued', 'passed'],
      'verified',
    ],
    [
      'one deny passed and the other was skipped by the policy',
      ['passed', 'skipped', 'passed'],
      'verified',
    ],
    [
      'one deny passed and the other was not attempted',
      ['passed', 'passed', 'not-attempted'],
      'verified',
    ],
    ['both denies were skipped by the policy', ['passed', 'skipped', 'skipped'], 'inconclusive'],
    ['no deny passed and none failed', ['passed', 'inconclusive', 'inconclusive'], 'inconclusive'],
    ['the denies were never issued', ['passed', 'not-issued', 'not-issued'], 'inconclusive'],
    ['the allow could not tell', ['inconclusive', 'passed', 'passed'], 'inconclusive'],
    ['the allow was never issued', ['not-issued', 'passed', 'passed'], 'inconclusive'],
    ['the allow was skipped', ['skipped', 'passed', 'passed'], 'inconclusive'],
    ['the model refused all three', ['not-issued', 'not-issued', 'not-issued'], 'inconclusive'],
    [
      'the first request hit a limit and the rest were not made',
      ['inconclusive', 'not-attempted', 'not-attempted'],
      'inconclusive',
    ],
    ['a deny failed', ['passed', 'failed', 'passed'], 'failed'],
    ['the allow failed', ['failed', 'passed', 'passed'], 'failed'],
    ['all failed', ['failed', 'failed', 'failed'], 'failed'],
    ['one failed and the rest were not attempted', ['passed', 'failed', 'not-attempted'], 'failed'],
    ['nothing was attempted', ['not-attempted', 'not-attempted', 'not-attempted'], 'not-attempted'],
    [
      'nothing was attempted and the rest were skipped',
      ['skipped', 'not-attempted', 'skipped'],
      'not-attempted',
    ],
    ['nothing was left to do', ['skipped', 'skipped', 'skipped'], 'not-attempted'],
  ];

  it.each(cases)('with %s the state is %s', (_name, [allow, deny, egress], state) => {
    expect(overallState(marks(allow, deny, egress))).toBe(state);
  });

  it('has no state for a list with nothing in it', () => {
    expect(overallState([])).toBe('not-attempted');
  });

  it('counts only a deny as a deny: a second allow does not make a verified', () => {
    expect(overallState([row('allow', 'passed'), row('allow', 'passed', 'r', 'again')])).toBe(
      'inconclusive',
    );
  });
});

describe('downgradeUnarmed', () => {
  const deny = row('deny', 'passed', 'blocked');
  const control = (mark: ProbeMark, reason: string): ProbeOutcome => outcome(mark, reason);

  it('keeps a pass whose control showed the probe armed', () => {
    expect(downgradeUnarmed(deny, control('passed', 'armed'))).toEqual(deny);
  });

  it('turns a pass into doubt when the control showed the host would not run the command anyway', () => {
    const shown = downgradeUnarmed(deny, control('inconclusive', 'probe-not-armed'));
    expect(shown.outcome).toMatchObject({ mark: 'inconclusive', reason: 'probe-not-armed' });
    expect(shown.outcome.detail).toMatch(/control/);
  });

  it.each([
    ['could not tell', control('inconclusive', 'timeout')],
    ['was never issued', control('not-issued', 'not-issued')],
    ['was not attempted', control('not-attempted', 'limit')],
  ])('turns a pass into doubt when the control %s', (_name, c) => {
    const shown = downgradeUnarmed(deny, c);
    expect(shown.outcome).toMatchObject({ mark: 'inconclusive', reason: 'control-inconclusive' });
    expect(shown.outcome.detail).toContain(c.reason);
  });

  it('keeps what the real run found, whatever the control did', () => {
    const shown = downgradeUnarmed(deny, control('inconclusive', 'probe-not-armed'));
    expect(shown.outcome.evidence).toEqual(SEEN);
  });

  it('turns a pass into doubt when a control was asked for and there is none', () => {
    expect(downgradeUnarmed(deny, undefined).outcome).toMatchObject({
      mark: 'inconclusive',
      reason: 'control-inconclusive',
    });
  });

  it.each<ProbeMark>(['failed', 'inconclusive', 'not-issued', 'skipped', 'not-attempted'])(
    'leaves a probe that did not pass as it was (%s), whatever its control says',
    (mark) => {
      const other = row('deny', mark);
      expect(downgradeUnarmed(other, control('passed', 'armed'))).toEqual(other);
      expect(downgradeUnarmed(other, undefined)).toEqual(other);
    },
  );

  it('leaves the allow probe alone: it has no control', () => {
    const allow = row('allow', 'passed', 'ran');
    expect(downgradeUnarmed(allow, undefined)).toEqual(allow);
  });

  it('does not change the row it is given', () => {
    const before = JSON.stringify(deny);
    downgradeUnarmed(deny, control('inconclusive', 'probe-not-armed'));
    expect(JSON.stringify(deny)).toBe(before);
  });
});

describe('nothing', () => {
  it('is a probe that was not run, with no evidence of anything', () => {
    expect(nothing('skipped', 'skipped-policy-allows', 'the policy allows it')).toEqual({
      mark: 'skipped',
      reason: 'skipped-policy-allows',
      detail: 'the policy allows it',
      evidence: NONE,
    });
  });

  it('keeps the detail to a line of plain characters', () => {
    expect(nothing('not-attempted', 'limit', 'a\nb\u001b[2J').detail).toBe('a b?[2J');
  });
});

describe('toProbeResult', () => {
  it('writes a row as the result of a probe, leaving out the detail when there is none', () => {
    expect(toProbeResult(row('deny', 'passed', 'blocked'))).toEqual({
      id: 'deny',
      kind: 'deny',
      mark: 'passed',
      reason: 'blocked',
      evidence: SEEN,
    });
  });

  it('keeps the detail, and the id of a control run', () => {
    const detailed: Row = {
      id: 'deny:control',
      kind: 'deny',
      outcome: { ...outcome('passed', 'armed'), detail: 'it ran' },
    };
    expect(toProbeResult(detailed)).toMatchObject({ id: 'deny:control', detail: 'it ran' });
  });
});

describe('caveatsFor', () => {
  const base = {
    capabilities: undefined,
    note: undefined,
    control: false,
    rows: marks('passed', 'passed', 'passed'),
  };

  it('starts from what the host table says no result from this host shows', () => {
    expect(
      caveatsFor({ ...base, capabilities: { headless: true, caveats: ['hook-trust-bypassed'] } }),
    ).toContain('hook-trust-bypassed');
  });

  it('carries the note the driver gave when it looked for the host', () => {
    expect(caveatsFor({ ...base, note: 'found on the path\n(old)' })).toContain(
      'found on the path (old)',
    );
  });

  it('says no control was run when a deny passed and none was asked for', () => {
    expect(caveatsFor(base)).toContain('no-control-run');
    expect(caveatsFor({ ...base, control: true })).not.toContain('no-control-run');
    expect(
      caveatsFor({ ...base, rows: marks('passed', 'inconclusive', 'inconclusive') }),
    ).not.toContain('no-control-run');
  });

  it('names a deny that passed without the words of the hook in the host answer', () => {
    const quiet: Row = {
      id: 'deny',
      kind: 'deny',
      outcome: outcome('passed', 'blocked', { ...SEEN, E4: false }),
    };
    expect(caveatsFor({ ...base, rows: [row('allow', 'passed'), quiet] })).toContain(
      'deny-text-not-seen:deny',
    );
    expect(caveatsFor(base).some((c) => c.startsWith('deny-text-not-seen'))).toBe(false);
  });

  it('lists each caveat once, in plain characters, and no more than a result can hold', () => {
    const many = caveatsFor({
      ...base,
      capabilities: {
        headless: true,
        caveats: ['x', 'x', ...Array.from({ length: 30 }, (_, i) => `caveat ${i}`)],
      },
    });
    expect(many).toHaveLength(16);
    expect(new Set(many).size).toBe(16);
    for (const c of many) expect(c).toMatch(/^[\x20-\x7e]{1,120}$/);
  });
});
