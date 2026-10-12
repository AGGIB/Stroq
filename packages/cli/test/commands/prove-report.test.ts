import { describe, expect, it } from 'vitest';
import {
  adviceFor,
  exitCodeOf,
  notRunReport,
  reportOf,
  requestsMadeBy,
} from '../../src/commands/prove-report.js';
import { REASONS, type HostResult, type ProbeResult } from '../../src/live/types.js';
import { armedControl, passedProbe, resultOf } from '../live/helpers.js';

/**
 * What `stroq prove` says it found, as a value: the state, whether it is the real host's, how many
 * requests it took, what it does not show and what to do next. The words (`prove-text.ts`) and the
 * exit code are made from this and from nothing else.
 */
const ok = (id: string, kind: ProbeResult['kind'], reason: string): ProbeResult => ({
  id,
  kind,
  mark: 'passed',
  reason,
  evidence: { E1: true, E2: true, E3: true, E4: kind === 'allow' ? null : true },
});

const not = (
  id: string,
  kind: ProbeResult['kind'],
  mark: ProbeResult['mark'],
  reason: string,
): ProbeResult => ({
  id,
  kind,
  mark,
  reason,
  evidence: { E1: null, E2: null, E3: null, E4: null },
});

/** allow + the made-up key probe + its control: the three requests of a default run. */
const verified = (over: Partial<HostResult> = {}): HostResult =>
  resultOf('verified', {
    probes: [
      passedProbe(),
      ok('secret-egress', 'secret-egress', 'blocked'),
      armedControl('secret-egress', 'secret-egress'),
      not('deny', 'deny', 'not-attempted', REASONS.maxRequests),
    ],
    ...over,
  });

describe('reportOf', () => {
  it('is the result of a live check, as the check found it', () => {
    const report = reportOf(verified());
    expect(report).toMatchObject({
      version: 1,
      agent: 'claude-code',
      hostVersion: '2.1.271',
      state: 'verified',
      mode: 'live',
      requestsMade: 3,
    });
    expect(report.probes.map((p) => p.id)).toEqual([
      'allow',
      'secret-egress',
      'secret-egress:control',
      'deny',
    ]);
  });

  it('is never verified for a stand-in: a double of the host says nothing of the host', () => {
    const report = reportOf(verified({ mode: 'stand-in' }));
    expect(report.mode).toBe('stand-in');
    expect(report.state).toBe('not-attempted');
    expect(report.caveats.join(' ')).toMatch(/stand-in/);
    expect(adviceFor(report).join(' ')).toMatch(/double/);
    expect(exitCodeOf(report)).toBe(3);
  });

  it('keeps the caveats of the result', () => {
    const report = reportOf(verified({ caveats: ['hook-trust-bypassed'] }));
    expect(report.caveats).toEqual(['hook-trust-bypassed']);
  });

  it('does not share its arrays with the result', () => {
    const result = verified({ caveats: ['x'] });
    const report = reportOf(result);
    expect(report.probes).not.toBe(result.probes);
    expect(report.caveats).not.toBe(result.caveats);
  });
});

describe('requestsMadeBy', () => {
  it('counts the probes a request was made for, and not the ones that were skipped or not attempted', () => {
    expect(
      requestsMadeBy([
        passedProbe(),
        not('deny', 'deny', 'skipped', REASONS.skippedPolicyAllows),
        not('secret-egress', 'secret-egress', 'not-attempted', REASONS.budget),
        not('x', 'deny', 'inconclusive', REASONS.limit),
        not('y', 'deny', 'not-issued', REASONS.notIssued),
        not('z', 'deny', 'failed', REASONS.executedDespiteDeny),
      ]),
    ).toBe(4);
  });
});

describe('exitCodeOf', () => {
  it.each([
    ['verified', 0],
    ['failed', 1],
    ['inconclusive', 3],
    ['not-attempted', 3],
  ] as const)('is %s for a live %s', (state, code) => {
    expect(exitCodeOf(reportOf(resultOf(state)))).toBe(code);
  });

  it('is 3 for a check that was not run at all', () => {
    expect(exitCodeOf(notRunReport('codex', 'unsupported', null, 'no driver'))).toBe(3);
  });
});

describe('notRunReport', () => {
  it('says why in the caveats, with no probe and no request', () => {
    const report = notRunReport('claude-code', 'not-attempted', '2.1.271', 'host not found');
    expect(report).toMatchObject({
      version: 1,
      agent: 'claude-code',
      hostVersion: '2.1.271',
      state: 'not-attempted',
      mode: null,
      probes: [],
      requestsMade: 0,
      caveats: ['host not found'],
    });
    expect(report.advice.length).toBeGreaterThan(0);
  });
});

describe('adviceFor', () => {
  const adviceOf = (
    probes: ProbeResult[],
    state: 'inconclusive' | 'not-attempted' = 'inconclusive',
  ) => adviceFor(reportOf(resultOf(state, { probes })));

  it('says at most three lines', () => {
    for (const state of ['verified', 'failed', 'inconclusive', 'not-attempted'] as const)
      expect(adviceFor(reportOf(resultOf(state))).length).toBeLessThanOrEqual(3);
  });

  it('says to run again after an update, for a host that was verified', () => {
    const lines = adviceFor(reportOf(verified()));
    expect(lines.join(' ')).toMatch(/stroq doctor/);
    expect(lines.join(' ')).toMatch(/update|change/);
  });

  it('says not to rely on the hook for a host that failed', () => {
    const lines = adviceFor(reportOf(resultOf('failed')));
    expect(lines[0]).toMatch(/do not rely/i);
    expect(lines.join(' ')).toMatch(/stroq init/);
  });

  it.each([
    [REASONS.limit, /usage|limit|reset/i],
    [REASONS.auth, /log in|login/i],
    [REASONS.apiBilling, /API key|subscription/i],
    [REASONS.billingUnknown, /update|how it is paid/i],
    [REASONS.timeout, /again/i],
    [REASONS.hostError, /again|claude/i],
    [REASONS.unparsableStream, /again|version/i],
    [REASONS.cwdMismatch, /directory|again/i],
    [REASONS.notIssued, /model|again/i],
    [REASONS.probeNotArmed, /not run|armed|stop/i],
    [REASONS.hostNotFound, /install|PATH|not found/i],
    [REASONS.budget, /budget|STROQ_LIVE_LEDGER/i],
  ])('names what to do when the reason is %s', (reason, wanted) => {
    const lines = adviceOf([not('allow', 'allow', 'inconclusive', reason)]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).toMatch(wanted);
  });

  it('puts the reason that blocks everything before one that blocks a probe', () => {
    const lines = adviceOf([
      not('deny', 'deny', 'inconclusive', REASONS.probeNotArmed),
      not('allow', 'allow', 'inconclusive', REASONS.limit),
    ]);
    expect(lines[0]).toMatch(/usage|limit|reset/i);
  });

  it('has something to say for a reason it does not know', () => {
    const lines = adviceOf([not('allow', 'allow', 'inconclusive', 'brand-new-reason')]);
    expect(lines.length).toBeGreaterThan(0);
  });
});
