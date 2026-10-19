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
import {
  hostStepSupport,
  type AttackChannel,
  type AttackHost,
  type ChannelStatus,
} from '../hosts/channels.js';
import { ATTACK_CORPUS_ID, buildMeta, type ReportMeta } from './report.js';
import {
  CWD_PLACEHOLDER,
  HOME_PLACEHOLDER,
  type Incident,
  type Scenario,
  type StepExpectation,
} from './scenario.js';

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
 * - `unsupported`: under `--host <id>`, at least one step uses a channel the host never sends
 *   (`not seen` or `unknown`). Counted apart from `blocked`, `asked` and `passed`, and never as
 *   a protection.
 */
export type Outcome =
  'blocked' | 'asked' | 'asked-by-limit' | 'passed' | 'timeout' | 'error' | 'unsupported';

/** A step as `stroq attack` reports it: the shared result, with the expectation the scenario set. */
export type StepResult = SharedStepResult & { readonly expect: StepExpectation };

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
  /** True when every step produced what the scenario expects, and none timed out, threw or was unsupported. */
  readonly ok: boolean;
  /** The rule that decided the attack step, or null when it was allowed by default or unsupported. */
  readonly ruleId: string | null;
  readonly steps: readonly StepResult[];
  /** Count of steps in this scenario that the target `--host` never sends. */
  readonly unsupportedSteps?: number;
}

export interface UnsupportedStepRecord {
  readonly scenarioId: string;
  readonly step: number;
  readonly phase: 'pre' | 'post';
  readonly tool: string;
  readonly channel: AttackChannel;
  readonly status: ChannelStatus;
  readonly evidence: string;
}

export interface RunAttackOptions {
  readonly host?: AttackHost;
}

/**
 * How many scenarios ended in each outcome. The outcome counts partition the scenarios: each
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
  /** Scenarios with at least one step the target `--host` never sends (present when `--host` is set). */
  readonly unsupported?: number;
  /** Total steps across all scenarios that the target `--host` never sends (present when `--host` is set). */
  readonly unsupportedSteps?: number;
}

export interface AttackReport {
  /** 2 since the outcomes were told apart (`timeout`, `error`, `asked-by-limit`) and `meta` was added. */
  readonly version: 2;
  readonly meta: ReportMeta;
  /** `default` or the path of the policy override that was used. */
  readonly policy: string;
  readonly host?: AttackHost;
  readonly unsupportedSteps?: readonly UnsupportedStepRecord[];
  readonly scenarios: readonly ScenarioResult[];
  readonly totals: AttackTotals;
  /** False when an attack passed, a scenario is inconclusive, a step is unsupported, or any scenario did not behave as expected. */
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
 * What the attack came to. Under `--host`, a scenario with any step the host never sends is
 * `unsupported`, counted apart from `blocked`, `asked` and `passed`, and never as a protection.
 * Otherwise an attack that got through is `passed` whatever else happened: an earlier step that
 * timed out makes the scenario inconclusive, and must not hide it. Past that, an error or a
 * timeout anywhere in the scenario decides, and only then does the attack step itself decide.
 */
function outcomeOf(steps: readonly StepResult[], kinds: readonly StepKind[]): Outcome {
  const attack = steps[steps.length - 1];
  const attackKind = kinds[kinds.length - 1];
  if (attack === undefined || attackKind === undefined) throw new Error('runAttack: no steps ran');
  if (kinds.includes('unsupported')) return 'unsupported';
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
function resultOf(
  scenario: Scenario,
  steps: readonly StepResult[],
  host?: AttackHost,
): ScenarioResult {
  const kinds = steps.map(stepKind);
  const trouble = steps.flatMap((step, index) => troubleOf(step, index) ?? []);
  const inconclusive = trouble.length > 0;
  const unsupportedCount = steps.filter((s) => s.unsupported === true).length;
  return {
    id: scenario.id,
    title: scenario.title,
    incident: scenario.incident,
    class: scenario.class,
    outcome: outcomeOf(steps, kinds),
    inconclusive,
    reason: inconclusive ? trouble.join('; ') : null,
    // A scenario that stopped at a step that threw has not run every step; an unsupported step is never a pass.
    ok:
      !inconclusive &&
      unsupportedCount === 0 &&
      steps.length === scenario.steps.length &&
      steps.every((s) => s.actual === s.expect),
    ruleId: unsupportedCount > 0 ? null : (steps[steps.length - 1]?.ruleId ?? null),
    steps,
    ...(host === undefined ? {} : { unsupportedSteps: unsupportedCount }),
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
  host?: AttackHost,
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
      const phase = step.event.hook_event_name === 'PreToolUse' ? 'pre' : 'post';
      const toolName = String(step.event.tool_name);
      if (host !== undefined) {
        const support = hostStepSupport(host, phase, toolName);
        if (!support.supported) {
          steps.push({
            phase,
            tool: toolName,
            expect: step.expect,
            actual: null,
            ruleId: null,
            reason: null,
            signals: [],
            timedOut: false,
            channel: support.channel,
            unsupported: true,
            hostStatus: support.cell.status,
          });
          continue;
        }
      }
      const label = stepLabel('scenario', scenario.id, index, step.event);
      const hostFields =
        host === undefined
          ? {}
          : (() => {
              const support = hostStepSupport(host, phase, toolName);
              return {
                channel: support.channel,
                unsupported: false,
                hostStatus: support.cell.status,
              };
            })();
      const result: StepResult = {
        ...(await runStep(engine, step, cwd, label)),
        expect: step.expect,
        ...hostFields,
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
export function totalsOf(
  results: readonly ScenarioResult[],
  includeUnsupported = false,
): AttackTotals {
  const count = (outcome: Outcome): number => results.filter((r) => r.outcome === outcome).length;
  const unsupported = count('unsupported');
  const unsupportedSteps = results.reduce(
    (sum, r) => sum + r.steps.filter((s) => s.unsupported === true).length,
    0,
  );
  return {
    blocked: count('blocked'),
    asked: count('asked'),
    askedByLimit: count('asked-by-limit'),
    passed: count('passed'),
    timeout: count('timeout'),
    error: count('error'),
    inconclusive: results.filter((r) => r.inconclusive).length,
    ...(includeUnsupported || unsupported > 0 || unsupportedSteps > 0
      ? { unsupported, unsupportedSteps }
      : {}),
  };
}

/** Runs the scenarios in order (each is a few milliseconds) and totals the outcomes. */
export async function runAttack(
  scenarios: readonly Scenario[],
  policy: Policy,
  policySource: string,
  options?: RunAttackOptions,
): Promise<AttackReport> {
  const host = options?.host;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, policy, host));
  const totals = totalsOf(results, host !== undefined);
  const unsupportedList: UnsupportedStepRecord[] = [];
  if (host !== undefined) {
    for (const r of results) {
      r.steps.forEach((step, idx) => {
        if (step.unsupported === true) {
          const support = hostStepSupport(host, step.phase, step.tool);
          unsupportedList.push({
            scenarioId: r.id,
            step: idx + 1,
            phase: step.phase,
            tool: step.tool,
            channel: support.channel,
            status: support.cell.status,
            evidence: support.cell.evidence,
          });
        }
      });
    }
  }
  return {
    version: 2,
    meta: buildMeta({
      policy,
      policySource,
      corpusId: ATTACK_CORPUS_ID,
      scenarios,
      ...(host === undefined ? {} : { host }),
    }),
    policy: policySource,
    ...(host === undefined ? {} : { host, unsupportedSteps: unsupportedList }),
    scenarios: results,
    totals,
    // Structurally honest: a report can never claim success while an attack passed through, while
    // a scenario could not be judged, or while a step was unsupported on the target host.
    ok:
      results.every((r) => r.ok) &&
      totals.passed === 0 &&
      totals.inconclusive === 0 &&
      (totals.unsupported ?? 0) === 0,
  };
}
