import type { StepVerdict } from '../harness/step.js';
import { compare, type Change, type NotJudged } from './diff.js';
import type { ScenarioRecord, Suite } from './records.js';

/** One of the two policies a run compared. */
export interface PolicyRef {
  /** `default` or the path of the file, as the person wrote it. */
  readonly source: string;
  readonly sha256: string;
}

/** An attack the candidate lets through. */
export interface AttackPass {
  readonly suite: 'attack' | 'cases';
  readonly id: string;
  /** The step of the attack itself, counting from 1: the last. */
  readonly step: number;
  /** False when the baseline lets it through as well. */
  readonly new: boolean;
}

/** A step of ordinary work that the candidate interrupts and the baseline did not, or the reverse. */
export interface Interruption {
  readonly id: string;
  readonly step: number;
  readonly tool: string;
  readonly baseline: StepVerdict;
  readonly candidate: StepVerdict;
  /** The rule that decided the step under the candidate (new interruptions) or the baseline (relieved). */
  readonly ruleId: string | null;
  readonly subject: string;
}

/** A step of one of the person's own cases that produced something other than what the case expects. */
export interface Violation {
  readonly id: string;
  readonly step: number;
  readonly expected: StepVerdict;
  readonly actual: StepVerdict | null;
}

/** What `stroq policy test --json` prints, and what the text form is made from. */
export interface TestReport {
  readonly version: 1;
  /** True exactly when the command exits 0. */
  readonly ok: boolean;
  readonly candidate: PolicyRef;
  readonly baseline: PolicyRef;
  /** How many scenarios of each suite were replayed under the candidate. */
  readonly replayed: Readonly<Record<Suite, number>>;
  readonly changes: readonly Change[];
  /** Attacks that pass under the candidate, new or not. */
  readonly attacksPassing: readonly AttackPass[];
  readonly newInterruptions: readonly Interruption[];
  readonly relieved: readonly Interruption[];
  readonly violations: readonly Violation[];
  readonly notJudged: readonly NotJudged[];
  readonly limit: { readonly maxNewInterruptions: number | null; readonly exceeded: boolean };
  /** Why the command exits 1, one fixed sentence each; empty when it exits 0. */
  readonly failures: readonly string[];
}

export interface TestInput {
  readonly candidate: PolicyRef;
  readonly baseline: PolicyRef;
  readonly baselineRecords: readonly ScenarioRecord[];
  readonly candidateRecords: readonly ScenarioRecord[];
  readonly maxNewInterruptions: number | null;
}

const plural = (n: number, noun: string, many = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : many}`;

/** A step that is stopped (asked about, denied, or flagged) is an interruption of the work. */
const interrupts = (verdict: StepVerdict): boolean =>
  verdict === 'ask' || verdict === 'deny' || verdict === 'suspect';

function attacksPassing(
  baseline: readonly ScenarioRecord[],
  candidate: readonly ScenarioRecord[],
): AttackPass[] {
  const before = new Map(baseline.map((r) => [`${r.suite}\u0000${r.id}`, r]));
  return candidate.flatMap((record) => {
    const last = record.steps[record.steps.length - 1];
    if (!record.attack || !record.passed || last === undefined) return [];
    if (record.suite === 'ordinary') return [];
    const earlier = before.get(`${record.suite}\u0000${record.id}`);
    return [{ suite: record.suite, id: record.id, step: last.step, new: earlier?.passed !== true }];
  });
}

function interruptions(changes: readonly Change[], from: 'new' | 'relieved'): Interruption[] {
  return changes
    .filter((c) => c.suite === 'ordinary')
    .filter((c) =>
      from === 'new'
        ? !interrupts(c.baseline) && interrupts(c.candidate)
        : interrupts(c.baseline) && !interrupts(c.candidate),
    )
    .map((c) => ({
      id: c.id,
      step: c.step,
      tool: c.tool,
      baseline: c.baseline,
      candidate: c.candidate,
      ruleId: from === 'new' ? c.candidateRuleId : c.baselineRuleId,
      subject: c.subject,
    }));
}

function violationsOf(candidate: readonly ScenarioRecord[]): Violation[] {
  return candidate
    .filter((record) => record.suite === 'cases' && !record.inconclusive)
    .flatMap((record) =>
      record.steps.flatMap((step) =>
        step.expect !== undefined && step.verdict !== step.expect
          ? [{ id: record.id, step: step.step, expected: step.expect, actual: step.verdict }]
          : [],
      ),
    );
}

function failuresOf(parts: {
  passing: readonly AttackPass[];
  violations: readonly Violation[];
  notJudged: readonly NotJudged[];
  newInterruptions: number;
  max: number | null;
}): string[] {
  const failures: string[] = [];
  if (parts.passing.length > 0) {
    failures.push(
      `${plural(parts.passing.length, 'attack')} ${parts.passing.length === 1 ? 'passes' : 'pass'}`,
    );
  }
  if (parts.violations.length > 0) {
    failures.push(`${plural(parts.violations.length, 'expectation')} violated`);
  }
  if (parts.notJudged.length > 0) {
    failures.push(`${plural(parts.notJudged.length, 'scenario')} could not be judged`);
  }
  if (parts.max !== null && parts.newInterruptions > parts.max) {
    failures.push(
      `${plural(parts.newInterruptions, 'new interruption')}, more than the ${parts.max} allowed`,
    );
  }
  return failures;
}

const countOf = (records: readonly ScenarioRecord[], suite: Suite): number =>
  records.filter((r) => r.suite === suite).length;

/**
 * The comparison of two replays of the same scenarios, as a report. Nothing here runs anything:
 * it reads the records the runners made. An attack counts as passed only when the runner said the
 * attack step was allowed, a timeout or an error is `notJudged` and fails the run (it is not a block),
 * and an expectation is held to the candidate alone.
 */
export function buildTestReport(input: TestInput): TestReport {
  const { changes, notJudged } = compare(input.baselineRecords, input.candidateRecords);
  const passing = attacksPassing(input.baselineRecords, input.candidateRecords);
  const newInterruptions = interruptions(changes, 'new');
  const violations = violationsOf(input.candidateRecords);
  const exceeded =
    input.maxNewInterruptions !== null && newInterruptions.length > input.maxNewInterruptions;
  const failures = failuresOf({
    passing,
    violations,
    notJudged,
    newInterruptions: newInterruptions.length,
    max: input.maxNewInterruptions,
  });
  return {
    version: 1,
    ok: failures.length === 0,
    candidate: input.candidate,
    baseline: input.baseline,
    replayed: {
      attack: countOf(input.candidateRecords, 'attack'),
      ordinary: countOf(input.candidateRecords, 'ordinary'),
      cases: countOf(input.candidateRecords, 'cases'),
    },
    changes,
    attacksPassing: passing,
    newInterruptions,
    relieved: interruptions(changes, 'relieved'),
    violations,
    notJudged,
    limit: { maxNewInterruptions: input.maxNewInterruptions, exceeded },
    failures,
  };
}
