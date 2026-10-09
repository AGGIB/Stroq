import { describe, expect, it } from 'vitest';
import { HOST_CAPABILITIES } from '../../src/hosts/capabilities.js';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { LiveOutcome } from '../../src/live/types.js';
import { CLAUDE, CURSOR, T0, T1, input, stateOf, stored } from './states-helpers.js';

/**
 * What `stroq doctor` shows for a host is one of eight states, and the table below is every cell of the
 * rule that picks it. The rule has two halves. What the machine shows (a hook entry, a call after the
 * install) can raise a host as far as "observed". Only a stored live check can say more, and then only
 * while Stroq, the policy and the host are the ones it was run against; and a check that could not tell
 * is never turned into one that could.
 */

describe('a host that cannot be driven', () => {
  it('is unsupported when the table has no entry for it', () => {
    expect(displayState(input({ capabilities: undefined }))).toEqual({
      state: 'unsupported',
      reason: 'no live check is defined for this agent',
    });
  });

  it('is unsupported for the reason the table gives', () => {
    expect(displayState(input({ capabilities: CURSOR }))).toEqual({
      state: 'unsupported',
      reason: 'no verified headless hook mode',
    });
  });

  // Whatever else is known of such a host, a check was not run against it, so no stored result is its
  // own, and nothing in the table can be raised by a call after the install.
  it.each<[string, Partial<DisplayStateInput>]>([
    ['it is installed and was called after the install', { stampAt: T1, installRecordedAt: T0 }],
    ['it is not installed', { installed: { installed: false, changed: false } }],
    ['a verified result is stored for it', { stored: stored('verified') }],
    ['a failed result is stored for it', { stored: stored('failed') }],
  ])('is unsupported even when %s', (_name, over) => {
    expect(stateOf({ capabilities: CURSOR, ...over })).toBe('unsupported');
  });
});

describe('a host whose hook is not whole', () => {
  const broken: ReadonlyArray<readonly [string, DisplayStateInput['installed'], RegExp]> = [
    ['not installed', { installed: false, changed: false }, /not installed/],
    ['changed since stroq init', { installed: true, changed: true }, /changed since stroq init/],
    [
      'pointing at a path that is gone',
      { installed: true, changed: false, vanished: true },
      /no longer exists/,
    ],
    [
      'not approved by the host',
      { installed: true, changed: false, unapproved: true },
      /not approved/,
    ],
    ['shadowed by another file', { installed: true, changed: false, shadowed: true }, /shadow/],
    ['unable to start', { installed: true, changed: false, unstartable: true }, /cannot start/],
  ];

  it.each(broken)('is not attempted when the hook is %s, and says why', (_name, installed, why) => {
    const shown = displayState(input({ installed }));
    expect(shown.state).toBe('not-attempted');
    expect(shown.reason).toMatch(why);
  });

  it.each(broken)(
    'is not raised to observed by a call after the install when the hook is %s',
    (_name, installed) => {
      expect(stateOf({ installed, stampAt: T1, installRecordedAt: T0 })).toBe('not-attempted');
    },
  );

  it('reads a flag that is explicitly false as absent', () => {
    expect(
      stateOf({
        installed: {
          installed: true,
          changed: false,
          vanished: false,
          unapproved: false,
          shadowed: false,
          unstartable: false,
        },
      }),
    ).toBe('installed');
  });
});

describe('a host with nothing stored', () => {
  // The call that counts is one after the install: an older one was made by an older hook line.
  const cells: ReadonlyArray<readonly [string, Date | null, Date | null, string]> = [
    ['no call and no record of the install', null, null, 'installed'],
    ['a call and no record of the install, so nothing to compare it with', T1, null, 'installed'],
    ['no call and a record of the install', null, T0, 'installed'],
    ['a call before the install was recorded', T0, T1, 'installed'],
    ['a call at the very moment the install was recorded', T0, T0, 'installed'],
    ['a call after the install was recorded', T1, T0, 'observed'],
  ];

  it.each(cells)('with %s it is %s', (_name, stampAt, installRecordedAt, state) => {
    expect(stateOf({ stampAt, installRecordedAt })).toBe(state);
  });

  it('says what each state does and does not show', () => {
    expect(displayState(input()).reason).toMatch(/installed/);
    const observed = displayState(input({ stampAt: T1, installRecordedAt: T0 }));
    expect(observed.reason).toMatch(/ran the hook command/);
    expect(observed.reason).toMatch(/not checked/);
  });
});

describe('a host with a verified result stored', () => {
  it('is verified while Stroq, the policy and the host are the ones it was checked against', () => {
    const shown = displayState(input({ stored: stored('verified') }));
    expect(shown.state).toBe('verified');
    expect(shown.reason).toContain('2026-10-10');
    expect(shown.reason).toContain('2.1.271');
  });

  it('is verified for a host that has no version, when it had none then either', () => {
    expect(stateOf({ stored: stored('verified', { hostVersion: null }), hostVersion: null })).toBe(
      'verified',
    );
  });

  it('is verified whatever the calls after the install say: a check outranks a sighting', () => {
    expect(stateOf({ stored: stored('verified'), stampAt: T1, installRecordedAt: T0 })).toBe(
      'verified',
    );
    expect(stateOf({ stored: stored('verified'), stampAt: T0, installRecordedAt: T1 })).toBe(
      'verified',
    );
  });

  const stale: ReadonlyArray<readonly [string, Partial<DisplayStateInput>, RegExp[]]> = [
    ['Stroq is another version', { stroqVersion: '0.24.0' }, [/Stroq 0\.23\.0 is now 0\.24\.0/]],
    ['the policy changed', { policySha256: 'b'.repeat(64) }, [/policy changed/]],
    [
      'the host is another version',
      { hostVersion: '2.2.0' },
      [/host went from 2\.1\.271 to 2\.2\.0/],
    ],
    ['the host has no version now', { hostVersion: null }, [/host version is not known now/]],
    [
      'the host had no version then',
      { stored: stored('verified', { hostVersion: null }) },
      [/host version was not known then/],
    ],
    [
      'all three changed',
      { stroqVersion: '0.24.0', policySha256: 'b'.repeat(64), hostVersion: '2.2.0' },
      [/Stroq 0\.23\.0 is now 0\.24\.0/, /policy changed/, /host went from/],
    ],
  ];

  it.each(stale)('is stale when %s, and names what', (_name, over, names) => {
    const shown = displayState(input({ stored: stored('verified'), ...over }));
    expect(shown.state).toBe('stale');
    for (const name of names) expect(shown.reason).toMatch(name);
    expect(shown.reason).toMatch(/stroq prove/);
  });

  it('is stale, and not verified, when the hook is no longer whole', () => {
    const shown = displayState(
      input({ stored: stored('verified'), installed: { installed: true, changed: true } }),
    );
    expect(shown.state).toBe('stale');
    expect(shown.reason).toMatch(/changed since stroq init/);
  });

  it('is stale, and not verified, when the hook is gone', () => {
    expect(
      stateOf({
        stored: stored('verified'),
        installed: { installed: false, changed: false },
      }),
    ).toBe('stale');
  });
});

describe('a stored result whose probes gave no reason', () => {
  const unreasoned = (mark: 'failed' | 'inconclusive') => ({
    id: 'deny',
    kind: 'deny' as const,
    mark,
    evidence: { E1: null, E2: null, E3: null, E4: null },
  });

  it('names a failed probe by its mark', () => {
    const shown = displayState(
      input({ stored: stored('failed', { probes: [unreasoned('failed')] }) }),
    );
    expect(shown.reason).toContain('deny failed');
  });

  it('names a doubt by its mark', () => {
    const shown = displayState(
      input({ stored: stored('inconclusive', { probes: [unreasoned('inconclusive')] }) }),
    );
    expect(shown.reason).toContain('inconclusive');
  });

  it('says there is no headless mode when the table gives no other reason', () => {
    expect(displayState(input({ capabilities: { headless: false, caveats: [] } }))).toEqual({
      state: 'unsupported',
      reason: 'no headless mode',
    });
  });
});

describe('a host with a failed result stored', () => {
  it('is failed, and names the probes that failed and why', () => {
    const shown = displayState(input({ stored: stored('failed') }));
    expect(shown.state).toBe('failed');
    expect(shown.reason).toContain('deny executed-despite-deny');
  });

  // A failure is lifted by a later check and by nothing else: a new version of anything is a reason
  // to look again and not a reason to look away.
  it.each<[string, Partial<DisplayStateInput>]>([
    ['Stroq is another version', { stroqVersion: '0.24.0' }],
    ['the policy changed', { policySha256: 'c'.repeat(64) }],
    ['the host is another version', { hostVersion: '9.9.9' }],
    ['the hook was installed again', { stampAt: T0, installRecordedAt: T1 }],
    ['the hook is gone', { installed: { installed: false, changed: false } }],
    ['the hook was changed', { installed: { installed: true, changed: true } }],
  ])('stays failed when %s', (_name, over) => {
    expect(stateOf({ stored: stored('failed'), ...over })).toBe('failed');
  });

  it('says it is worth checking again when something has changed since', () => {
    const shown = displayState(input({ stored: stored('failed'), stroqVersion: '0.24.0' }));
    expect(shown.reason).toMatch(/changed since/);
    expect(shown.reason).toMatch(/stroq prove/);
  });
});

describe('a host whose last check could not tell', () => {
  it('is inconclusive, and gives the reasons', () => {
    const shown = displayState(input({ stored: stored('inconclusive') }));
    expect(shown.state).toBe('inconclusive');
    expect(shown.reason).toContain('limit');
    expect(shown.reason).toContain('timeout');
  });

  it('is not attempted when the last check did not run', () => {
    const shown = displayState(input({ stored: stored('not-attempted') }));
    expect(shown.state).toBe('not-attempted');
    expect(shown.reason).toMatch(/did not run/);
  });

  it('is not raised to observed by a call after the install', () => {
    expect(stateOf({ stored: stored('inconclusive'), stampAt: T1, installRecordedAt: T0 })).toBe(
      'inconclusive',
    );
  });

  it('is not attempted, whatever the last check was, when the hook is not whole', () => {
    const gone = { installed: { installed: false, changed: false } };
    expect(stateOf({ stored: stored('inconclusive'), ...gone })).toBe('not-attempted');
    expect(stateOf({ stored: stored('not-attempted'), ...gone })).toBe('not-attempted');
  });

  it('gives a plain line even when the stored result has no probes', () => {
    const shown = displayState(input({ stored: stored('inconclusive', { probes: [] }) }));
    expect(shown.state).toBe('inconclusive');
    expect(shown.reason).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('a result from a stand-in for a host', () => {
  // A double answers the questions it is built to answer. What it shows is about the double.
  it.each<LiveOutcome>(['verified', 'failed', 'inconclusive', 'not-attempted'])(
    'does not count when it is %s: the host is shown as if nothing were stored',
    (state) => {
      expect(stateOf({ stored: stored(state, { mode: 'stand-in' }) })).toBe('installed');
      expect(
        stateOf({
          stored: stored(state, { mode: 'stand-in' }),
          stampAt: T1,
          installRecordedAt: T0,
        }),
      ).toBe('observed');
    },
  );
});
