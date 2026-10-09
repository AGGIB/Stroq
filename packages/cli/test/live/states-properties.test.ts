import fc from 'fast-check';
import { describe, it } from 'vitest';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import { HOST_STATES, type LiveOutcome } from '../../src/live/types.js';
import { DIGEST } from './helpers.js';
import { CLAUDE, CURSOR, T0, T1, stored } from './states-helpers.js';

// The whole rule as claims about every combination, because the harm is in the one combination that
// was not thought of: a verified that should not be, or a failure or a doubt that turned into either.
describe('what no combination can produce', () => {
  const outcomes: readonly (LiveOutcome | null)[] = [
    null,
    'verified',
    'failed',
    'inconclusive',
    'not-attempted',
  ];
  const inputs = fc.record({
    caps: fc.constantFrom(CLAUDE, CURSOR, undefined),
    installed: fc.constantFrom<DisplayStateInput['installed']>(
      { installed: true, changed: false },
      { installed: false, changed: false },
      { installed: true, changed: true },
      { installed: true, changed: false, vanished: true },
      { installed: true, changed: false, unapproved: true },
      { installed: true, changed: false, shadowed: true },
      { installed: true, changed: false, unstartable: true },
    ),
    stamp: fc.constantFrom<Date | null>(null, T0, T1),
    record: fc.constantFrom<Date | null>(null, T0, T1),
    outcome: fc.constantFrom(...outcomes),
    mode: fc.constantFrom<'live' | 'stand-in'>('live', 'live', 'stand-in'),
    stroq: fc.constantFrom('0.23.0', '0.24.0'),
    policy: fc.constantFrom(DIGEST, 'b'.repeat(64)),
    host: fc.constantFrom<string | null>('2.1.271', '2.2.0', null),
    storedHost: fc.constantFrom<string | null>('2.1.271', null),
  });

  type Generated = typeof inputs extends fc.Arbitrary<infer T> ? T : never;
  const whole = (i: DisplayStateInput['installed']): boolean =>
    i.installed && !i.changed && !i.vanished && !i.unapproved && !i.shadowed && !i.unstartable;

  const run = (g: Generated) => {
    const result =
      g.outcome === null ? null : stored(g.outcome, { mode: g.mode, hostVersion: g.storedHost });
    const shown = displayState({
      capabilities: g.caps,
      installed: g.installed,
      stampAt: g.stamp,
      installRecordedAt: g.record,
      stored: result,
      stroqVersion: g.stroq,
      policySha256: g.policy,
      hostVersion: g.host,
    });
    return { shown, result };
  };

  it('never says verified unless a live check, of a host that can be driven, was verified against these very versions and the hook is whole', () => {
    fc.assert(
      fc.property(inputs, (g) => {
        const { shown, result } = run(g);
        if (shown.state !== 'verified') return true;
        return (
          g.caps?.headless === true &&
          whole(g.installed) &&
          result?.state === 'verified' &&
          result.mode === 'live' &&
          g.stroq === result.stroqVersion &&
          g.policy === result.policySha256 &&
          g.host === result.hostVersion
        );
      }),
      { numRuns: 3000 },
    );
  });

  it('never says failed unless a live check of a host that can be driven failed', () => {
    fc.assert(
      fc.property(inputs, (g) => {
        const { shown, result } = run(g);
        return (
          shown.state !== 'failed' ||
          (g.caps?.headless === true && result?.state === 'failed' && result.mode === 'live')
        );
      }),
      { numRuns: 3000 },
    );
  });

  it('never turns a check that could not tell into a verified or a failed', () => {
    fc.assert(
      fc.property(inputs, (g) => {
        const { shown, result } = run(g);
        if (result?.state !== 'inconclusive' && result?.state !== 'not-attempted') return true;
        return shown.state !== 'verified' && shown.state !== 'failed';
      }),
      { numRuns: 3000 },
    );
  });

  it('always gives one of the eight states and a reason in plain characters', () => {
    fc.assert(
      fc.property(inputs, (g) => {
        const { shown } = run(g);
        return HOST_STATES.includes(shown.state) && /^[\x20-\x7e]{1,400}$/.test(shown.reason);
      }),
      { numRuns: 3000 },
    );
  });
});
