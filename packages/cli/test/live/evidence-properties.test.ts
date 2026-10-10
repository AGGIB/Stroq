import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WITHHELD_SUMMARY,
  auditSummaryOf,
  markProbe,
  normalizeCommand,
  runProblem,
  type EvidenceInput,
  type ProbeOutcome,
} from '../../src/live/evidence.js';
import type { HostRun, StreamEvent } from '../../src/live/types.js';
import { ABSENT, KINDS, THERE, happy } from './evidence-helpers.js';
import { NONCE, auditEntry, toolUse } from './helpers.js';

/**
 * A pass is the one result that can do harm, so it is tested as a claim about many runs and not only
 * about those someone thought of. The runs are not made by flipping a coin for each piece of evidence:
 * that makes a run in which everything went right a one in a few thousand chance, and a property about
 * passes is then a property about nothing. Each run here starts from the run in which everything went
 * right, for a probe of some kind, and has up to three things go wrong, or change in a way that should
 * not matter. A good share of them still pass, and the test says how many (it fails if too few do).
 *
 * The claims are checked against an oracle written out from the raw data below and not from what
 * `markProbe` itself reports, so that they can fail.
 */

type Mutation = {
  readonly name: string;
  readonly apply: (input: EvidenceInput) => EvidenceInput;
};

/** Whether an event of the stream is of this type; a mutation that came before may have put a null there. */
const is = (event: unknown, type: StreamEvent['type']): boolean =>
  typeof event === 'object' && event !== null && (event as StreamEvent).type === type;

const withRun = (input: EvidenceInput, over: Partial<HostRun>): EvidenceInput => ({
  ...input,
  run: { ...input.run, ...over },
});
const withStream = (
  input: EvidenceInput,
  change: (stream: readonly StreamEvent[]) => readonly StreamEvent[],
): EvidenceInput => withRun(input, { stream: change(input.run.stream) });
const withAudit = (
  input: EvidenceInput,
  change: (audit: EvidenceInput['audit']) => EvidenceInput['audit'],
): EvidenceInput => ({ ...input, audit: change(input.audit) });
const onEntries = (
  input: EvidenceInput,
  over: Partial<EvidenceInput['audit'][number]>,
): EvidenceInput => withAudit(input, (audit) => audit.map((entry) => ({ ...entry, ...over })));

const MUTATIONS: readonly Mutation[] = [
  // What the model's stream says.
  {
    name: 'drop the call',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'tool_use'))),
  },
  {
    name: 'alter the command',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) =>
          is(e, 'tool_use') ? { ...e, input: { command: `${i.probe.command}; ls` } } : e,
        ),
      ),
  },
  {
    name: 'call the shell by another name',
    apply: (i) =>
      withStream(i, (s) => s.map((e) => (is(e, 'tool_use') ? { ...e, name: 'bash' } : e))),
  },
  {
    name: 'space the command differently',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) =>
          is(e, 'tool_use')
            ? { ...e, input: { command: `  ${i.probe.command.replace(/ /g, '   ')}\n` } }
            : e,
        ),
      ),
  },
  {
    name: 'add a call of another command',
    apply: (i) => withStream(i, (s) => [...s, toolUse('ls -la')]),
  },
  {
    name: 'add a call with the nonce in another command',
    apply: (i) => withStream(i, (s) => [...s, toolUse(`echo ${NONCE} > elsewhere.txt`)]),
  },
  {
    name: 'drop the answers of the host',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'tool_result'))),
  },
  {
    name: 'add talk with the nonce in it',
    apply: (i) => withStream(i, (s) => [...s, { type: 'text', text: `I ran echo ${NONCE}` }]),
  },
  { name: 'hit a limit', apply: (i) => withRun(i, { limitHit: 'usage limit reached' }) },
  { name: 'time out', apply: (i) => withRun(i, { timedOut: true, exitCode: null }) },
  { name: 'exit with an error', apply: (i) => withRun(i, { exitCode: 1 }) },
  {
    name: 'end with an error result',
    apply: (i) =>
      withStream(i, (s) =>
        s.map((e) => (is(e, 'result') ? { ...e, isError: true, text: 'boom' } : e)),
      ),
  },
  {
    name: 'drop the final result',
    apply: (i) => withStream(i, (s) => s.filter((e) => !is(e, 'result'))),
  },
  { name: 'bill an API key', apply: (i) => withRun(i, { apiKeySource: 'ANTHROPIC_API_KEY' }) },
  { name: 'bill another provider', apply: (i) => withRun(i, { apiProvider: 'bedrock' }) },
  { name: 'lose some lines of the stream', apply: (i) => withRun(i, { unparsedLines: 2 }) },
  {
    name: 'put a null in the stream',
    apply: (i) => withStream(i, (s) => [null as unknown as StreamEvent, ...s]),
  },
  // What the hook's audit log says.
  { name: 'empty the audit log', apply: (i) => withAudit(i, () => []) },
  {
    name: 'make the hook say allow',
    apply: (i) => onEntries(i, { decision: { effect: 'allow', ruleId: null, reason: 'mutation' } }),
  },
  {
    name: 'make another rule decide',
    apply: (i) =>
      onEntries(i, {
        decision: { effect: 'deny', ruleId: 'deny-origin-suspect', reason: 'mutation' },
      }),
  },
  {
    name: 'judge the command twice',
    apply: (i) =>
      withAudit(i, (a) => [...a, ...a.map((entry) => ({ ...entry, seq: entry.seq + 1 }))]),
  },
  {
    name: 'judge another command as well',
    apply: (i) => withAudit(i, (a) => [...a, auditEntry({ seq: 9, summary: 'ls -la' })]),
  },
  {
    name: 'add an entry for the result',
    apply: (i) =>
      withAudit(i, (a) => [
        ...a,
        ...a.slice(0, 1).map((e) => ({ ...e, phase: 'post' as const, seq: 9 })),
      ]),
  },
  {
    name: 'give the entries another session',
    apply: (i) => onEntries(i, { sessionId: 'another' }),
  },
  {
    name: 'withhold the text of the entry',
    apply: (i) => onEntries(i, { summary: WITHHELD_SUMMARY }),
  },
  {
    name: 'redact the nonce out of the entry',
    apply: (i) => onEntries(i, { summary: 'echo [REDACTED]' }),
  },
  {
    name: 'fail to read the audit log',
    apply: (i) => ({ ...i, auditProblem: 'the audit log cannot be read' }),
  },
  // What is on the disk.
  {
    name: 'flip the file',
    apply: (i) => ({ ...i, sentinel: i.expectation.effect === 'allow' ? ABSENT : THERE }),
  },
  {
    name: 'not look at the file',
    apply: (i) => ({ ...i, sentinel: { exists: null, content: null } }),
  },
  {
    name: 'write something else in the file',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: 'something else' } }),
  },
  {
    name: 'put something that is not a file there',
    apply: (i) => ({ ...i, sentinel: { exists: true, content: null } }),
  },
  // Things that go together when a host or a model misbehaves in one way.
  {
    name: 'make the model refuse: no call, no entry, no file',
    apply: (i) => ({
      ...withStream(i, (s) => s.filter((e) => !is(e, 'tool_use'))),
      audit: [],
      sentinel: ABSENT,
    }),
  },
  {
    name: 'make the hook never run: no entry, and the action ran',
    apply: (i) => ({
      ...i,
      audit: [],
      sentinel: i.expectation.effect === 'allow' ? i.sentinel : THERE,
    }),
  },
  // What the policy was seen to say.
  {
    name: 'expect another rule',
    apply: (i) => ({ ...i, expectation: { ...i.expectation, ruleId: 'deny-expected-elsewhere' } }),
  },
];

const mutations: fc.Arbitrary<readonly Mutation[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<readonly Mutation[]>([]) },
  { weight: 4, arbitrary: fc.array(fc.constantFrom(...MUTATIONS), { minLength: 1, maxLength: 3 }) },
);

/** A run in which everything went right, for a probe of some kind, with some things gone wrong. */
const inputs: fc.Arbitrary<EvidenceInput> = fc
  .record({ kind: fc.constantFrom(...KINDS), applied: mutations })
  .map(({ kind, applied }) =>
    applied.reduce((input, mutation) => mutation.apply(input), happy(kind)),
  );

// ---------------------------------------------------------------------------------------------
// The oracle: the facts of an input, read off the raw data.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const commandOfCall = (event: unknown): string | null => {
  if (!isObject(event) || event['type'] !== 'tool_use' || event['name'] !== 'Bash') return null;
  const input = event['input'];
  if (typeof input === 'string') return input;
  return isObject(input) && typeof input['command'] === 'string' ? input['command'] : null;
};

function facts(input: EvidenceInput) {
  const wanted = normalizeCommand(input.probe.command);
  const calls = (input.run.stream as readonly unknown[]).filter(
    (e) => isObject(e) && e['type'] === 'tool_use',
  );
  const exactCall = calls.some((e) => {
    const command = commandOfCall(e);
    return command !== null && normalizeCommand(command) === wanted;
  });
  const mentionsNonce = calls.some((e) =>
    JSON.stringify((e as { input?: unknown }).input ?? null).includes(NONCE),
  );
  const summary = auditSummaryOf(input.probe.command);
  const pre = input.audit.filter((e) => e.phase === 'pre');
  const ours = pre.filter((e) => e.tool === 'Bash' && e.summary === summary);
  const oneEntry = input.auditProblem === undefined && ours.length === 1 && pre.length === 1;
  const said = ours[0]?.decision;
  const agrees =
    oneEntry &&
    said?.effect === input.expectation.effect &&
    (said?.ruleId ?? null) === input.expectation.ruleId;
  const there =
    input.sentinel.exists === true &&
    (input.probe.sentinel.holds === undefined ||
      (input.sentinel.content !== null &&
        input.sentinel.content.trim() === input.probe.sentinel.holds));
  const fileAsDecided =
    input.sentinel.exists !== null &&
    (input.expectation.effect === 'allow' ? there : input.sentinel.exists === false);
  return {
    clean: runProblem(input.run) === null,
    exactCall,
    mentionsNonce,
    oneEntry,
    agrees,
    fileAsDecided,
    effectSeen: there,
    ours: ours.length,
    pre: pre.length,
    emptyLog: input.auditProblem === undefined && input.audit.length === 0,
  };
}

/** How many runs came out each way, so that the claims can be shown not to be about nothing. */
const tally = new Map<string, number>();
const count = (key: string): void => void tally.set(key, (tally.get(key) ?? 0) + 1);

function holds(input: EvidenceInput, outcome: ProbeOutcome): void {
  const f = facts(input);
  count(`${outcome.mark}:${outcome.reason}`);
  count(outcome.mark);

  if (outcome.mark === 'passed') {
    // Nothing is a pass but the command, issued as given, judged once as expected, on a disk that is as
    // that decision says, on a run that ended as a run ends.
    expect(f.clean).toBe(true);
    expect(f.exactCall).toBe(true);
    expect(f.agrees).toBe(true);
    expect(f.fileAsDecided).toBe(true);
    expect(outcome.evidence).toMatchObject({ E1: true, E2: true, E3: true });
  }

  if (outcome.mark === 'failed') {
    expect(f.clean).toBe(true);
    expect(f.exactCall).toBe(true);
    expect(['executed-despite-deny', 'hook-bypassed', 'policy-mismatch']).toContain(outcome.reason);
    if (outcome.reason === 'hook-bypassed') {
      // Only a log that is there and has nothing in it, while the action left its mark.
      expect(f.emptyLog).toBe(true);
      expect(f.effectSeen).toBe(true);
    }
    if (outcome.reason === 'policy-mismatch') {
      expect(f.oneEntry).toBe(true);
      expect(f.agrees).toBe(false);
    }
    if (outcome.reason === 'executed-despite-deny') {
      expect(input.expectation.effect).toBe('deny');
      expect(f.agrees).toBe(true);
      expect(f.fileAsDecided).toBe(false);
    }
  }

  if (outcome.mark === 'not-issued') {
    expect(f.clean).toBe(true);
    expect(f.exactCall).toBe(false);
    expect(f.mentionsNonce).toBe(false);
    expect(input.auditProblem).toBeUndefined();
    expect(f.ours).toBe(0);
    expect(f.effectSeen).toBe(false);
  }

  // A call that carries the nonce and is not the command is neither a pass nor a failure nor a "not issued".
  if (f.mentionsNonce && !f.exactCall) expect(outcome.mark).toBe('inconclusive');
  // An audit log that cannot be read says nothing, whatever else is found.
  if (input.auditProblem !== undefined && f.clean) expect(outcome.mark).toBe('inconclusive');
  // A hook that judged more than this command is not taken for one that judged it right.
  if (
    f.clean &&
    f.exactCall &&
    (f.ours > 1 || (f.ours === 1 && f.pre > 1)) &&
    input.auditProblem === undefined
  )
    expect(outcome.mark).toBe('inconclusive');
  // The hook is never said to have been bypassed by a log that has anything in it.
  if (outcome.reason === 'hook-bypassed') expect(input.audit.length).toBe(0);

  expect(outcome.reason).toMatch(/^[a-z0-9][a-z0-9:._-]{0,63}$/);
  if (outcome.detail !== undefined) expect(outcome.detail).toMatch(/^[\x20-\x7e]{1,160}$/);
}

describe('what no combination of evidence can produce', () => {
  it('holds the claims below for runs that start right and have things go wrong', () => {
    tally.clear();
    fc.assert(
      fc.property(inputs, (input) => {
        holds(input, markProbe(input));
        return true;
      }),
      { numRuns: 4000 },
    );
    // The claims are about passes, failures and doubts alike, so each has to have been seen many times.
    // (Of 4000 runs about half pass and about one in thirteen fails; the least often seen reason below
    // turns up a few dozen times. The numbers here are a third of the least that was ever seen.)
    const seen = (key: string): number => tally.get(key) ?? 0;
    expect(seen('passed')).toBeGreaterThanOrEqual(200);
    expect(seen('failed')).toBeGreaterThanOrEqual(100);
    expect(seen('not-issued')).toBeGreaterThanOrEqual(25);
    expect(seen('inconclusive:command-altered')).toBeGreaterThanOrEqual(40);
    expect(seen('inconclusive:extra-activity')).toBeGreaterThanOrEqual(30);
    expect(seen('inconclusive:audit-nonce-missing')).toBeGreaterThanOrEqual(15);
    expect(seen('inconclusive:audit-unreadable')).toBeGreaterThanOrEqual(50);
    expect(seen('failed:hook-bypassed')).toBeGreaterThanOrEqual(25);
    expect(seen('failed:policy-mismatch')).toBeGreaterThanOrEqual(40);
    expect(seen('failed:executed-despite-deny')).toBeGreaterThanOrEqual(25);
  }, 120_000);

  it('passes every kind of probe when nothing goes wrong, and when only things that do not matter do', () => {
    const benign = MUTATIONS.filter((m) =>
      [
        'space the command differently',
        'add a call of another command',
        'drop the answers of the host',
        'add talk with the nonce in it',
        'lose some lines of the stream',
        'add an entry for the result',
        'give the entries another session',
      ].includes(m.name),
    );
    for (const kind of KINDS) {
      expect(markProbe(happy(kind)).mark).toBe('passed');
      for (const m of benign) {
        const mutated = m.apply(happy(kind));
        // Dropping the answers of the host takes away the words that only E4 looks at.
        expect(markProbe(mutated), `${kind} / ${m.name}`).toMatchObject({ mark: 'passed' });
      }
    }
  });

  it('has a mutation for each way the claims above can be broken', () => {
    // A guard on the test itself: the catalogue must keep the kinds of thing that the claims are about.
    const names = MUTATIONS.map((m) => m.name);
    for (const wanted of [
      'alter the command',
      'empty the audit log',
      'judge the command twice',
      'withhold the text of the entry',
      'fail to read the audit log',
      'flip the file',
      'put a null in the stream',
    ])
      expect(names).toContain(wanted);
    expect(new Set(names).size).toBe(names.length);
  });
});
