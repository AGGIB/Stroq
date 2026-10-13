import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import { HOST_STATES, type HostResult } from '../../src/live/types.js';
import { DIGEST } from './helpers.js';
import {
  AFTER_CHECK,
  CLAUDE,
  CURSOR,
  MCP,
  T0,
  T1,
  input as baseInput,
  stored,
} from './states-helpers.js';

/**
 * The harm is in the one combination that was not thought of: a verified that should not be, or a failure
 * or a doubt that turned into either. So the rule is tested as a claim about many machines, and the
 * machines are not made by flipping a coin for each fact about them: a verified needs a dozen things to be
 * true together, and coins make that a few in a thousand, so a claim about verifieds would be a claim
 * about nothing. Each machine here starts from the one on which a host is verified, and has up to three
 * things change: Stroq, the policy or the host updated, the hook reinstalled, changed, or gone, the check
 * made by a stand-in, or a different result stored. The test says how many came out each way, and fails if
 * too few came out verified.
 *
 * The claims are checked against an oracle written out from the raw facts below.
 */

type Mutation = {
  readonly name: string;
  readonly apply: (input: DisplayStateInput) => DisplayStateInput;
};

const withStored = (i: DisplayStateInput, over: Partial<HostResult>): DisplayStateInput =>
  i.stored === null ? i : { ...i, stored: { ...i.stored, ...over } };
const whole = { installed: true, changed: false } as const;

const MUTATIONS: readonly Mutation[] = [
  { name: 'update Stroq', apply: (i) => ({ ...i, stroqVersion: '0.24.0' }) },
  { name: 'change the policy', apply: (i) => ({ ...i, policySha256: 'b'.repeat(64) }) },
  { name: 'update the host', apply: (i) => ({ ...i, hostVersion: '2.2.0' }) },
  { name: 'lose the version of the host', apply: (i) => ({ ...i, hostVersion: null }) },
  {
    name: 'have checked a host whose version was not known',
    apply: (i) => withStored(i, { hostVersion: null }),
  },
  {
    name: 'know neither version',
    apply: (i) => ({ ...withStored(i, { hostVersion: null }), hostVersion: null }),
  },
  { name: 'check a host with none to know', apply: (i) => ({ ...i, capabilities: MCP }) },
  {
    name: 'reinstall the hook after the check',
    apply: (i) => ({ ...i, installRecordedAt: AFTER_CHECK }),
  },
  {
    name: 'have installed the hook before the check',
    apply: (i) => ({ ...i, installRecordedAt: T0 }),
  },
  {
    name: 'see a call after the install',
    apply: (i) => ({ ...i, stampAt: T1, installRecordedAt: T0 }),
  },
  {
    name: 'remove the hook',
    apply: (i) => ({ ...i, installed: { installed: false, changed: false } }),
  },
  {
    name: 'change the hook entry',
    apply: (i) => ({ ...i, installed: { installed: true, changed: true } }),
  },
  {
    name: 'lose the path of the hook',
    apply: (i) => ({ ...i, installed: { ...whole, vanished: true } }),
  },
  {
    name: 'withhold the approval of the host',
    apply: (i) => ({ ...i, installed: { ...whole, unapproved: true } }),
  },
  { name: 'shadow the hook', apply: (i) => ({ ...i, installed: { ...whole, shadowed: true } }) },
  {
    name: 'make the hook unable to start',
    apply: (i) => ({ ...i, installed: { ...whole, unstartable: true } }),
  },
  { name: 'make the check a stand-in', apply: (i) => withStored(i, { mode: 'stand-in' }) },
  { name: 'store a failed result', apply: (i) => ({ ...i, stored: stored('failed') }) },
  {
    name: 'store a result that could not tell',
    apply: (i) => ({ ...i, stored: stored('inconclusive') }),
  },
  {
    name: 'store a result that did not run',
    apply: (i) => ({ ...i, stored: stored('not-attempted') }),
  },
  { name: 'store nothing', apply: (i) => ({ ...i, stored: null }) },
  {
    name: 'give the result caveats',
    apply: (i) =>
      withStored(i, { caveats: ['hook-trust-bypassed', 'no-control-run', 'x'.repeat(100)] }),
  },
  {
    name: 'ask about a host that cannot be driven',
    apply: (i) => ({ ...i, capabilities: CURSOR }),
  },
  {
    name: 'ask about an agent that is not in the table',
    apply: (i) => ({ ...i, capabilities: undefined }),
  },
];

const mutations: fc.Arbitrary<readonly Mutation[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<readonly Mutation[]>([]) },
  { weight: 4, arbitrary: fc.array(fc.constantFrom(...MUTATIONS), { minLength: 1, maxLength: 3 }) },
);

/** The machine on which a host is verified, with some things changed. */
const machines: fc.Arbitrary<DisplayStateInput> = mutations.map((applied) =>
  applied.reduce(
    (machine, mutation) => mutation.apply(machine),
    baseInput({ stored: stored('verified') }),
  ),
);

// ---------------------------------------------------------------------------------------------
// The oracle: whether a host should be verified, read off the raw facts of the machine.

const fine = (i: DisplayStateInput): boolean =>
  i.installed.installed &&
  !i.installed.changed &&
  !i.installed.vanished &&
  !i.installed.unapproved &&
  !i.installed.shadowed &&
  !i.installed.unstartable;

const shouldBeVerified = (i: DisplayStateInput): boolean => {
  const r = i.stored;
  if (r === null || i.capabilities?.headless !== true) return false;
  const hostFree = i.capabilities.hostFree === true;
  return (
    fine(i) &&
    r.mode === 'live' &&
    r.state === 'verified' &&
    r.stroqVersion === i.stroqVersion &&
    r.policySha256 === i.policySha256 &&
    r.hostVersion === i.hostVersion &&
    (r.hostVersion !== null || hostFree) &&
    !(i.installRecordedAt !== null && i.installRecordedAt.getTime() > Date.parse(r.at))
  );
};

const tally = new Map<string, number>();
const count = (key: string): void => void tally.set(key, (tally.get(key) ?? 0) + 1);

function holds(machine: DisplayStateInput): void {
  const shownState = displayState(machine);
  const r = machine.stored;
  count(shownState.state);

  // A verified is shown exactly when the oracle says it should be, and never otherwise.
  expect(shownState.state === 'verified').toBe(shouldBeVerified(machine));
  // A failure is shown only for a live check of a host that can be driven that failed, whatever else.
  if (shownState.state === 'failed')
    expect(
      machine.capabilities?.headless === true && r?.state === 'failed' && r.mode === 'live',
    ).toBe(true);
  // A check that failed stays a failure however the machine has changed, unless the host cannot be driven.
  if (machine.capabilities?.headless === true && r?.state === 'failed' && r.mode === 'live')
    expect(shownState.state).toBe('failed');
  // A check that could not tell is never turned into either answer.
  if (r?.state === 'inconclusive' || r?.state === 'not-attempted')
    expect(['verified', 'failed']).not.toContain(shownState.state);
  // A stand-in is never anything but the machine's own sightings.
  if (r?.mode === 'stand-in')
    expect(['verified', 'failed', 'stale', 'inconclusive']).not.toContain(shownState.state);
  // A stale one is a verified result that no longer holds, and nothing else is.
  if (shownState.state === 'stale') {
    expect(r?.state).toBe('verified');
    expect(r?.mode).toBe('live');
  }
  // The reason is a line of plain characters.
  expect(HOST_STATES).toContain(shownState.state);
  expect(shownState.reason).toMatch(/^[\x20-\x7e]{1,400}$/);
  // The advice for a hook that does not work is never to prove again.
  if (!fine(machine) && r !== null && r.mode === 'live' && machine.capabilities?.headless === true)
    expect(shownState.reason).not.toMatch(/stroq prove/);
  // A result's caveats are in the reason of a result that is shown as itself or as stale.
  if (
    r !== null &&
    r.caveats.length > 0 &&
    ['verified', 'stale', 'failed'].includes(shownState.state) &&
    r.mode === 'live'
  )
    expect(shownState.reason).toContain(r.caveats[0]);
}

describe('what no combination can produce', () => {
  it('holds the claims below for machines on which a host is verified and some things changed', () => {
    tally.clear();
    fc.assert(
      fc.property(machines, (machine) => {
        holds(machine);
        return true;
      }),
      { numRuns: 4000 },
    );
    // A verified is the one state whose claim could be vacuous, so it has to have been seen many times;
    // and so does each state that a verified turns into when something changes.
    const seen = (state: string): number => tally.get(state) ?? 0;
    expect(seen('verified')).toBeGreaterThanOrEqual(200);
    expect(seen('stale')).toBeGreaterThanOrEqual(200);
    expect(seen('failed')).toBeGreaterThanOrEqual(60);
    expect(seen('inconclusive')).toBeGreaterThanOrEqual(30);
    expect(seen('not-attempted')).toBeGreaterThanOrEqual(100);
    expect(seen('unsupported')).toBeGreaterThanOrEqual(100);
    expect(seen('installed') + seen('observed')).toBeGreaterThanOrEqual(30);
  }, 120_000);

  it('shows the host as verified on the machine it started from', () => {
    expect(displayState(baseInput({ stored: stored('verified') })).state).toBe('verified');
    expect(DIGEST).toHaveLength(64);
    expect(CLAUDE?.headless).toBe(true);
  });

  it('has a mutation for each thing a verified depends on', () => {
    const names = MUTATIONS.map((m) => m.name);
    for (const wanted of [
      'update Stroq',
      'change the policy',
      'update the host',
      'know neither version',
      'reinstall the hook after the check',
      'make the check a stand-in',
      'remove the hook',
    ])
      expect(names).toContain(wanted);
    expect(new Set(names).size).toBe(names.length);
  });
});
