import { describe, expect, it } from 'vitest';
import { atlasIds, loadAtlas } from '../../src/coverage/atlas.js';
import { loadScope } from '../../src/coverage/scope.js';

describe('the ATLAS scope declaration', () => {
  it('is pinned to the vendored release', () => {
    expect(loadScope().atlasRelease).toBe(loadAtlas().release);
  });

  it('accounts for every technique in the denominator, exactly once', () => {
    const scope = loadScope();
    const seen = new Map<string, number>();
    for (const t of scope.inScope) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
    for (const g of scope.outOfScope)
      for (const id of g.ids) seen.set(id, (seen.get(id) ?? 0) + 1);

    const denominator = atlasIds();
    const unaccounted = [...denominator].filter((id) => !seen.has(id));
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    const unknown = [...seen.keys()].filter((id) => !denominator.has(id));

    expect(unaccounted, `techniques with no scope decision: ${unaccounted.join(', ')}`).toEqual([]);
    expect(duplicated, `techniques declared twice: ${duplicated.join(', ')}`).toEqual([]);
    expect(unknown, `ids not in the vendored denominator: ${unknown.join(', ')}`).toEqual([]);
  });

  it('gives every exclusion group a reason a reader can weigh', () => {
    for (const g of loadScope().outOfScope) {
      expect(g.reason.length).toBeGreaterThan(30);
      expect(g.ids.length).toBeGreaterThan(0);
    }
  });

  it('keeps the in-scope set small enough to be a claim rather than a boast', () => {
    // A local action firewall addressing more than a third of ATLAS would be a sign
    // the scope file is wishful rather than considered. This is a smell test, not a law.
    const scope = loadScope();
    expect(scope.inScope.length).toBeLessThan(atlasIds().size / 3);
    expect(scope.inScope.length).toBeGreaterThan(10);
  });
});
