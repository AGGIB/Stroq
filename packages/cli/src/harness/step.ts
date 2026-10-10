import { isClockSignal, isLimitSignal, type StroqEngine } from '@stroq/core';
import {
  ClaudeHookInputSchema,
  toolResultToText,
  type ClaudeHookEvent,
} from '../adapters/claude-code.js';
import { CWD_PLACEHOLDER } from '../attack/scenario.js';

/**
 * One step of a scenario, run against the real engine and told apart by what actually happened.
 *
 * `stroq attack`, its fuzzer and `stroq bench --actions` all replay hook events against the policy
 * engine, and all of them used to read the answer as "the engine said X". That is not always what
 * happened: the scan can run out of its time budget (a fail-closed `suspect` that looks exactly
 * like a rule catching the text), the reading of a command can run past its deadline (an `ask`
 * that looks exactly like a rule that asks), and a malformed event can throw. A report that
 * counts those as the defence working is wrong in the one direction that matters, so this runner
 * keeps them apart and never throws for a step: the error becomes the result of the step.
 */

/** What a step produced: a decision effect for a tool call, a scan verdict for a tool result. */
export type StepVerdict = 'allow' | 'ask' | 'deny' | 'clean' | 'suspect';

export interface StepInput {
  /** `__CWD__` inside any string is replaced by the scenario's project directory. */
  readonly event: ClaudeHookEvent;
  /** What the scenario expects, echoed into the result when given. */
  readonly expect?: StepVerdict;
}

export interface StepResult {
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly expect?: StepVerdict;
  /** Null exactly when the step threw (see `error`): there is no verdict to report. */
  readonly actual: StepVerdict | null;
  /** The rule that decided a tool call, or the first rule that matched a tool result. */
  readonly ruleId: string | null;
  /** Why a tool call was not allowed, or the title of the first rule that matched a result. */
  readonly reason: string | null;
  /** The classification signals behind a tool call (see `PreResult.signals`); none for a result. */
  readonly signals: readonly string[];
  /** The scan of a tool result ran out of its time budget. */
  readonly timedOut: boolean;
  /** The message of what the step threw, with the context given to the runner. */
  readonly error?: string;
}

/**
 * What kind of answer a step is. Only a `decided` step says anything about the policy; the others
 * say what stopped it from deciding, and must never be counted as a block or as a pass.
 *
 * - `decided`: the engine judged the call or the result by its rules.
 * - `asked-by-limit`: the call was asked about because Stroq could not read it (a limit that is the
 *   same for the same input on every machine, see `LIMIT_SIGNALS`). The policy worked as written,
 *   but no rule named a danger.
 * - `timeout`: the answer depends on the clock (the scan budget, the reading deadline); a quieter
 *   machine might have said something else.
 * - `error`: the step threw, and there is no answer.
 */
export type StepKind = 'decided' | 'asked-by-limit' | 'timeout' | 'error';

export function stepKind(
  result: Pick<StepResult, 'actual' | 'signals' | 'timedOut' | 'error'>,
): StepKind {
  if (result.timedOut || result.signals.some(isClockSignal)) return 'timeout';
  if (result.error !== undefined) return 'error';
  if (result.actual === 'ask' && result.signals.some(isLimitSignal)) return 'asked-by-limit';
  return 'decided';
}

/** Replaces `__CWD__` in every string of a recorded event, however deeply nested. */
export function substituteCwd(value: unknown, cwd: string): unknown {
  if (typeof value === 'string') return value.split(CWD_PLACEHOLDER).join(cwd);
  if (Array.isArray(value)) return value.map((v) => substituteCwd(v, cwd));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([k, v]) => [k, substituteCwd(v, cwd)]));
  }
  return value;
}

/** Where a failing step is: `scenario 07-x step 2 (PreToolUse Bash)`. Taken from the raw event, which may be malformed. */
export function stepLabel(noun: string, id: string, index: number, event: ClaudeHookEvent): string {
  return `${noun} ${id} step ${index + 1} (${String(event.hook_event_name)} ${String(event.tool_name)})`;
}

/** What a step needs of the engine: the two calls a hook makes. */
export type StepEngine = Pick<StroqEngine, 'pre' | 'post'>;

/** Runs the step the event describes. Never throws: whatever goes wrong is the `error` of the result. */
export async function runStep(
  engine: StepEngine,
  step: StepInput,
  cwd: string,
  context: string,
): Promise<StepResult> {
  const expect = step.expect === undefined ? {} : { expect: step.expect };
  try {
    const event = ClaudeHookInputSchema.parse(substituteCwd(step.event, cwd));
    const base = {
      sessionId: event.session_id,
      toolName: event.tool_name,
      toolInput: event.tool_input,
      cwd: event.cwd || cwd,
    };
    if (event.hook_event_name === 'PreToolUse') {
      const { decision, signals } = await engine.pre(base);
      return {
        phase: 'pre',
        tool: event.tool_name,
        ...expect,
        actual: decision.effect,
        ruleId: decision.ruleId,
        reason: decision.effect === 'allow' ? null : decision.reason,
        signals: [...(signals ?? [])],
        timedOut: false,
      };
    }
    const { scan } = await engine.post({
      ...base,
      toolResultText: toolResultToText(event.tool_response ?? event.tool_result),
    });
    return {
      phase: 'post',
      tool: event.tool_name,
      ...expect,
      actual: scan.verdict,
      ruleId: scan.matches[0]?.ruleId ?? null,
      reason: scan.matches[0]?.title ?? null,
      signals: [],
      timedOut: scan.timedOut === true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      phase: step.event.hook_event_name === 'PreToolUse' ? 'pre' : 'post',
      tool: String(step.event.tool_name),
      ...expect,
      actual: null,
      ruleId: null,
      reason: null,
      signals: [],
      timedOut: false,
      error: `${context}: ${message}`,
    };
  }
}
