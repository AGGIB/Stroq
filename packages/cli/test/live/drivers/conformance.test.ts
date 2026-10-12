import type { AuditEntry } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { hostRunOf } from '../../../src/live/drivers/claude.js';
import { parseClaudeStream } from '../../../src/live/drivers/claude-stream.js';
import { markControl, markProbe, type ProbeOutcome } from '../../../src/live/evidence.js';
import { buildProbes } from '../../../src/live/probes.js';
import { downgradeUnarmed, overallState, type Row } from '../../../src/live/result.js';
import { controlOf } from '../../../src/live/probes.js';
import type { HostRun, Probe, SentinelState } from '../../../src/live/types.js';
import { FAKE, auditFor } from '../helpers.js';
import {
  AUDITS,
  FIXTURE_PROJECT,
  STREAMS,
  auditOf,
  readFixture,
  type FixtureName,
} from './fixtures.js';

/**
 * The cleaned streams of a real Claude Code, replayed offline through the parser and the marks of the live
 * check: what the parser makes of what a real host printed, and what the evidence rules make of that, with
 * the audit log the hook wrote in the same run. The real host is not run; its output was kept
 * (`test/fixtures/hosts/claude-code/README.md`).
 *
 * The disk is not part of the fixtures: a capture did not keep the file a probe leaves. Its state here is
 * what the outcome of the run says it was, and each case says which: a command that ran left its file with
 * the nonce, one that was stopped left nothing.
 */
const THERE = (nonce: string): SentinelState => ({ exists: true, content: `${nonce}\n` });
const ABSENT: SentinelState = { exists: false, content: null };

/** The nonce of the request that a stream records, from the command in its call. */
function nonceOf(stream: FixtureName): string {
  const found = /stroq-live-[0-9a-f]{16}/.exec(readFixture(stream));
  if (found === null) throw new Error(`no nonce in ${stream.file}`);
  return found[0];
}

/** The made-up key of a stream that holds one, as the probes are built around it. */
const fakeOf = (stream: FixtureName): string =>
  /stroq_attack_[0-9a-f]{24}/.exec(readFixture(stream))?.[0] ?? FAKE;

function probeOf(stream: FixtureName, id: string): Probe {
  const found = buildProbes(nonceOf(stream), fakeOf(stream), FIXTURE_PROJECT).find(
    (p) => p.id === id,
  );
  if (found === undefined) throw new Error(`no ${id} probe`);
  return found;
}

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
  audit: FixtureName,
  id: string,
  sentinel: SentinelState,
): ProbeOutcome {
  const probe = probeOf(stream, id);
  return markProbe({
    probe,
    nonce: nonceOf(stream),
    run: runOf(stream),
    audit: entriesOf(audit),
    sentinel,
    expectation: probe.expected,
  });
}

function control(stream: FixtureName, id: string, sentinel: SentinelState): ProbeOutcome {
  const probe = controlOf(probeOf(stream, id));
  return markControl({ probe, nonce: nonceOf(stream), run: runOf(stream), sentinel });
}

describe('what the evidence rules make of the streams of a real Claude Code', () => {
  it('passes the allow probe that ran, on a command issued, judged by the hook and a file there', () => {
    const outcome = real(STREAMS.allowRan, AUDITS.allow, 'allow', THERE(nonceOf(STREAMS.allowRan)));
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'ran' });
    expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: null });
  });

  it('does not pass the allow probe the host stopped by its own rules (dontAsk), which is why the mode is not used', () => {
    const outcome = real(STREAMS.allowHostBlocked, AUDITS.allowDontAsk, 'allow', ABSENT);
    expect(outcome).toMatchObject({ mark: 'inconclusive', reason: 'effect-missing' });
  });

  it('passes the made-up key probe the hook stopped, in the words of the hook', () => {
    const outcome = real(STREAMS.egressBlocked, AUDITS.egress, 'secret-egress', ABSENT);
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'blocked' });
    expect(outcome.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true });
  });

  it('arms the control of the made-up key probe: the same command ran under a hook that does nothing', () => {
    const outcome = control(
      STREAMS.egressControl,
      'secret-egress',
      THERE(nonceOf(STREAMS.egressControl)),
    );
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'armed' });
  });

  it('passes the git-hook probe the hook stopped, in the words of the hook', () => {
    const outcome = real(STREAMS.denyBlocked, AUDITS.deny, 'deny', ABSENT);
    expect(outcome).toMatchObject({ mark: 'passed', reason: 'blocked' });
    expect(outcome.evidence.E4).toBe(true);
  });

  it('does not arm the control of the git-hook probe: the host protects .git and stopped it itself', () => {
    const outcome = control(STREAMS.denyControl, 'deny', ABSENT);
    expect(outcome).toMatchObject({ mark: 'inconclusive', reason: 'probe-not-armed' });
  });

  it("does not take the host's own words for the hook's: the same stop, worded by the host, has no E4", () => {
    const stream = STREAMS.denyControl;
    const probe = probeOf(stream, 'deny');
    const outcome = markProbe({
      probe,
      nonce: nonceOf(stream),
      run: runOf(stream),
      // The hook, had it been in the loop, judging the command as it is judged.
      audit: [auditFor(probe)],
      sentinel: ABSENT,
      expectation: probe.expected,
    });
    expect(outcome.evidence.E4).toBe(false);
  });
});

describe('what a default run of three requests comes to on a real Claude Code', () => {
  const allow: Row = {
    id: 'allow',
    kind: 'allow',
    outcome: real(STREAMS.allowRan, AUDITS.allow, 'allow', THERE(nonceOf(STREAMS.allowRan))),
  };
  const egress: Row = {
    id: 'secret-egress',
    kind: 'secret-egress',
    outcome: real(STREAMS.egressBlocked, AUDITS.egress, 'secret-egress', ABSENT),
  };
  const egressControl: Row = {
    id: 'secret-egress:control',
    kind: 'secret-egress',
    outcome: control(STREAMS.egressControl, 'secret-egress', THERE(nonceOf(STREAMS.egressControl))),
  };
  const deny: Row = {
    id: 'deny',
    kind: 'deny',
    outcome: real(STREAMS.denyBlocked, AUDITS.deny, 'deny', ABSENT),
  };
  const denyControl: Row = {
    id: 'deny:control',
    kind: 'deny',
    outcome: control(STREAMS.denyControl, 'deny', ABSENT),
  };

  it('verifies the host on the allow, the made-up key probe and its control', () => {
    const rows = [allow, downgradeUnarmed(egress, egressControl.outcome), egressControl];
    expect(overallState(rows)).toBe('verified');
  });

  it('is still verified when the git-hook probe is run too, whose control can never be armed there', () => {
    const rows = [
      allow,
      downgradeUnarmed(egress, egressControl.outcome),
      egressControl,
      downgradeUnarmed(deny, denyControl.outcome),
      denyControl,
    ];
    expect(overallState(rows)).toBe('verified');
    expect(rows[3]?.outcome).toMatchObject({ mark: 'inconclusive', reason: 'probe-not-armed' });
  });

  it('would not be verified on the git-hook probe alone, because of that', () => {
    const rows = [allow, downgradeUnarmed(deny, denyControl.outcome), denyControl];
    expect(overallState(rows)).toBe('inconclusive');
  });
});
