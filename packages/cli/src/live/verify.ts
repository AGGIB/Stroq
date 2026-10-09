// `verifyHost`: drive a host on the inert probes and say, from evidence, what it did.
//
// The order is fixed. The host is looked for. Then, before a single request is made, the policy in force
// is asked in process what it says to each probe: a probe the policy does not deny is skipped, not failed,
// because it proves nothing. Then the allow probe is run, then the deny probes, then (if asked) the
// control for each deny that was stopped. Every request is taken from the ledger before it is made.
// A limit, a login that does not work, a bill to the wrong account, a time-out or an error from the host
// stops everything at once: the probes left get `not-attempted` with that reason, and nothing is retried.
//
// Nothing here believes the model. A probe passes on the command having been issued, the hook having
// judged it as the policy said it would, and the disk being as that decision says (`evidence.ts`).
import { randomUUID } from 'node:crypto';
import type { Policy } from '@stroq/core';
import { capabilitiesFor, type HostCapability } from '../hosts/capabilities.js';
import type { Ledger } from './budget.js';
import {
  gatherEvidence,
  markControl,
  markProbe,
  plainText,
  runProblem,
  type ProbeOutcome,
} from './evidence.js';
import { expectedDecision } from './expectation.js';
import { policySha256, writePolicy } from './policy-digest.js';
import { buildProbes, controlOf, newFakeSecret, newNonce, prepareProject } from './probes.js';
import { makeRequest, type Observation } from './request.js';
import {
  caveatsFor,
  downgradeUnarmed,
  nothing,
  overallState,
  toProbeResult,
  type Row,
} from './result.js';
import {
  AGENT_NAME,
  REASONS,
  type Expectation,
  type HostDriver,
  type HostResult,
  type Probe,
  type ProbeContext,
  type SettledExpectation,
} from './types.js';

/** Where the ids of a request come from. A test gives its own so that a failure can name a request. */
export interface IdSource {
  nonce(): string;
  session(): string;
  fake(): string;
}

const DEFAULT_IDS: IdSource = { nonce: newNonce, session: randomUUID, fake: newFakeSecret };

export interface VerifyOptions {
  /** The agent id, as `HOOK_ROWS` in doctor.ts spells it. */
  readonly agent: string;
  /** The policy in force: what each probe is expected to be decided as, and what the hook is given. */
  readonly policy: Policy;
  readonly stroqVersion: string;
  readonly ledger: Ledger;
  /** Run each deny that was stopped again with a hook that allows everything. */
  readonly control?: boolean | undefined;
  /**
   * What produced the answers. A driver that says it is a stand-in makes the result one whatever this
   * says, and this cannot make a stand-in live: the result is live only if neither says otherwise.
   */
  readonly mode?: 'live' | 'stand-in' | undefined;
  /** The most host requests this run may make, on top of what the ledger allows. */
  readonly maxRequests?: number | undefined;
  /** What the host table says of the agent; by default its entry for `agent`. */
  readonly capabilities?: HostCapability | undefined;
  readonly now?: (() => Date) | undefined;
  readonly ids?: Partial<IdSource> | undefined;
  /** How long past a request's deadline a driver that has not answered is waited for. */
  readonly graceMs?: number | undefined;
}

/** The directories and limits of a run. The session, nonce and hook mode are made for each request. */
export type BaseContext = Omit<ProbeContext, 'sessionId' | 'nonce' | 'hookMode'> &
  Partial<Pick<ProbeContext, 'sessionId' | 'nonce' | 'hookMode'>>;

/**
 * Reasons that end the run. Asking again would spend requests on a host that has said it will not
 * answer, or on an account that must not be charged.
 */
const STOPS: ReadonlySet<string> = new Set([
  REASONS.limit,
  REASONS.auth,
  REASONS.apiBilling,
  REASONS.timeout,
  REASONS.hostError,
]);

const DEFAULT_GRACE_MS = 5_000;
const MAX_VERSION_CHARS = 80;

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
  const wanted = probe.kind === 'allow' ? 'allow' : 'deny';
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

/** What a request is for: a probe judged by the hook, or its control, run with a hook that allows all. */
type Step =
  { readonly hook: 'real'; readonly expectation: SettledExpectation } | { readonly hook: 'noop' };

/** The mark of a probe the real hook judged. A log that cannot be read is not a log with no entry. */
function judge(
  probe: Probe,
  nonce: string,
  sessionId: string,
  observed: Observation,
  expectation: SettledExpectation,
): ProbeOutcome {
  const { run, sentinel, audit } = observed;
  const entries = audit.kind === 'read' ? audit.entries : [];
  const input = { probe, nonce, sessionId, run, audit: entries, sentinel, expectation };
  const outcome = markProbe(input);
  if (audit.kind === 'read' || runProblem(run) !== null) return outcome;
  const seen = gatherEvidence(input);
  return {
    mark: 'inconclusive',
    reason: REASONS.auditUnreadable,
    detail: plainText(audit.problem),
    evidence: { E1: seen.E1, E2: null, E3: seen.E3, E4: seen.E4 },
  };
}

/** The requests of one run, and what has to be remembered between them: how many, and whether to stop. */
class Requests {
  private sent = 0;
  private stop: { readonly reason: string; readonly detail: string } | null = null;

  constructor(
    private readonly driver: HostDriver,
    private readonly base: BaseContext,
    private readonly options: VerifyOptions,
    private readonly ids: IdSource,
    private readonly fake: string,
  ) {}

  /** Why no request is to be made now, if there is such a reason. */
  private refusal(): ProbeOutcome | null {
    if (this.stop !== null) return nothing('not-attempted', this.stop.reason, this.stop.detail);
    return this.sent >= (this.options.maxRequests ?? Number.POSITIVE_INFINITY)
      ? nothing(
          'not-attempted',
          REASONS.maxRequests,
          'the limit on requests for this run was reached',
        )
      : null;
  }

  /** One probe, as a request, and the mark it earned; or the reason it was not made. */
  async attempt(index: number, step: Step): Promise<ProbeOutcome> {
    const refused = this.refusal();
    if (refused !== null) return refused;
    const nonce = this.ids.nonce();
    const built = buildProbes(nonce, this.fake)[index];
    if (built === undefined) throw new Error(`no probe at ${index}`);
    const probe = step.hook === 'noop' ? controlOf(built) : built;
    const ctx: ProbeContext = {
      ...this.base,
      sessionId: this.ids.session(),
      nonce,
      hookMode: step.hook,
    };
    const requested = await makeRequest({
      driver: this.driver,
      ledger: this.options.ledger,
      label: `${this.options.agent}: ${probe.id}${step.hook === 'noop' ? ' control' : ''}`,
      probe,
      ctx,
      graceMs: this.options.graceMs ?? DEFAULT_GRACE_MS,
    });
    if (!requested.sent) {
      this.stop = { reason: requested.reason, detail: requested.detail };
      return nothing('not-attempted', requested.reason, requested.detail);
    }
    this.sent += 1;
    const observed = requested.observation;
    const trouble = runProblem(observed.run);
    if (trouble !== null && STOPS.has(trouble.reason)) this.stop = trouble;
    return step.hook === 'noop'
      ? markControl({ probe, nonce, run: observed.run, sentinel: observed.sentinel })
      : judge(probe, nonce, ctx.sessionId, observed, step.expectation);
  }
}

/** What the driver called the host's version, as a line of plain characters; null when it said nothing. */
const versionText = (version: string | null): string | null => {
  const text = version === null ? '' : plainText(version, MAX_VERSION_CHARS);
  return text === '' ? null : text;
};

async function lookFor(
  driver: HostDriver,
): Promise<{ available: boolean; version: string | null; note?: string }> {
  try {
    return await driver.detect();
  } catch {
    return { available: false, version: null, note: 'the driver could not look for the host' };
  }
}

export async function verifyHost(
  driver: HostDriver,
  base: BaseContext,
  options: VerifyOptions,
): Promise<HostResult> {
  if (!AGENT_NAME.test(options.agent)) throw new Error('not an agent name');
  const ids: IdSource = { ...DEFAULT_IDS, ...options.ids };
  const control = options.control === true;
  const detected = await lookFor(driver);
  const fake = ids.fake();
  const templates = buildProbes(ids.nonce(), fake);

  const finish = (rows: readonly Row[], controls: readonly Row[]): HostResult => ({
    version: 1,
    agent: options.agent,
    hostVersion: versionText(detected.version),
    stroqVersion: options.stroqVersion,
    policySha256: policySha256(options.policy),
    at: (options.now ?? ((): Date => new Date()))().toISOString(),
    mode: driver.mode === 'stand-in' || options.mode === 'stand-in' ? 'stand-in' : 'live',
    probes: [...rows, ...controls].map(toProbeResult),
    state: overallState(rows),
    caveats: caveatsFor({
      capabilities: options.capabilities ?? capabilitiesFor(options.agent),
      note: detected.note,
      control,
      rows,
    }),
  });

  if (!detected.available)
    return finish(
      templates.map((probe) => ({
        id: probe.id,
        kind: probe.kind,
        outcome: nothing(
          'not-attempted',
          REASONS.hostNotFound,
          detected.note ?? 'the host was not found',
        ),
      })),
      [],
    );

  // The project holds the made-up key where the index finds it; the home holds the policy the hook reads.
  prepareProject(base.project, fake);
  writePolicy(base.stroqHome, options.policy);

  // Every question to the policy is asked before the first request is made: one that fails after a
  // request has been spent would lose what that request found, and asked first it costs nothing.
  const plans: { readonly probe: Probe; readonly decided: ReturnType<typeof plan> }[] = [];
  for (const probe of templates)
    plans.push({
      probe,
      decided: plan(probe, await expectedDecision(probe, base, options.policy)),
    });

  const requests = new Requests(driver, base, options, ids, fake);
  const rows: Row[] = [];
  for (const [index, { probe, decided }] of plans.entries()) {
    const outcome =
      'skip' in decided
        ? decided.skip
        : await requests.attempt(index, { hook: 'real', expectation: decided.run });
    rows.push({ id: probe.id, kind: probe.kind, outcome });
  }

  const controls: Row[] = [];
  if (control)
    for (const [index, row] of rows.entries())
      if (row.kind !== 'allow' && row.outcome.mark === 'passed')
        controls.push({
          id: `${row.id}:control`,
          kind: row.kind,
          outcome: await requests.attempt(index, { hook: 'noop' }),
        });
  const confirmed = control
    ? rows.map((row) =>
        downgradeUnarmed(row, controls.find((c) => c.id === `${row.id}:control`)?.outcome),
      )
    : rows;
  return finish(confirmed, controls);
}
