// `verifyHost`: drive a host on the inert probes and say, from evidence, what it did.
//
// The order is fixed. The host is looked for. Then, before a single request is made, the policy in force
// is asked in process what it says to each probe: a probe the policy does not deny is skipped, not failed,
// because it proves nothing. Then the allow probe is run, and then each deny with its control right after
// it: a deny that was stopped is run again, the same command with a hook that allows everything, and if its
// file does not appear the stop proved nothing. So the fewest requests that can verify a host are three
// (the allow, one deny and its control), a host that fails costs three, and an honest one five. A control
// is not made when the allow did not pass (nothing can be verified then), nor when it is turned off (and
// then no host is verified at all). Every request is taken from the ledger before it is made.
//
// Nothing here believes the model. A probe passes on the command having been issued, the hook having
// judged it as the policy said it would, and the disk being as that decision says (`evidence.ts`).
import { randomUUID } from 'node:crypto';
import type { Policy } from '@stroq/core';
import { capabilitiesFor } from '../hosts/capabilities.js';
import { expectedDecision } from './expectation.js';
import { policySha256, writePolicy } from './policy-digest.js';
import { buildProbes, newFakeSecret, newNonce, prepareProject } from './probes.js';
import { Requests } from './requests.js';
import {
  caveatsFor,
  downgradeUnarmed,
  nothing,
  overallState,
  toProbeResult,
  type Row,
} from './result.js';
import { controlIdOf } from './state-rule.js';
import { assertThrowaway } from './throwaway.js';
import {
  REASONS,
  type Expectation,
  type HostDriver,
  type HostResult,
  type Probe,
  type SettledExpectation,
} from './types.js';
import {
  DEFAULT_DETECT_MS,
  checkInputs,
  hostVersionText,
  lookForHost,
  scrubbedEnv,
  type Detected,
} from './verify-input.js';
import type { BaseContext, IdSource, VerifyOptions } from './verify-types.js';
import type { ProbeOutcome } from './evidence.js';

export type { BaseContext, IdSource, VerifyOptions } from './verify-types.js';

const DEFAULT_IDS: IdSource = { nonce: newNonce, session: randomUUID, fake: newFakeSecret };

const say = (expectation: Expectation): string =>
  `${expectation.effect} (${expectation.ruleId ?? 'no rule'})`;

/**
 * Whether the policy in force makes this a probe at all. An allow probe has to be allowed and a deny
 * probe denied; under a policy that says otherwise (the user relaxed a rule, or tightened one) the
 * probe is skipped with the reason, which is not a failure of anything.
 */
function plan(
  probe: Probe,
  expected: Expectation,
): { readonly run: SettledExpectation } | { readonly skip: ProbeOutcome } {
  // What the probe needs of a policy is what the default policy gives it (`probes-golden.test.ts` holds that).
  const wanted = probe.expected.effect;
  if (expected.effect === wanted) return { run: { effect: wanted, ruleId: expected.ruleId } };
  return {
    skip:
      probe.kind === 'allow'
        ? nothing(
            'skipped',
            REASONS.skippedPolicyBlocksAllow,
            `the active policy gives ${say(expected)} for the allow probe`,
          )
        : nothing(
            'skipped',
            REASONS.skippedPolicyAllows,
            `the active policy gives ${say(expected)} for this command, not a deny`,
          ),
  };
}

/** A probe, and what the policy in force makes of it: a request to make, or the reason there is none. */
interface Planned {
  readonly index: number;
  readonly probe: Probe;
  readonly decided: ReturnType<typeof plan>;
}

/**
 * Every question to the policy is asked before the first request is made: one that fails after a request
 * has been spent would lose what that request found, and asked first it costs nothing.
 */
async function planProbes(
  templates: readonly Probe[],
  base: BaseContext,
  policy: Policy,
): Promise<readonly Planned[]> {
  const planned: Planned[] = [];
  for (const [index, probe] of templates.entries())
    planned.push({
      index,
      probe,
      decided: plan(probe, await expectedDecision(probe, base, policy)),
    });
  return planned;
}

/**
 * What a run came to. `found` are the real probes as the evidence left them (the caveats are about what
 * they found); `listed` is every row in the order it was run, after the controls have had their say.
 */
interface Run {
  readonly found: readonly Row[];
  readonly listed: readonly Row[];
}

/** A deny that was stopped: the one kind of row that has a control to run. */
const isStoppedDeny = (row: Row): boolean => row.kind !== 'allow' && row.outcome.mark === 'passed';

async function runReal(planned: Planned, requests: Requests): Promise<Row> {
  const { index, probe, decided } = planned;
  const outcome =
    'skip' in decided
      ? decided.skip
      : await requests.attempt(index, { hook: 'real', expectation: decided.run });
  return { id: probe.id, kind: probe.kind, outcome };
}

/** The control of a deny that was stopped. Not made when the allow did not pass: nothing can be verified. */
async function runControl(
  planned: Planned,
  stopped: Row,
  requests: Requests,
  allowPassed: boolean,
): Promise<Row> {
  const outcome = allowPassed
    ? await requests.attempt(planned.index, { hook: 'noop' })
    : nothing(
        'not-attempted',
        REASONS.allowNotPassed,
        'the allow probe did not pass, so nothing can be verified and the control was not run',
      );
  return { id: controlIdOf(stopped.id), kind: stopped.kind, outcome };
}

/**
 * The probes in order, each deny followed by its control. A real run that did not pass has no control;
 * one that did is confirmed by its control, or not (`downgradeUnarmed`).
 */
async function runProbes(
  planned: readonly Planned[],
  requests: Requests,
  withControl: boolean,
): Promise<Run> {
  const found: Row[] = [];
  const listed: Row[] = [];
  let allowPassed = false;
  for (const each of planned) {
    const row = await runReal(each, requests);
    found.push(row);
    allowPassed = allowPassed || (row.kind === 'allow' && row.outcome.mark === 'passed');
    const control =
      withControl && isStoppedDeny(row)
        ? await runControl(each, row, requests, allowPassed)
        : undefined;
    listed.push(downgradeUnarmed(row, control?.outcome, withControl));
    if (control !== undefined) listed.push(control);
  }
  return { found, listed };
}

/** A host that is not there: every probe is not attempted, and says why. */
function hostNotFound(templates: readonly Probe[], detected: Detected): Run {
  const rows = templates.map((probe): Row => ({
    id: probe.id,
    kind: probe.kind,
    outcome: nothing(
      'not-attempted',
      REASONS.hostNotFound,
      detected.note ?? 'the host was not found',
    ),
  }));
  return { found: rows, listed: rows };
}

/** What the result is made of besides what the run found. */
interface Settings {
  readonly driver: HostDriver;
  readonly options: VerifyOptions;
  readonly detected: Detected;
  /** When the check began: an install that finished while it ran is later than it, and not earlier. */
  readonly startedAt: Date;
}

/** The result: the state is that of the rows and the controls together, the caveats are about what the real runs found. */
function assemble(settings: Settings, run: Run): HostResult {
  const { driver, options, detected } = settings;
  return {
    version: 1,
    agent: options.agent,
    hostVersion: hostVersionText(detected.version),
    stroqVersion: options.stroqVersion,
    policySha256: policySha256(options.policy),
    at: settings.startedAt.toISOString(),
    // Live only when the driver says it is: a driver that does not say what it is makes a stand-in.
    mode: driver.mode === 'live' && options.mode !== 'stand-in' ? 'live' : 'stand-in',
    probes: run.listed.map(toProbeResult),
    state: overallState(run.listed),
    caveats: caveatsFor({
      capabilities: options.capabilities ?? capabilitiesFor(options.agent),
      note: detected.note,
      control: options.control !== false,
      rows: run.found,
    }),
  };
}

export async function verifyHost(
  driver: HostDriver,
  base: BaseContext,
  options: VerifyOptions,
): Promise<HostResult> {
  // What is handed over is looked at before anything else is done with it.
  checkInputs(base, options);
  // Before the host is asked anything and before a file is made or removed: the check writes and
  // deletes in these directories, and a run that was pointed at the wrong ones must end here.
  for (const dir of [base.project, base.stroqHome, base.home]) assertThrowaway(dir);
  const startedAt = (options.now ?? ((): Date => new Date()))();
  const ids: IdSource = { ...DEFAULT_IDS, ...options.ids };
  const detected = await lookForHost(driver, options.detectMs ?? DEFAULT_DETECT_MS);
  const fake = ids.fake();
  const templates = buildProbes(ids.nonce(), fake, base.project);
  const settings: Settings = { driver, options, detected, startedAt };
  if (!detected.available) return assemble(settings, hostNotFound(templates, detected));

  // The project holds the made-up key where the index finds it; the home holds the policy the hook reads.
  prepareProject(base.project, fake);
  writePolicy(base.stroqHome, options.policy);
  const planned = await planProbes(templates, base, options.policy);
  const requests = new Requests(driver, base, scrubbedEnv(base.env), options, ids, fake);
  return assemble(settings, await runProbes(planned, requests, options.control !== false));
}
