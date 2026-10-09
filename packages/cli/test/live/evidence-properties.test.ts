import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  gatherEvidence,
  markProbe,
  runProblem,
  type EvidenceInput,
} from '../../src/live/evidence.js';
import type { HostRun, SentinelState, StreamEvent } from '../../src/live/types.js';
import { ABSENT, DENY_TEXT, KINDS, THERE, happy } from './evidence-helpers.js';
import { NONCE, auditEntry, toolUse } from './helpers.js';
import { probe } from './probe-helpers.js';

// The reason this is a table of cells and also a property: a pass is the one result that can do
// harm, so it is tested as a claim about every combination and not only about those someone thought of.
describe('what no combination of evidence can produce', () => {
  const eventArb = fc.constantFrom<'init' | 'text' | 'result' | 'tool_result' | 'other'>(
    'init',
    'text',
    'result',
    'tool_result',
    'other',
  );
  const sentinelArb: fc.Arbitrary<SentinelState> = fc.oneof(
    fc.constant(ABSENT),
    fc.constant(THERE),
    fc.constant<SentinelState>({ exists: true, content: null }),
    fc.constant<SentinelState>({ exists: true, content: 'something else' }),
    fc.constant<SentinelState>({ exists: null, content: null }),
  );
  const auditArb = fc.oneof(
    fc.constant<'none'>('none'),
    fc.constant<'agrees'>('agrees'),
    fc.constant<'allow'>('allow'),
    fc.constant<'other-rule'>('other-rule'),
    fc.constant<'other-session'>('other-session'),
  );

  const inputArb = fc
    .record({
      kind: fc.constantFrom(...KINDS),
      issued: fc.boolean(),
      denyText: fc.boolean(),
      extra: fc.array(eventArb, { maxLength: 4 }),
      finalResult: fc.constantFrom<'none' | 'ok' | 'error'>('none', 'ok', 'error'),
      audit: auditArb,
      sentinel: sentinelArb,
      exitCode: fc.constantFrom<number | null>(0, 0, 0, 1, null),
      timedOut: fc.boolean(),
      limitHit: fc.boolean(),
      unparsed: fc.boolean(),
      billing: fc.constantFrom<string | undefined>(undefined, 'none', 'ANTHROPIC_API_KEY'),
    })
    .map((g) => {
      const base = happy(g.kind);
      const expectation = base.expectation;
      const cmd = probe(g.kind).command;
      const events: StreamEvent[] = [
        ...g.extra.map((type): StreamEvent => ({ type, text: type === 'text' ? NONCE : 'x' })),
        ...(g.issued ? [toolUse(cmd)] : []),
        ...(g.denyText ? [DENY_TEXT(expectation.ruleId ?? 'x')] : []),
        ...(g.finalResult === 'none'
          ? []
          : [{ type: 'result' as const, isError: g.finalResult === 'error', text: 'DONE' }]),
      ];
      const entry = (over: object = {}) =>
        auditEntry({
          summary: cmd,
          effect: expectation.effect,
          ruleId: expectation.ruleId,
          ...over,
        });
      const audit =
        g.audit === 'none'
          ? []
          : g.audit === 'agrees'
            ? [entry()]
            : g.audit === 'allow'
              ? [entry({ effect: 'allow', ruleId: null })]
              : g.audit === 'other-rule'
                ? [entry({ ruleId: 'deny-origin-suspect' })]
                : [entry({ sessionId: 'someone-else' })];
      const run: HostRun = {
        stream: events,
        exitCode: g.exitCode,
        timedOut: g.timedOut,
        stderrTail: '',
        ...(g.limitHit ? { limitHit: 'usage limit' } : {}),
        ...(g.unparsed ? { unparsedLines: 3 } : {}),
        ...(g.billing === undefined ? {} : { apiKeySource: g.billing }),
      };
      return { ...base, run, audit, sentinel: g.sentinel } satisfies EvidenceInput;
    });

  it('never passes unless the command was issued, judged as expected, and left the disk as the decision says', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const outcome = markProbe(input);
        if (outcome.mark !== 'passed') return true;
        const clean = runProblem(input.run) === null;
        const { E1, E2, E3 } = outcome.evidence;
        return clean && E1 === true && E2 === true && E3 === true;
      }),
      { numRuns: 4000 },
    );
  });

  it('never fails a host on a run that went wrong, or on a command nobody issued', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const outcome = markProbe(input);
        if (outcome.mark !== 'failed') return true;
        return (
          runProblem(input.run) === null &&
          outcome.evidence.E1 === true &&
          ['executed-despite-deny', 'hook-bypassed', 'policy-mismatch'].includes(outcome.reason)
        );
      }),
      { numRuns: 4000 },
    );
  });

  it('never says a command was not issued when the audit or the disk show it ran', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const outcome = markProbe(input);
        if (outcome.mark !== 'not-issued') return true;
        const facts = gatherEvidence(input);
        return !facts.E1 && facts.audit.state === 'absent' && facts.effectSeen === false;
      }),
      { numRuns: 4000 },
    );
  });

  it('always gives a reason, and a detail that is one line of plain characters', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const outcome = markProbe(input);
        return (
          /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(outcome.reason) &&
          (outcome.detail === undefined || /^[\x20-\x7e]{1,160}$/.test(outcome.detail))
        );
      }),
      { numRuns: 2000 },
    );
  });
});
