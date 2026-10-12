import type { Policy } from '@stroq/core';
import { runScenario } from '../attack/run.js';
import type { Scenario } from '../attack/scenario.js';
import { SCENARIOS } from '../attack/scenarios/index.js';
import { runActionScenario, type ActionScenario } from '../bench/actions.js';
import { ACTION_SCENARIOS } from '../bench/actions-corpus.js';
import type { UserCase } from './cases.js';
import { fromActionResult, fromAttackResult, unrunnable, type ScenarioRecord } from './records.js';

/** What a run replays: the two bundled corpora, and the person's own cases. */
export interface Suites {
  readonly attack: readonly Scenario[];
  readonly ordinary: readonly ActionScenario[];
  readonly cases: readonly UserCase[];
}

/** The corpora that ship with Stroq: the attack scenarios and the ordinary-work ones. */
export const BUNDLED: Pick<Suites, 'attack' | 'ordinary'> = {
  attack: SCENARIOS,
  ordinary: ACTION_SCENARIOS,
};

/**
 * One of the person's cases, run. A case is somebody's text, so one that cannot be set up (a fixture
 * that cannot be written, a link that cannot be made) is that case's result, `inconclusive`, and does
 * not end the run; the message of the error is not kept, because it can quote the case's own paths.
 */
async function replayCase(item: UserCase, policy: Policy): Promise<ScenarioRecord> {
  try {
    if (item.kind === 'attack') {
      return fromAttackResult(await runScenario(item.scenario, policy), 'cases');
    }
    const result = await runActionScenario(item.scenario, policy);
    // Only the last step is held to the expectation; the ones before it set the scene.
    return fromActionResult(result, 'cases', item.expect);
  } catch {
    return unrunnable('cases', item.scenario.id, item.kind === 'attack');
  }
}

/**
 * Every scenario of the suites, run in this process against `policy` in throwaway folders (the same
 * runners `stroq attack` and `stroq bench --actions` use), as one record per scenario. No network, no
 * command: the engine judges the events, it does not run them.
 */
export async function replay(policy: Policy, suites: Suites): Promise<ScenarioRecord[]> {
  const records: ScenarioRecord[] = [];
  for (const scenario of suites.attack) {
    records.push(fromAttackResult(await runScenario(scenario, policy), 'attack'));
  }
  for (const scenario of suites.ordinary) {
    records.push(fromActionResult(await runActionScenario(scenario, policy), 'ordinary'));
  }
  for (const item of suites.cases) records.push(await replayCase(item, policy));
  return records;
}
