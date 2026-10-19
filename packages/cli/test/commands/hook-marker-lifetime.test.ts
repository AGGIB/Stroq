import { HOOK_DEADLINE_CEILING_MS, MARKER_LIFETIME_MS } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { LONGEST_HOOK_DEADLINE_MS, SUPPORTED_AGENTS } from '../../src/commands/hook.js';

// The store marks a result as being recorded with the time by which the hook that is recording it
// has to be done. The core cannot read the hook's watchdog, so it holds the longest deadline as a
// number of its own, and this is what fails when the two stop agreeing: a marker that expired
// before its hook did would be read as a result nobody scanned while it was being scanned, and one
// that outlived it by much would let an unscanned result pass as a result in flight.

describe('how long a marker may stand', () => {
  it('is the longest deadline any hook gives itself, and a small margin', () => {
    expect(LONGEST_HOOK_DEADLINE_MS).toBe(HOOK_DEADLINE_CEILING_MS);
    expect(MARKER_LIFETIME_MS).toBeGreaterThan(LONGEST_HOOK_DEADLINE_MS);
    expect(MARKER_LIFETIME_MS - LONGEST_HOOK_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });

  it('is taken from a table that has an entry for every agent', () => {
    expect(SUPPORTED_AGENTS.length).toBeGreaterThan(0);
    expect(LONGEST_HOOK_DEADLINE_MS).toBeGreaterThan(0);
  });
});
