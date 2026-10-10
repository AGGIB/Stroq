import { describe, expect, it } from 'vitest';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { LiveOutcome } from '../../src/live/types.js';
import { input, stored } from './states-helpers.js';

/**
 * What a reason says beyond the state: the caveats of the result it comes from, and, for a hook that
 * does not work, what to do about the hook. Beside the table of the states themselves in `states.test.ts`.
 */
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
