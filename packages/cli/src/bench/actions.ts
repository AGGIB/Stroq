import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, type Policy, type StroqEngine } from '@stroq/core';
import {
  ClaudeHookInputSchema,
  toolResultToText,
  type ClaudeHookEvent,
} from '../adapters/claude-code.js';
import { substituteCwd, writeFixtures } from '../attack/run.js';
import { createEngineAt } from '../engine-factory.js';
import { ACTION_SCENARIOS } from './actions-corpus.js';

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

/** What a step produced: a decision for a tool call, a scan verdict for a tool result. */
export type StepVerdict = 'allow' | 'ask' | 'deny' | 'clean' | 'suspect';

export interface ActionStepResult {
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  /** What the step was, for a person reading the report: the command, the path, the URL. */
  readonly subject: string;
  readonly verdict: StepVerdict;
  /** The rule that decided a tool call, or the first rule that matched a result. */
  readonly ruleId: string | null;
  readonly reason: string | null;
  /** True when the step was anything but allowed (a call) or clean (a result). */
  readonly interrupted: boolean;
}

export interface ActionScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly ActionStepResult[];
  readonly interrupted: boolean;
}

export interface ActionsReport {
  readonly version: 1;
  /** `default` or the path of the policy override that was used. */
  readonly policy: string;
  readonly scenarios: readonly ActionScenarioResult[];
  readonly total: number;
  /** Scenarios in which at least one step was interrupted. */
  readonly interrupted: number;
  readonly asked: number;
  readonly denied: number;
  /** Tool results the scan flagged. */
  readonly flagged: number;
  /** interrupted / total, computed and never typed by a human. */
  readonly rate: number;
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

async function runStep(
  engine: StroqEngine,
  step: ActionStep,
  cwd: string,
): Promise<ActionStepResult> {
  const event = ClaudeHookInputSchema.parse(substituteCwd(step.event, cwd));
  const base = {
    sessionId: event.session_id,
    toolName: event.tool_name,
    toolInput: event.tool_input,
    cwd: event.cwd || cwd,
  };
  const subject = subjectOf(event.tool_name, event.tool_input);
  if (event.hook_event_name === 'PreToolUse') {
    const { decision } = await engine.pre(base);
    return {
      phase: 'pre',
      tool: event.tool_name,
      subject,
      verdict: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.effect === 'allow' ? null : decision.reason,
      interrupted: decision.effect !== 'allow',
    };
  }
  const { scan } = await engine.post({
    ...base,
    toolResultText: toolResultToText(event.tool_response ?? event.tool_result),
  });
  return {
    phase: 'post',
    tool: event.tool_name,
    subject,
    verdict: scan.verdict,
    ruleId: scan.matches[0]?.ruleId ?? null,
    reason: scan.matches[0]?.title ?? null,
    interrupted: scan.verdict !== 'clean',
  };
}

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
    const steps: ActionStepResult[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      try {
        steps.push(await runStep(engine, step, cwd));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`action scenario ${scenario.id} step ${index + 1}: ${message}`);
      }
    }
    return {
      id: scenario.id,
      title: scenario.title,
      steps,
      interrupted: steps.some((s) => s.interrupted),
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
  const steps = results.flatMap((r) => r.steps);
  const count = (verdict: StepVerdict): number => steps.filter((s) => s.verdict === verdict).length;
  const interrupted = results.filter((r) => r.interrupted).length;
  return {
    version: 1,
    policy: policySource,
    scenarios: results,
    total: results.length,
    interrupted,
    asked: count('ask'),
    denied: count('deny'),
    flagged: count('suspect'),
    rate: results.length === 0 ? 0 : interrupted / results.length,
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
  const lines = [
    `stroq bench --actions: ${report.total} scenarios of ordinary agent work, ` +
      `${report.interrupted} interrupted (${percent}%)`,
    `asked ${report.asked} · denied ${report.denied} · tool results flagged ${report.flagged}`,
  ];
  const hit = report.scenarios.filter((s) => s.interrupted);
  if (hit.length > 0) {
    lines.push('', 'Interrupted:');
    for (const scenario of hit) {
      for (const step of scenario.steps.filter((s) => s.interrupted)) {
        lines.push(
          `  ${pad(scenario.id, 34)} ${pad(step.verdict, 8)} ${pad(step.ruleId ?? '-', 28)} ` +
            `${step.tool}: ${step.subject}`,
        );
      }
    }
  }
  lines.push('', `policy: ${report.policy}`);
  return `${lines.join('\n')}\n`;
}
