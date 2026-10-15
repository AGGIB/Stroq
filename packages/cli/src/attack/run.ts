import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Policy } from '@stroq/core';
import { createEngineAt } from '../engine-factory.js';
import {
  runStep,
  stepKind,
  stepLabel,
  substituteCwd,
  troubleOf,
  type StepKind,
  type StepResult as SharedStepResult,
} from '../harness/step.js';
import { ATTACK_CORPUS_ID, buildMeta, type ReportMeta } from './report.js';
import {
  CWD_PLACEHOLDER,
  HOME_PLACEHOLDER,
  type Incident,
  type Scenario,
  type StepExpectation,
} from './scenario.js';

import type { Channel, ChannelStatus } from '../hosts/channels.js';
import { isStepSupportedOnHost } from '../hosts/channels.js';

// Re-exported: the placeholder substitution moved to the shared step runner, and callers (and the
// tests) have always found it here.
export { substituteCwd };

/**
 * What happened to the attack, told apart so that none of them can pass for another.
 *
 * - `blocked`: a rule denied the attack step.
 * - `asked`: a rule put the attack step to the user as a question.
 * - `asked-by-limit`: it was asked about because Stroq could not read it (a command too large, a
 *   tool with no command): the same answer on every machine, but no rule named the danger.
 * - `passed`: the attack step was allowed. The attack succeeded.
 * - `timeout`: a step's answer depended on the clock (the scan ran out of its budget, the reading
 *   of a command ran past its deadline). A timeout fails closed, which looks exactly like a rule
 *   catching the attack, so it is never counted as one.
 * - `error`: a step threw; there is no answer.
 */
export type Outcome = 'blocked' | 'asked' | 'asked-by-limit' | 'passed' | 'timeout' | 'error';

/** A step as `stroq attack` reports it: the shared result, with the expectation the scenario set. */
export type StepResult = SharedStepResult & {
  readonly expect: StepExpectation;
  readonly channel?: Channel;
  readonly supported?: boolean;
  readonly supportStatus?: ChannelStatus;
};

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly incident: Incident | null;
  /** What class of attack a synthetic cell models. Null exactly when `incident` is set. */
  readonly class: string | null;
  readonly outcome: Outcome;
  /**
   * True when a step timed out or threw, so the run says nothing sure about the policy. An
   * inconclusive scenario is never ok, whatever the steps that did run produced.
   */
  readonly inconclusive: boolean;
  /** What made the scenario inconclusive, step by step; null when it is not. */
  readonly reason: string | null;
  /** True when every step produced what the scenario expects, and none timed out or threw. */
  readonly ok: boolean;
  /** The rule that decided the attack step, or null when it was allowed by default. */
  readonly ruleId: string | null;
  readonly steps: readonly StepResult[];
  readonly host?: string;
  readonly unsupportedSteps?: readonly number[];
}

/**
 * How many scenarios ended in each outcome. The six outcome counts partition the scenarios: each
 * scenario is counted once, in the bucket of its `outcome`, so they add up to the number of
 * scenarios. `inconclusive` counts the scenarios flagged inconclusive, and is not part of that sum:
 * it is the timeouts and the errors, and also a scenario whose attack passed after an earlier step
 * timed out (counted as `passed`, because an attack that got through is never hidden).
 */
export interface AttackTotals {
  readonly blocked: number;
  /** Asked by a rule. Asks at a limit are `askedByLimit`, not counted here. */
  readonly asked: number;
  readonly askedByLimit: number;
  readonly passed: number;
  readonly timeout: number;
  readonly error: number;
  readonly inconclusive: number;
  readonly unsupportedSteps?: number;
  readonly unsupportedScenarios?: number;
}

export interface AttackReport {
  /** 2 since the outcomes were told apart (`timeout`, `error`, `asked-by-limit`) and `meta` was added. */
  readonly version: 2;
  readonly meta: ReportMeta;
  /** `default` or the path of the policy override that was used. */
  readonly policy: string;
  readonly host?: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly totals: AttackTotals;
  /** False when an attack passed, a scenario is inconclusive, or any scenario did not behave as expected. */
  readonly ok: boolean;
}

/** Resolves a fixture path under `dir`; refuses any path a `..` segment would carry outside it. */
function containedPath(dir: string, rel: string): string {
  const file = join(dir, rel);
  const outside = relative(dir, resolve(file));
  if (outside.startsWith('..') || isAbsolute(outside)) {
    throw new Error(`scenario fixture path escapes the project directory: ${rel}`);
  }
  return file;
}

export async function writeFixtures(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const file = containedPath(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  }
}

async function writeLinks(
  dir: string,
  home: string,
  links: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [rel, target] of Object.entries(links)) {
    const link = containedPath(dir, rel);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target.split(HOME_PLACEHOLDER).join(home).split(CWD_PLACEHOLDER).join(dir), link);
  }
}

/**
 * The mistakes in how a scenario is written, found before anything is run: these are bugs in the
 * corpus and are thrown, unlike a step that fails while it runs, which is a result.
 */
function checkShape(scenario: Scenario): void {
  const last = scenario.steps[scenario.steps.length - 1];
  if (!last) throw new Error(`scenario ${scenario.id} has no steps`);
  if (last.event.hook_event_name !== 'PreToolUse') {
    throw new Error(
      `scenario ${scenario.id}: the last step must be a PreToolUse (the attack itself)`,
    );
  }
  if (last.expect === 'allow') {
    throw new Error(
      `scenario ${scenario.id}: the attack step must be expected to be denied or asked`,
    );
  }
}

/**
 * What the attack came to. An attack that got through is `passed` whatever else happened: an earlier
 * step that timed out makes the scenario inconclusive, and must not hide it. Past that, an error or
 * a timeout anywhere in the scenario decides, because the denial of the attack step may be nothing
 * but the fail-closed answer of the step before it (a scan that ran out of budget taints the session,
 * and the tainted session is denied the attack). Only then does the attack step itself decide.
 */
function outcomeOf(steps: readonly StepResult[], kinds: readonly StepKind[]): Outcome {
  const attack = steps[steps.length - 1];
  const attackKind = kinds[kinds.length - 1];
  if (attack === undefined || attackKind === undefined) throw new Error('runAttack: no steps ran');
  if (attackKind === 'decided' && attack.actual === 'allow') return 'passed';
  if (kinds.includes('error')) return 'error';
  if (kinds.includes('timeout')) return 'timeout';
  if (attack.actual === 'deny') return 'blocked';
  if (attack.actual === 'ask') return attackKind === 'asked-by-limit' ? 'asked-by-limit' : 'asked';
  // Narrowed honestly instead of cast: `engine.pre` cannot produce anything else.
  throw new Error(
    `runAttack: a PreToolUse step produced an unexpected decision effect "${String(attack.actual)}"`,
  );
}

/** The result of a scenario from the steps that ran. */
function resultOf(scenario: Scenario, steps: readonly StepResult[], host?: string): ScenarioResult {
  const kinds = steps.map(stepKind);
  const trouble = steps.flatMap((step, index) => troubleOf(step, index) ?? []);
  const inconclusive = trouble.length > 0;
  const unsupportedSteps: readonly number[] = host
    ? steps
        .map((s, idx) => (s.supported === false ? idx + 1 : null))
        .filter((idx): idx is number => idx !== null)
    : [];
  const hasUnsupported = host !== undefined && unsupportedSteps.length > 0;

  return {
    id: scenario.id,
    title: scenario.title,
    incident: scenario.incident,
    class: scenario.class,
    outcome: outcomeOf(steps, kinds),
    inconclusive,
    reason: inconclusive ? trouble.join('; ') : null,
    // A scenario that stopped at a step that threw has not run every step.
    ok:
      !inconclusive &&
      !hasUnsupported &&
      steps.length === scenario.steps.length &&
      steps.every((s) => s.actual === s.expect),
    ruleId: steps[steps.length - 1]?.ruleId ?? null,
    steps,
    ...(host !== undefined ? { host, unsupportedSteps } : {}),
  };
}

/**
 * Runs one scenario in a fresh temporary root (`project/`, `home/`, `user/`). The
 * policy and the bundled rules are real; sessions, provenance, audit, the secret
 * index, "home" credential files and the environment are all throwaway, so the
 * suite can never read the operator's credentials or touch `~/.stroq`.
 *
 * A step that throws ends the scenario there and is its result (`error`); it does not end the run.
 */
export async function runScenario(
  scenario: Scenario,
  policy: Policy,
  host?: string,
): Promise<ScenarioResult> {
  checkShape(scenario);
  const root = await mkdtemp(join(tmpdir(), 'stroq-attack-'));
  try {
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const userHome = join(root, 'user');
    await Promise.all([cwd, home, userHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFixtures(cwd, scenario.files ?? {});
    await writeLinks(cwd, userHome, scenario.links ?? {});
    const engine = createEngineAt({ home, userHome, policy, env: {} });
    const steps: StepResult[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      const label = stepLabel('scenario', scenario.id, index, step.event);
      const stepExecution = await runStep(engine, step, cwd, label);
      let stepSupport: ReturnType<typeof isStepSupportedOnHost> = null;
      if (host) {
        stepSupport = isStepSupportedOnHost(host, step.event);
      }
      const result: StepResult = {
        ...stepExecution,
        expect: step.expect,
        ...(stepSupport
          ? {
              channel: stepSupport.channel,
              supported: stepSupport.supported,
              supportStatus: stepSupport.status,
            }
          : {}),
      };
      steps.push(result);
      // What follows would run against a session the scenario did not mean to leave behind.
      if (result.error !== undefined) break;
    }
    return resultOf(scenario, steps, host);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Counts each scenario once, in the bucket of its outcome (see `AttackTotals`). */
export function totalsOf(results: readonly ScenarioResult[], host?: string): AttackTotals {
  const count = (outcome: Outcome): number => results.filter((r) => r.outcome === outcome).length;
  const unsupportedSteps = results.reduce(
    (acc, r) => acc + (r.unsupportedSteps ? r.unsupportedSteps.length : 0),
    0,
  );
  const unsupportedScenarios = results.filter(
    (r) => r.unsupportedSteps && r.unsupportedSteps.length > 0,
  ).length;

  return {
    blocked: count('blocked'),
    asked: count('asked'),
    askedByLimit: count('asked-by-limit'),
    passed: count('passed'),
    timeout: count('timeout'),
    error: count('error'),
    inconclusive: results.filter((r) => r.inconclusive).length,
    ...(host !== undefined ? { unsupportedSteps, unsupportedScenarios } : {}),
  };
}

/** Runs the scenarios in order (each is a few milliseconds) and totals the outcomes. */
export async function runAttack(
  scenarios: readonly Scenario[],
  policy: Policy,
  policySource: string,
  host?: string,
): Promise<AttackReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, policy, host));
  const totals = totalsOf(results, host);
  const hasUnsupported = (totals.unsupportedSteps ?? 0) > 0;
  return {
    version: 2,
    meta: buildMeta({ policy, policySource, corpusId: ATTACK_CORPUS_ID, scenarios }),
    policy: policySource,
    ...(host !== undefined ? { host } : {}),
    scenarios: results,
    totals,
    // Structurally honest: a report can never claim success while an attack passed through, or
    // while a scenario could not be judged, even if some future path produced a scenario whose
    // own `ok` flag was true.
    ok:
      results.every((r) => r.ok) &&
      totals.passed === 0 &&
      totals.inconclusive === 0 &&
      !hasUnsupported,
  };
}
