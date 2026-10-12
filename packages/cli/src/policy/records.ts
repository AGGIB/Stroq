import type { ActionScenarioResult } from '../bench/actions.js';
import type { ScenarioResult } from '../attack/run.js';
import { stepKind, type StepKind, type StepVerdict } from '../harness/step.js';

/**
 * What `stroq policy test` compares: every step of every scenario that was replayed, whichever of
 * the three runners replayed it, in one plain shape. The runners already keep a timeout and an error
 * apart from an answer (`stepKind`); this keeps that distinction on every step, so a comparison can
 * leave out what the clock decided instead of counting it as a defence or a hole.
 */

/** The attack corpus, the ordinary-work benchmark, or the person's own cases. */
export type Suite = 'attack' | 'ordinary' | 'cases';

export interface StepRecord {
  /** The position of the step in its scenario, counting from 1. */
  readonly step: number;
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  /** Null exactly when the step threw. */
  readonly verdict: StepVerdict | null;
  readonly kind: StepKind;
  readonly ruleId: string | null;
  /** What the step was, in a line, for the ordinary work (the command, the path, the URL); else ''. */
  readonly subject: string;
  /** What the scenario or the case expects of this step, when it says. */
  readonly expect?: StepVerdict;
}

export interface ScenarioRecord {
  readonly suite: Suite;
  readonly id: string;
  readonly steps: readonly StepRecord[];
  /** A step timed out or threw (or the scenario could not be set up): it says nothing sure. */
  readonly inconclusive: boolean;
  /** An attack-style scenario: its last step is the attack. */
  readonly attack: boolean;
  /** An attack-style scenario whose attack was allowed. */
  readonly passed: boolean;
}

/** A scenario that could not be run at all (its fixtures could not be written, say). */
export const unrunnable = (suite: Suite, id: string, attack: boolean): ScenarioRecord => ({
  suite,
  id,
  steps: [],
  inconclusive: true,
  attack,
  passed: false,
});

export function fromAttackResult(result: ScenarioResult, suite: Suite): ScenarioRecord {
  return {
    suite,
    id: result.id,
    steps: result.steps.map((step, index) => ({
      step: index + 1,
      phase: step.phase,
      tool: step.tool,
      verdict: step.actual,
      kind: stepKind(step),
      ruleId: step.ruleId,
      subject: '',
      expect: step.expect,
    })),
    inconclusive: result.inconclusive,
    attack: true,
    passed: result.outcome === 'passed',
  };
}

export function fromActionResult(
  result: ActionScenarioResult,
  suite: Suite,
  expect?: StepVerdict,
): ScenarioRecord {
  const lastIndex = result.steps.length - 1;
  return {
    suite,
    id: result.id,
    steps: result.steps.map((step, index) => ({
      step: index + 1,
      phase: step.phase,
      tool: step.tool,
      verdict: step.verdict,
      kind: stepKind({
        actual: step.verdict,
        signals: step.signals,
        timedOut: step.timedOut,
        ...(step.error === undefined ? {} : { error: step.error }),
      }),
      ruleId: step.ruleId,
      subject: step.subject,
      ...(expect !== undefined && index === lastIndex ? { expect } : {}),
    })),
    inconclusive: result.inconclusive,
    attack: false,
    passed: false,
  };
}
