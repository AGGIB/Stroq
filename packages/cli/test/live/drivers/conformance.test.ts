import type { AuditEntry } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { hostRunOf } from '../../../src/live/drivers/claude.js';
import { parseClaudeStream } from '../../../src/live/drivers/claude-stream.js';
import { markControl, markProbe, type ProbeOutcome } from '../../../src/live/evidence.js';
import { buildProbes, controlOf } from '../../../src/live/probes.js';
import { downgradeUnarmed, overallState, type Row } from '../../../src/live/result.js';
import { REASONS, type HostRun, type Probe, type SentinelState } from '../../../src/live/types.js';
import { runProblem } from '../../../src/live/run-problem.js';
import { billingProblem } from '../../../src/live/run-claims.js';
import { auditFor } from '../helpers.js';
import {
  AUDITS,
  FIXTURE_FAKE,
  FIXTURE_NONCE,
  FIXTURE_PROJECT,
  STREAMS,
  auditOf,
  readFixture,
  type FixtureName,
} from './fixtures.js';

/**
 * The cleaned streams of a real Claude Code 2.1.271, replayed offline through the parser and the marks of the
 * live check: what the parser makes of what a real host printed, and what the evidence rules make of that, with
 * the audit log the hook wrote in the same run. The real host is not run; its output was kept
 * (`test/fixtures/hosts/claude-code/README.md`).
 *
 * The probes are built from the nonce, the made-up key and the project every cleaned stream says (the
 * cleaner puts the same ones in all of them), so each command in a stream is the one `buildProbes` makes.
 *
 * The disk is not part of the fixtures: a capture did not keep the file a probe leaves. Its state here is
 * what the outcome of the run says it was, and each case says which: a command that ran left the file it
 * writes, one that was stopped or never issued left nothing.
 */
const ABSENT: SentinelState = { exists: false, content: null };

/** The file as the command of a probe leaves it, when it ran. */
const leftBy = (probe: Pick<Probe, 'sentinel'>): SentinelState => ({
  exists: true,
  content: `${probe.sentinel.holds}\n`,
});

const probeOf = (id: Probe['id']): Probe => {
  const found = buildProbes(FIXTURE_NONCE, FIXTURE_FAKE, FIXTURE_PROJECT).find((p) => p.id === id);
  if (found === undefined) throw new Error(`no ${id} probe`);
  return found;
};

/** The run the driver hands over for a stream that ended as a run ends. */
function runOf(stream: FixtureName): HostRun {
  const { parsed } = parseClaudeStream(readFixture(stream));
  return hostRunOf(parsed, {
    exitCode: 0,
    timedOut: false,
    stderrTail: '',
    stoppedByReader: false,
    interrupted: false,
  });
}

const entriesOf = (audit: FixtureName): AuditEntry[] => auditOf(audit) as unknown as AuditEntry[];

function real(
  stream: FixtureName,
  audit: readonly AuditEntry[],
  id: Probe['id'],
  sentinel: SentinelState,
): ProbeOutcome {
  const probe = probeOf(id);
  return markProbe({
    probe,
    nonce: FIXTURE_NONCE,
    run: runOf(stream),
    audit,
    sentinel,
    expectation: probe.expected,
  });
}

function control(stream: FixtureName, id: Probe['id'], sentinel: SentinelState): ProbeOutcome {
  return markControl({
    probe: controlOf(probeOf(id)),
    nonce: FIXTURE_NONCE,
    run: runOf(stream),
    sentinel,
  });
}

describe('what the evidence rules make of the streams of a real Claude Code 2.1.271', () => {
  it('passes the allow probe that ran, on a command issued, judged by the hook and a file there', () => {
    const outcome = real(
      STREAMS.allowRan,
      entriesOf(AUDITS.allow),
      'allow',
      leftBy(probeOf('allow')),
    );
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'ran' });
    expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: null });
  });

  it('passes the deny probe the hook stopped, in the words of the hook, with no file made', () => {
    const outcome = real(STREAMS.denyBlocked, entriesOf(AUDITS.deny), 'deny', ABSENT);
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'blocked' });
    expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
  });

  it('arms the control of the deny probe: the same command ran under a hook that does nothing', () => {
    const outcome = control(STREAMS.denyControl, 'deny', leftBy(probeOf('deny')));
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'armed' });
  });

  it("does not arm the control the host's own permission step stopped, and says the probe is not armed", () => {
    const outcome = control(STREAMS.denyControlUnarmed, 'deny', ABSENT);
    expect(outcome).toMatchObject({ mark: 'inconclusive', reason: 'probe-not-armed' });
  });

  it("does not take the host's own words for the hook's: the same stop, worded by the host, has no E4", () => {
    const probe = probeOf('deny');
    // The hook, had it been in the loop, judging the command as it is judged.
    const outcome = real(STREAMS.denyControlUnarmed, [auditFor(probe)], 'deny', ABSENT);
    expect(outcome.evidence.E4).toBe(false);
  });

  it('does not pass the secret-egress probe the model declined: no command was issued, and nothing else shows one', () => {
    const outcome = real(STREAMS.egressRefused, [], 'secret-egress', ABSENT);
    expect(outcome).toMatchObject({ mark: 'not-issued', reason: 'not-issued' });
    expect(outcome.evidence.E1).toBe(false);
  });
});

describe('what a run of a real host makes of its whole', () => {
  const allow: Row = {
    id: 'allow',
    kind: 'allow',
    outcome: real(STREAMS.allowRan, entriesOf(AUDITS.allow), 'allow', leftBy(probeOf('allow'))),
  };
  const deny: Row = {
    id: 'deny',
    kind: 'deny',
    outcome: real(STREAMS.denyBlocked, entriesOf(AUDITS.deny), 'deny', ABSENT),
  };
  const denyControl: Row = {
    id: 'deny:control',
    kind: 'deny',
    outcome: control(STREAMS.denyControl, 'deny', leftBy(probeOf('deny'))),
  };
  const denyControlUnarmed: Row = {
    id: 'deny:control',
    kind: 'deny',
    outcome: control(STREAMS.denyControlUnarmed, 'deny', ABSENT),
  };
  const egress: Row = {
    id: 'secret-egress',
    kind: 'secret-egress',
    outcome: real(STREAMS.egressRefused, [], 'secret-egress', ABSENT),
  };

  it('verifies the host on three requests: the allow, the deny, and the deny control', () => {
    const rows = [allow, downgradeUnarmed(deny, denyControl.outcome), denyControl];
    expect(overallState(rows)).toBe('verified');
    expect(rows[1]?.outcome).toMatchObject({ mark: 'passed', reason: 'blocked' });
  });

  it('is still verified when the model declines the secret-egress probe, which is the optional one', () => {
    const rows = [allow, downgradeUnarmed(deny, denyControl.outcome), denyControl, egress];
    expect(overallState(rows)).toBe('verified');
    expect(rows[3]?.outcome).toMatchObject({ mark: 'not-issued', reason: 'not-issued' });
  });

  it("is not verified when the host's own step stops the control, because then the deny proves nothing", () => {
    const rows = [allow, downgradeUnarmed(deny, denyControlUnarmed.outcome), denyControlUnarmed];
    expect(rows[1]?.outcome).toMatchObject({ mark: 'inconclusive', reason: 'probe-not-armed' });
    expect(overallState(rows)).toBe('inconclusive');
  });

  it('is not verified on the allow probe alone', () => {
    expect(overallState([allow])).toBe('inconclusive');
  });
});

describe('what a host that does not say who is paid for it comes to (2.1.144)', () => {
  it('has a result line with no provider, so the host is not asked for more requests', () => {
    const run = runOf(STREAMS.noProvider);
    expect('apiProvider' in run).toBe(false);
    expect(run.apiKeySource).toBe('none');
    // Nothing is wrong with the run itself; it is the claim about billing that cannot be made.
    expect(runProblem(run)).toBeNull();
    expect(billingProblem(run)).toMatchObject({ reason: REASONS.billingUnknown });
  });

  it('is the other way for 2.1.271: it names the provider, and how it is paid for is known', () => {
    const run = runOf(STREAMS.allowRan);
    expect(run.apiProvider).toBe('firstParty');
    expect(billingProblem(run)).toBeNull();
  });
});
