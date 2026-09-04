import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Policy, StroqEngine } from '@stroq/core';
import { ClaudeHookInputSchema, toolResultToText } from '../adapters/claude-code.js';
import { createEngineAt } from '../engine-factory.js';
import {
  CWD_PLACEHOLDER,
  type Incident,
  type Scenario,
  type ScenarioStep,
  type StepExpectation,
} from './scenario.js';

/** What happened to the attack step: the policy denied it, asked, or let it through. */
export type Outcome = 'blocked' | 'asked' | 'passed';

export interface StepResult {
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly expect: StepExpectation;
  readonly actual: StepExpectation;
  readonly ruleId: string | null;
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly incident: Incident;
  readonly outcome: Outcome;
  /** True when every step produced what the scenario expects. */
  readonly ok: boolean;
  /** The rule that decided the attack step, or null when it was allowed by default. */
  readonly ruleId: string | null;
  readonly steps: readonly StepResult[];
}

export interface AttackReport {
  readonly version: 1;
  /** `default` or the path of the policy override that was used. */
  readonly policy: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly totals: { readonly blocked: number; readonly asked: number; readonly passed: number };
  readonly ok: boolean;
}

const OUTCOME_OF: Readonly<Record<'deny' | 'ask' | 'allow', Outcome>> = {
  deny: 'blocked',
  ask: 'asked',
  allow: 'passed',
};

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

async function writeFixtures(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  }
}

async function runStep(engine: StroqEngine, step: ScenarioStep, cwd: string): Promise<StepResult> {
  const event = ClaudeHookInputSchema.parse(substituteCwd(step.event, cwd));
  const base = {
    sessionId: event.session_id,
    toolName: event.tool_name,
    toolInput: event.tool_input,
    cwd: event.cwd || cwd,
  };
  if (event.hook_event_name === 'PreToolUse') {
    const { decision } = await engine.pre(base);
    return {
      phase: 'pre',
      tool: event.tool_name,
      expect: step.expect,
      actual: decision.effect,
      ruleId: decision.ruleId,
    };
  }
  const { scan } = await engine.post({
    ...base,
    toolResultText: toolResultToText(event.tool_response ?? event.tool_result),
  });
  return {
    phase: 'post',
    tool: event.tool_name,
    expect: step.expect,
    actual: scan.verdict,
    ruleId: null,
  };
}

function outcomeOf(last: StepResult): Outcome {
  if (last.phase !== 'pre') return 'passed';
  return OUTCOME_OF[last.actual as 'deny' | 'ask' | 'allow'];
}

/**
 * Runs one scenario in a fresh temporary root (`project/`, `home/`, `user/`). The
 * policy and the bundled rules are real; sessions, provenance, audit, the secret
 * index, "home" credential files and the environment are all throwaway, so the
 * suite can never read the operator's credentials or touch `~/.stroq`.
 */
export async function runScenario(scenario: Scenario, policy: Policy): Promise<ScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), 'stroq-attack-'));
  try {
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const userHome = join(root, 'user');
    await Promise.all([cwd, home, userHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFixtures(cwd, scenario.files ?? {});
    const engine = createEngineAt({ home, userHome, policy, env: {} });
    const steps: StepResult[] = [];
    for (const step of scenario.steps) steps.push(await runStep(engine, step, cwd));
    const last = steps[steps.length - 1];
    if (!last) throw new Error(`scenario ${scenario.id} has no steps`);
    return {
      id: scenario.id,
      title: scenario.title,
      incident: scenario.incident,
      outcome: outcomeOf(last),
      ok: steps.every((s) => s.actual === s.expect),
      ruleId: last.ruleId,
      steps,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs the scenarios in order (each is a few milliseconds) and totals the outcomes. */
export async function runAttack(
  scenarios: readonly Scenario[],
  policy: Policy,
  policySource: string,
): Promise<AttackReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, policy));
  const count = (outcome: Outcome): number => results.filter((r) => r.outcome === outcome).length;
  return {
    version: 1,
    policy: policySource,
    scenarios: results,
    totals: { blocked: count('blocked'), asked: count('asked'), passed: count('passed') },
    ok: results.every((r) => r.ok),
  };
}
