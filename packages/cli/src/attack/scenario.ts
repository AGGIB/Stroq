import type { ClaudeHookEvent } from '../adapters/claude-code.js';

/** What a step must produce: a decision effect for `PreToolUse`, a scan verdict for `PostToolUse`. */
export type StepExpectation = 'deny' | 'ask' | 'allow' | 'suspect' | 'clean';

export interface ScenarioStep {
  /**
   * A recorded Claude Code hook event, exactly as `stroq hook claude-code` receives it.
   * `__CWD__` inside any string is replaced by the scenario's project directory at run time.
   */
  readonly event: ClaudeHookEvent;
  readonly expect: StepExpectation;
}

export interface Incident {
  readonly name: string;
  readonly url: string;
  /** `YYYY-MM` of the public report. */
  readonly date: string;
}

export interface Scenario {
  /** Stable id `NN-kebab-case`; `NN` is the scenario's position in the suite. */
  readonly id: string;
  readonly title: string;
  readonly incident: Incident;
  /** Files created inside the project directory before the steps run (paths relative to it). */
  readonly files?: Readonly<Record<string, string>>;
  /** At least one step; the last one is the attack itself and must be a `PreToolUse`. */
  readonly steps: readonly [ScenarioStep, ...ScenarioStep[]];
}

export const CWD_PLACEHOLDER = '__CWD__';
/** Every secret value in the suite starts with this, so no scenario can ever carry a real credential. */
export const SYNTHETIC_SECRET_PREFIX = 'stroq_attack_';
export const SESSION_ID = 'stroq-attack';
