// The requests of one run, and what has to be remembered between them: how many, and whether to stop.
//
// A limit, a login that does not work, a bill to the wrong account, a time-out or an error from the host
// stops everything at once: the probes left get `not-attempted` with that reason, and nothing is retried.
// So does a host that does not say how it is paid for, or says it ran somewhere that is not the project.
// Asking again would spend requests on a host that has said it will not answer, or on an account that must
// not be charged.
import { markControl, markProbe, runProblem, type ProbeOutcome } from './evidence.js';
import { buildProbes, controlOf } from './probes.js';
import { makeRequest, type Observation } from './request.js';
import { nothing } from './result.js';
import { claimsProblem } from './run-claims.js';
import {
  REASONS,
  type HostDriver,
  type Probe,
  type ProbeContext,
  type SettledExpectation,
} from './types.js';
import type { BaseContext, IdSource, VerifyOptions } from './verify-types.js';

/** What a request is for: a probe judged by the hook, or its control, run with a hook that allows all. */
export type Step =
  { readonly hook: 'real'; readonly expectation: SettledExpectation } | { readonly hook: 'noop' };

/** Reasons a run is over for: the host said it will not answer, or must not be asked. */
const STOPS: ReadonlySet<string> = new Set([
  REASONS.limit,
  REASONS.auth,
  REASONS.apiBilling,
  REASONS.timeout,
  REASONS.hostError,
]);

const DEFAULT_GRACE_MS = 5_000;

interface Stop {
  readonly reason: string;
  readonly detail: string;
}

/** The mark of a probe the real hook judged. A log that cannot be read is not a log with no entry. */
function judge(
  probe: Probe,
  nonce: string,
  observed: Observation,
  expectation: SettledExpectation,
): ProbeOutcome {
  const { run, sentinel, audit } = observed;
  return markProbe({
    probe,
    nonce,
    run,
    audit: audit.kind === 'read' ? audit.entries : [],
    ...(audit.kind === 'unreadable' ? { auditProblem: audit.problem } : {}),
    sentinel,
    expectation,
  });
}

export class Requests {
  private sent = 0;
  private stop: Stop | null = null;

  constructor(
    private readonly driver: HostDriver,
    private readonly base: BaseContext,
    /** The environment a driver is handed: the caller's, without what bills an API key. */
    private readonly env: Record<string, string>,
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

  /** The probe to ask for, with the ids of its own: the control of a probe is its command, hook out. */
  private prepare(index: number, step: Step): { probe: Probe; ctx: ProbeContext } {
    const nonce = this.ids.nonce();
    const built = buildProbes(nonce, this.fake, this.base.project)[index];
    if (built === undefined) throw new Error(`no probe at ${index}`);
    return {
      probe: step.hook === 'noop' ? controlOf(built) : built,
      ctx: {
        ...this.base,
        env: this.env,
        sessionId: this.ids.session(),
        nonce,
        hookMode: step.hook,
      },
    };
  }

  /** One probe, as a request, and the mark it earned; or the reason it was not made. */
  async attempt(index: number, step: Step): Promise<ProbeOutcome> {
    const refused = this.refusal();
    if (refused !== null) return refused;
    const { probe, ctx } = this.prepare(index, step);
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
    return this.judged(probe, ctx.nonce, step, requested.observation);
  }

  /**
   * The mark of a request that was made, and whether it was the last. What the marks say of the run
   * (a limit, a login, a bill) stops it as it is; what they cannot say, because it is a condition of the
   * whole run and not of one probe (how the host is paid for, where it ran), stops it too, and the mark of
   * the probe says so unless the run already had something to say.
   */
  private judged(probe: Probe, nonce: string, step: Step, observed: Observation): ProbeOutcome {
    const trouble = runProblem(observed.run);
    const claimed = claimsProblem(observed.run, this.base.project);
    if (trouble !== null && STOPS.has(trouble.reason)) this.stop = trouble;
    else if (claimed !== null) this.stop = claimed;
    const marked =
      step.hook === 'noop'
        ? markControl({ probe, nonce, run: observed.run, sentinel: observed.sentinel })
        : judge(probe, nonce, observed, step.expectation);
    return claimed !== null && trouble === null
      ? { ...marked, mark: 'inconclusive', reason: claimed.reason, detail: claimed.detail }
      : marked;
  }
}
