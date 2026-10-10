import { describe, expect, it } from 'vitest';
import { HOST_CAPABILITIES } from '../../src/hosts/capabilities.js';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { LiveOutcome } from '../../src/live/types.js';
import {
  AFTER_CHECK,
  CLAUDE,
  CURSOR,
  MCP,
  STORED_AT,
  T0,
  T1,
  input,
  stateOf,
  stored,
} from './states-helpers.js';

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

  // Two versions that are both not known are not the same version: a host that was updated since is
  // exactly what a check cannot tell if it never knew which host it checked.
  it('is stale for a host that has no version, even when it had none then either', () => {
    const shown = displayState(
      input({ stored: stored('verified', { hostVersion: null }), hostVersion: null }),
    );
    expect(shown.state).toBe('stale');
    expect(shown.reason).toMatch(/version of the host is not known/);
    expect(shown.reason).toMatch(/stroq prove/);
  });

  // A host-free check (the MCP proxy is run against a server of ours, with no client) has no host whose
  // version could be known, so a missing one on both sides is the same as it should be.
  it('is verified for a host-free check, which has no host version to know, then or now', () => {
    expect(
      stateOf({
        capabilities: MCP,
        stored: stored('verified', { agent: 'mcp', hostVersion: null }),
        hostVersion: null,
      }),
    ).toBe('verified');
  });

  it.each<[string, string | null, string | null]>([
    ['a version then and none now', '1.0.0', null],
    ['none then and a version now', null, '1.0.0'],
    ['another version', '1.0.0', '1.1.0'],
  ])('is stale for a host-free check too, with %s', (_name, then, now) => {
    expect(
      stateOf({
        capabilities: MCP,
        stored: stored('verified', { hostVersion: then }),
        hostVersion: now,
      }),
    ).toBe('stale');
  });

  describe('and the hook installed again', () => {
    // `stroq init` writes the hook line again, and it may not be the line the check ran with.
    it('is stale when the install was recorded after the check was made, and says so', () => {
      const shown = displayState(
        input({ stored: stored('verified'), installRecordedAt: AFTER_CHECK }),
      );
      expect(shown.state).toBe('stale');
      expect(shown.reason).toMatch(/installed again/);
      expect(shown.reason).toMatch(/stroq prove/);
    });

    it('is stale when the install was recorded after a check that was made earlier on, by a millisecond', () => {
      const at = new Date(Date.parse(STORED_AT) + 1);
      expect(stateOf({ stored: stored('verified'), installRecordedAt: at })).toBe('stale');
    });

    it('is verified when the install was recorded before the check, and at the very moment of it', () => {
      expect(stateOf({ stored: stored('verified'), installRecordedAt: T1 })).toBe('verified');
      expect(stateOf({ stored: stored('verified'), installRecordedAt: new Date(STORED_AT) })).toBe(
        'verified',
      );
    });

    it('is verified when there is no record of the install, which is nothing to compare the check with', () => {
      expect(stateOf({ stored: stored('verified'), installRecordedAt: null })).toBe('verified');
    });

    it('names it among the other things that changed', () => {
      const shown = displayState(
        input({
          stored: stored('verified'),
          installRecordedAt: AFTER_CHECK,
          stroqVersion: '0.24.0',
        }),
      );
      expect(shown.reason).toMatch(/installed again/);
      expect(shown.reason).toMatch(/Stroq 0\.23\.0 is now 0\.24\.0/);
    });
  });

  it('is verified whatever the calls after the install say: a check outranks a sighting', () => {
    expect(stateOf({ stored: stored('verified'), stampAt: T1, installRecordedAt: T0 })).toBe(
      'verified',
    );
    expect(stateOf({ stored: stored('verified'), stampAt: T0, installRecordedAt: T1 })).toBe(
      'verified',
    );
  });

  it('is stale, and not verified, once the hook was installed after the check, calls or no calls', () => {
    expect(
      stateOf({ stored: stored('verified'), stampAt: T1, installRecordedAt: AFTER_CHECK }),
    ).toBe('stale');
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

describe('the caveats of a result', () => {
  const caveated = (state: LiveOutcome, caveats: string[]) =>
    displayState(input({ stored: stored(state, { caveats }) }));

  it('are in the reason of a verified result, so that a check driven with the trust check off is not shown as a plain one', () => {
    const shown = caveated('verified', ['hook-trust-bypassed']);
    expect(shown.state).toBe('verified');
    expect(shown.reason).toContain('hook-trust-bypassed');
    expect(shown.reason).toMatch(/caveats?: hook-trust-bypassed/);
  });

  it.each<LiveOutcome>(['verified', 'failed', 'inconclusive', 'not-attempted'])(
    'are in the reason of a %s result',
    (state) => {
      expect(caveated(state, ['no-control-run', 'host-free proxy check']).reason).toMatch(
        /no-control-run, host-free proxy check/,
      );
    },
  );

  it('are in the reason of a stale result, which is the result of a check that was a verified one', () => {
    const shown = displayState(
      input({
        stored: stored('verified', { caveats: ['hook-trust-bypassed'] }),
        stroqVersion: '0.24.0',
      }),
    );
    expect(shown.state).toBe('stale');
    expect(shown.reason).toContain('hook-trust-bypassed');
  });

  it('are left out when there are none', () => {
    expect(caveated('verified', []).reason).not.toMatch(/caveat/);
  });

  it('are a few, each cut short, with the number of the rest', () => {
    const shown = caveated('verified', ['one', 'two', 'three', 'four', 'five', 'x'.repeat(100)]);
    expect(shown.reason).toMatch(/one, two, three/);
    expect(shown.reason).not.toContain('four');
    expect(shown.reason).toMatch(/\+3 more/);
    const cut = caveated('verified', ['y'.repeat(100)]);
    expect(cut.reason).not.toContain('y'.repeat(100));
    expect(cut.reason).toContain('y'.repeat(30));
  });

  it('leave the reason one line of plain characters, whatever their number and length', () => {
    const shown = caveated(
      'failed',
      Array.from({ length: 16 }, () => 'z'.repeat(120)),
    );
    expect(shown.reason).toMatch(/^[\x20-\x7e]{1,400}$/);
  });
});

describe('a hook that is not whole, and what to do about it', () => {
  // The fix for a hook that does not work is the hook, and a check run again against it would find
  // nothing new: it is never "run stroq prove again".
  const fixes: ReadonlyArray<readonly [string, DisplayStateInput['installed'], RegExp]> = [
    ['not installed', { installed: false, changed: false }, /run stroq init/],
    ['changed since stroq init', { installed: true, changed: true }, /run stroq init/],
    [
      'pointing at a path that is gone',
      { installed: true, changed: false, vanished: true },
      /run stroq init/,
    ],
    ['not approved by the host', { installed: true, changed: false, unapproved: true }, /approve/],
    [
      'shadowed by another file',
      { installed: true, changed: false, shadowed: true },
      /stroq doctor/,
    ],
    ['unable to start', { installed: true, changed: false, unstartable: true }, /stroq doctor/],
  ];

  it.each(fixes)(
    'tells a verified result whose hook is %s the fix, and not to prove again',
    (_n, installed, fix) => {
      const shown = displayState(input({ stored: stored('verified'), installed }));
      expect(shown.state).toBe('stale');
      expect(shown.reason).toMatch(fix);
      expect(shown.reason).not.toMatch(/stroq prove/);
    },
  );

  it.each(fixes)(
    'tells a host that was never checked, whose hook is %s, the fix too',
    (_n, installed, fix) => {
      const shown = displayState(input({ installed }));
      expect(shown.state).toBe('not-attempted');
      expect(shown.reason).toMatch(fix);
      expect(shown.reason).not.toMatch(/stroq prove/);
    },
  );

  it.each(fixes)(
    'tells a failed result with something changed since, whose hook is %s, the fix and not to prove again',
    (_n, installed, fix) => {
      const shown = displayState(
        input({ stored: stored('failed'), installed, stroqVersion: '0.24.0' }),
      );
      expect(shown.state).toBe('failed');
      expect(shown.reason).toMatch(fix);
      expect(shown.reason).not.toMatch(/stroq prove/);
    },
  );

  it('still says to prove again when the hook is whole and something else changed', () => {
    const shown = displayState(input({ stored: stored('failed'), stroqVersion: '0.24.0' }));
    expect(shown.reason).toMatch(/stroq prove/);
    expect(shown.reason).not.toMatch(/stroq init/);
  });

  it('says to prove again for a stale result whose hook is whole', () => {
    const shown = displayState(input({ stored: stored('verified'), stroqVersion: '0.24.0' }));
    expect(shown.reason).toMatch(/stroq prove/);
  });
});
