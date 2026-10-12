import type { StepVerdict } from '../harness/step.js';
import type { ScenarioRecord, StepRecord, Suite } from './records.js';

export type Direction = 'stricter' | 'looser';

/** A step that was decided differently by the two policies. */
export interface Change {
  readonly suite: Suite;
  readonly id: string;
  /** Counting from 1. */
  readonly step: number;
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly baseline: StepVerdict;
  readonly candidate: StepVerdict;
  readonly direction: Direction;
  readonly baselineRuleId: string | null;
  readonly candidateRuleId: string | null;
  /** What the step was, for ordinary work; else ''. */
  readonly subject: string;
}

/** Which side made a scenario impossible to judge. */
export type Blame = 'baseline' | 'candidate' | 'both';

export interface NotJudged {
  readonly suite: Suite;
  readonly id: string;
  readonly why: Blame;
}

export interface Comparison {
  readonly changes: readonly Change[];
  readonly notJudged: readonly NotJudged[];
}

/** How much a verdict stops: a result that is flagged stops more than one that is clean. */
const STRICTNESS: Readonly<Record<StepVerdict, number>> = {
  allow: 0,
  clean: 0,
  ask: 1,
  suspect: 1,
  deny: 2,
};

/** A step says something about the policy only when it was decided, or asked about at a limit. */
const isJudged = (step: StepRecord): boolean =>
  step.verdict !== null && (step.kind === 'decided' || step.kind === 'asked-by-limit');

const keyOf = (record: Pick<ScenarioRecord, 'suite' | 'id'>): string =>
  `${record.suite}\u0000${record.id}`;

function changeOf(suite: Suite, id: string, base: StepRecord, cand: StepRecord): Change | null {
  if (!isJudged(base) || !isJudged(cand)) return null;
  if (base.verdict === null || cand.verdict === null || base.verdict === cand.verdict) return null;
  return {
    suite,
    id,
    step: cand.step,
    phase: cand.phase,
    tool: cand.tool,
    baseline: base.verdict,
    candidate: cand.verdict,
    direction: STRICTNESS[cand.verdict] > STRICTNESS[base.verdict] ? 'stricter' : 'looser',
    baselineRuleId: base.ruleId,
    candidateRuleId: cand.ruleId,
    subject: cand.subject !== '' ? cand.subject : base.subject,
  };
}

function blame(base: ScenarioRecord, cand: ScenarioRecord): Blame | null {
  if (base.inconclusive && cand.inconclusive) return 'both';
  if (base.inconclusive) return 'baseline';
  if (cand.inconclusive) return 'candidate';
  return base.steps.length === cand.steps.length ? null : 'both';
}

/**
 * Where two runs of the same scenarios disagree, step by step, in the order the scenarios and their
 * steps ran. A scenario that either run could not judge as a whole (a step timed out or threw, or
 * the runs have different steps) contributes no change at all: the answer of a step after a timed-out
 * scan may be the clock's, and a change taken from it would be a claim about the clock. It is named
 * in `notJudged` instead. Only the effect is compared, not the rule that gave it.
 */
export function compare(
  baseline: readonly ScenarioRecord[],
  candidate: readonly ScenarioRecord[],
): Comparison {
  const candidates = new Map(candidate.map((record) => [keyOf(record), record]));
  const changes: Change[] = [];
  const notJudged: NotJudged[] = [];
  for (const base of baseline) {
    const cand = candidates.get(keyOf(base));
    candidates.delete(keyOf(base));
    if (cand === undefined) {
      notJudged.push({ suite: base.suite, id: base.id, why: 'candidate' });
      continue;
    }
    const why = blame(base, cand);
    if (why !== null) {
      notJudged.push({ suite: base.suite, id: base.id, why });
      continue;
    }
    base.steps.forEach((step, index) => {
      const other = cand.steps[index];
      const change = other === undefined ? null : changeOf(base.suite, base.id, step, other);
      if (change !== null) changes.push(change);
    });
  }
  for (const lone of candidates.values()) {
    notJudged.push({ suite: lone.suite, id: lone.id, why: 'baseline' });
  }
  return { changes, notJudged };
}
