import type { AuditEntry } from '@stroq/core';
import { auditSummaryOf } from '../../src/live/evidence.js';
import type {
  HostResult,
  HostRun,
  LiveOutcome,
  Probe,
  ProbeKind,
  ProbeResult,
  SettledExpectation,
  StreamEvent,
} from '../../src/live/types.js';

/** Fixed values, so that a failing assertion prints something a person can compare. */
export const NONCE = 'stroq-live-0123456789abcdef';
export const FAKE = 'stroq_attack_0123456789abcdef01234567';
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const DIGEST = 'a'.repeat(64);

export const DENY_BY_GIT_EXEC: SettledExpectation = { effect: 'deny', ruleId: 'deny-git-exec' };
export const DENY_BY_EGRESS: SettledExpectation = { effect: 'deny', ruleId: 'deny-secret-egress' };
export const ALLOWED: SettledExpectation = { effect: 'allow', ruleId: null };

/** What the default policy says about a probe of this kind. */
export const expectationOf = (p: Pick<Probe, 'kind'>): SettledExpectation =>
  p.kind === 'allow' ? ALLOWED : p.kind === 'deny' ? DENY_BY_GIT_EXEC : DENY_BY_EGRESS;

/** An audit entry as the engine writes it for a `PreToolUse`; the hash chain is not what is tested. */
export const auditEntry = (
  over: Partial<AuditEntry> & {
    readonly effect?: 'allow' | 'deny' | 'ask';
    readonly ruleId?: string | null;
  } = {},
): AuditEntry => {
  const { effect = 'allow', ruleId = null, ...rest } = over;
  return {
    seq: 1,
    ts: '2026-10-10T00:00:00.000Z',
    prevHash: '0'.repeat(64),
    hash: 'f'.repeat(64),
    sessionId: SESSION,
    phase: 'pre',
    tool: 'Bash',
    summary: `echo ${NONCE} > stroq-live-allow.txt`,
    decision: { effect, ruleId, reason: 'test' },
    ...rest,
  };
};

/**
 * The entry the hook writes for a probe: the summary is the command as the audit records it (redacted,
 * which for the egress probe takes the made-up key out), and the decision is what the policy gives it.
 */
export const auditFor = (
  p: Pick<Probe, 'kind' | 'command'>,
  over: Parameters<typeof auditEntry>[0] = {},
): AuditEntry => {
  const expectation = expectationOf(p);
  return auditEntry({
    summary: auditSummaryOf(p.command),
    effect: expectation.effect,
    ruleId: expectation.ruleId,
    ...over,
  });
};

export const toolUse = (command: string): StreamEvent => ({
  type: 'tool_use',
  name: 'Bash',
  input: { command },
});

/** A host run that ended normally: the init message, then whatever `events` say, then a result. */
export const finished = (events: readonly StreamEvent[], over: Partial<HostRun> = {}): HostRun => ({
  stream: [{ type: 'init' }, ...events, { type: 'result', isError: false, text: 'DONE' }],
  exitCode: 0,
  timedOut: false,
  stderrTail: '',
  apiProvider: 'firstParty',
  apiKeySource: 'none',
  ...over,
});

export const passedProbe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  id: 'allow',
  kind: 'allow',
  mark: 'passed',
  reason: 'ran',
  evidence: { E1: true, E2: true, E3: true, E4: null },
  ...over,
});

/** The control run of a probe that passed: the same command under a hook that allows all, and its file came. */
export const armedControl = (id: string, kind: ProbeKind): ProbeResult => ({
  id: `${id}:control`,
  kind,
  mark: 'passed',
  reason: 'armed',
  evidence: { E1: true, E2: null, E3: true, E4: null },
});

const unfinished = (
  id: string,
  kind: ProbeKind,
  mark: ProbeResult['mark'],
  reason: string,
): ProbeResult => ({
  id,
  kind,
  mark,
  reason,
  evidence: { E1: false, E2: false, E3: false, E4: null },
});

/** The probes a result of this state is made of: what its state is the state of. */
export const probesFor = (state: LiveOutcome): ProbeResult[] => {
  switch (state) {
    case 'verified':
      return [
        passedProbe(),
        passedProbe({
          id: 'deny',
          kind: 'deny',
          reason: 'blocked',
          evidence: { E1: true, E2: true, E3: true, E4: true },
        }),
        armedControl('deny', 'deny'),
      ];
    case 'failed':
      return [
        passedProbe(),
        {
          id: 'deny',
          kind: 'deny',
          mark: 'failed',
          reason: 'executed-despite-deny',
          evidence: { E1: true, E2: true, E3: false, E4: false },
        },
      ];
    case 'inconclusive':
      return [
        unfinished('allow', 'allow', 'inconclusive', 'limit'),
        unfinished('deny', 'deny', 'inconclusive', 'timeout'),
      ];
    case 'not-attempted':
      return [
        unfinished('allow', 'allow', 'not-attempted', 'budget'),
        unfinished('deny', 'deny', 'not-attempted', 'budget'),
      ];
  }
};

/** A result of this state that follows its own rule: its probes come to the state it has. */
export const resultOf = (state: LiveOutcome, over: Partial<HostResult> = {}): HostResult => ({
  version: 1,
  agent: 'claude-code',
  hostVersion: '2.1.271',
  stroqVersion: '0.23.0',
  policySha256: DIGEST,
  at: '2026-10-10T01:02:03.456Z',
  mode: 'live',
  probes: probesFor(state),
  state,
  caveats: [],
  ...over,
});

/**
 * A verified result with a control run for its deny, unless it says another state, in which case its
 * probes are the ones that state is made of. What is said outright is taken as it is said.
 */
export const validResult = (over: Partial<HostResult> = {}): HostResult =>
  resultOf(over.state ?? 'verified', over);
