import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { ClaudeHookInputSchema, type ClaudeHookEvent } from '../adapters/claude-code.js';
import { writeFixtures } from '../attack/run.js';
import { createEngineAt } from '../engine-factory.js';
import {
  runStep,
  stepKind,
  stepLabel,
  substituteCwd,
  troubleOf,
  type StepKind,
  type StepResult,
  type StepVerdict,
} from '../harness/step.js';
import { ACTION_SCENARIOS } from './actions-corpus.js';

// Re-exported: the verdict type moved to the shared step runner, and callers have always found it here.
export type { StepVerdict };

/**
 * Ordinary agent work, replayed against the real policy and rules in a clean session: how often
 * Stroq interrupts what a developer would never want interrupted. `stroq attack` measures what
 * Stroq stops; this is the other side of that, and a firewall that stops everything stops nothing
 * anyone keeps switched on.
 *
 * A step is a hook event as the host sends it: a tool call about to run (`PreToolUse`), or what a
 * tool returned (`PostToolUse`). Each scenario runs in a throwaway project and home, so it can
 * never read the operator's credentials or touch `~/.stroq`.
 */
export interface ActionScenario {
  /** Stable id `NN-kebab-case`. */
  readonly id: string;
  readonly title: string;
  /** Files created in the project directory before the steps run (paths relative to it). */
  readonly files?: Readonly<Record<string, string>>;
  readonly steps: readonly [ActionStep, ...ActionStep[]];
}

export interface ActionStep {
  /** `__CWD__` inside any string is replaced by the scenario's project directory. */
  readonly event: ClaudeHookEvent;
}

export interface ActionStepResult {
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  /** What the step was, for a person reading the report: the command, the path, the URL. */
  readonly subject: string;
  /** Null exactly when the step threw (see `error`): there is no verdict to report. */
  readonly verdict: StepVerdict | null;
  /** The rule that decided a tool call, or the first rule that matched a result. */
  readonly ruleId: string | null;
  readonly reason: string | null;
  /** The classification signals behind a tool call (see `PreResult.signals`); none for a result. */
  readonly signals: readonly string[];
  /** The scan of a tool result ran out of its time budget. */
  readonly timedOut: boolean;
  /** What the step threw, with the scenario and step it was. */
  readonly error?: string;
  /**
   * True when the step was anything but allowed (a call) or clean (a result), judged by a rule or
   * at a limit. A step that timed out or threw is not counted either way: its answer is the
   * clock's or nothing, and counting it would make the rate a rate of how busy the machine was.
   */
  readonly interrupted: boolean;
}

export interface ActionScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly ActionStepResult[];
  readonly interrupted: boolean;
  /** A step timed out or threw: the scenario says nothing sure about the policy. */
  readonly inconclusive: boolean;
  /** What made the scenario inconclusive; null when it is not. */
  readonly reason: string | null;
}

export interface ActionsReport {
  readonly version: 1;
  /** `default` or the path of the policy override that was used. */
  readonly policy: string;
  readonly scenarios: readonly ActionScenarioResult[];
  readonly total: number;
  /** Scenarios in which at least one step was interrupted (asks at a limit included). */
  readonly interrupted: number;
  /** Steps a rule or a limit put to the user as a question. */
  readonly asked: number;
  /** Of `asked`, those asked because Stroq could not read the call (a limit), not because of a rule. */
  readonly askedByLimit: number;
  readonly denied: number;
  /** Tool results the scan flagged. */
  readonly flagged: number;
  /** Scenarios in which a step timed out or threw, so their interruptions cannot be counted. */
  readonly inconclusive: number;
  /** interrupted / total, computed and never typed by a human. */
  readonly rate: number;
  /** False when any scenario was inconclusive: an interruption rate that could not be measured. */
  readonly ok: boolean;
}

/** The longest a subject is shown in a report line. */
const SUBJECT_CHARS = 110;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What a tool call was, in a line: the command, the path, the URL, or the tool's name. */
function subjectOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  };
  const text = pick('command', 'file_path', 'path', 'url', 'pattern', 'query') ?? tool;
  const line = squash(text);
  return line.length <= SUBJECT_CHARS ? line : `${line.slice(0, SUBJECT_CHARS - 1)}…`;
}

/** The subject of a step, without ever throwing: a malformed event has the tool name it claims, or none. */
function subjectOfEvent(event: ClaudeHookEvent, cwd: string): string {
  const parsed = ClaudeHookInputSchema.safeParse(substituteCwd(event, cwd));
  return parsed.success ? subjectOf(parsed.data.tool_name, parsed.data.tool_input) : '';
}

const isJudged = (kind: StepKind): boolean => kind === 'decided' || kind === 'asked-by-limit';

function toActionStep(result: StepResult, subject: string): ActionStepResult {
  const kind = stepKind(result);
  return {
    phase: result.phase,
    tool: result.tool,
    subject,
    verdict: result.actual,
    ruleId: result.ruleId,
    reason: result.reason,
    signals: result.signals,
    timedOut: result.timedOut,
    ...(result.error === undefined ? {} : { error: result.error }),
    interrupted: isJudged(kind) && result.actual !== 'allow' && result.actual !== 'clean',
  };
}

/** The kind of a step as the report holds it. */
const kindOf = (step: ActionStepResult): StepKind =>
  stepKind({
    actual: step.verdict,
    signals: step.signals,
    timedOut: step.timedOut,
    ...(step.error === undefined ? {} : { error: step.error }),
  });

/** Runs one scenario in a fresh temporary root, the way `stroq attack` runs an attack. */
export async function runActionScenario(
  scenario: ActionScenario,
  policy: Policy,
): Promise<ActionScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), 'stroq-actions-'));
  try {
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const userHome = join(root, 'user');
    await Promise.all([cwd, home, userHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFixtures(cwd, scenario.files ?? {});
    const engine = createEngineAt({ home, userHome, policy, env: {} });
    const ran: StepResult[] = [];
    const steps: ActionStepResult[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      const label = stepLabel('action scenario', scenario.id, index, step.event);
      const result = await runStep(engine, step, cwd, label);
      ran.push(result);
      steps.push(toActionStep(result, subjectOfEvent(step.event, cwd)));
      // What follows would run against a session the scenario did not mean to leave behind.
      if (result.error !== undefined) break;
    }
    const trouble = ran.flatMap((result, index) => troubleOf(result, index) ?? []);
    return {
      id: scenario.id,
      title: scenario.title,
      steps,
      interrupted: steps.some((s) => s.interrupted),
      inconclusive: trouble.length > 0,
      reason: trouble.length > 0 ? trouble.join('; ') : null,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs the scenarios in order and counts what was interrupted, and how. */
export async function runActionsBench(
  scenarios: readonly ActionScenario[],
  policy: Policy,
  policySource: string,
): Promise<ActionsReport> {
  const results: ActionScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runActionScenario(scenario, policy));
  // Only a step that was judged is counted by its verdict: the fail-closed `suspect` of a scan that
  // ran out of its budget is not a flagged result, and an ask the clock produced is not an ask.
  const judged = results.flatMap((r) => r.steps).filter((s) => isJudged(kindOf(s)));
  const count = (verdict: StepVerdict): number =>
    judged.filter((s) => s.verdict === verdict).length;
  const interrupted = results.filter((r) => r.interrupted).length;
  const inconclusive = results.filter((r) => r.inconclusive).length;
  return {
    version: 1,
    policy: policySource,
    scenarios: results,
    total: results.length,
    interrupted,
    asked: count('ask'),
    askedByLimit: judged.filter((s) => kindOf(s) === 'asked-by-limit').length,
    denied: count('deny'),
    flagged: count('suspect'),
    inconclusive,
    rate: results.length === 0 ? 0 : interrupted / results.length,
    ok: inconclusive === 0,
  };
}

/**
 * The bundled scenarios against the bundled policy, with no override file: what `docs/BENCH.md`
 * publishes, and so a number that does not depend on whose machine made it.
 */
export function runDefaultActionsBench(): Promise<ActionsReport> {
  return runActionsBench(ACTION_SCENARIOS, DEFAULT_POLICY, 'default');
}

const pad = (text: string, width: number): string => text.padEnd(width);

/** The report as the command prints it, and as `docs/BENCH.md` quotes it: no time, no path. */
export function formatActionsBench(report: ActionsReport): string {
  const percent = (report.rate * 100).toFixed(1);
  const atLimit = report.askedByLimit > 0 ? ` (${report.askedByLimit} at a limit)` : '';
  const lines = [
    `stroq bench --actions: ${report.total} scenarios of ordinary agent work, ` +
      `${report.interrupted} interrupted (${percent}%)`,
    `asked ${report.asked}${atLimit} · denied ${report.denied} · tool results flagged ${report.flagged}`,
  ];
  const hit = report.scenarios.filter((s) => s.interrupted);
  if (hit.length > 0) {
    lines.push('', 'Interrupted:');
    for (const scenario of hit) {
      for (const step of scenario.steps.filter((s) => s.interrupted)) {
        lines.push(
          `  ${pad(scenario.id, 34)} ${pad(step.verdict ?? '-', 8)} ${pad(step.ruleId ?? '-', 28)} ` +
            `${step.tool}: ${step.subject}`,
        );
      }
    }
  }
  const unjudged = report.scenarios.filter((s) => s.inconclusive);
  if (unjudged.length > 0) {
    lines.push(
      '',
      'Inconclusive (a timeout or an error is no verdict, so these scenarios are not in the numbers above):',
    );
    for (const scenario of unjudged) {
      for (const step of scenario.steps.filter(
        (s) => kindOf(s) === 'timeout' || kindOf(s) === 'error',
      )) {
        lines.push(
          `  ${pad(scenario.id, 34)} ${pad(kindOf(step), 8)} ${step.tool}: ${step.subject}`,
        );
      }
      lines.push(`    ${scenario.reason ?? 'no reason recorded'}`);
    }
  }
  lines.push('', `policy: ${report.policy}`);
  return `${lines.join('\n')}\n`;
}
