import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

const counts = <T extends string>(values: readonly T[]): Readonly<Record<string, number>> =>
  values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

describe('the attack matrix', () => {
  it('covers at least eight distinct origins', () => {
    expect(Object.keys(counts(SCENARIOS.map((s) => s.origin))).length).toBeGreaterThanOrEqual(8);
  });

  it('covers at least five distinct encodings', () => {
    expect(Object.keys(counts(SCENARIOS.map((s) => s.encoding))).length).toBeGreaterThanOrEqual(5);
  });

  // `EFFECTS` has eight values; `source-exfil` and `data-poisoning` are not modelled
  // by any launch or synthetic cell in this plan (none of the seven cells Task 5
  // authored targets either one, so six is the true ceiling here, not seven) — left
  // uncovered in the vocabulary rather than faked onto a cell that does not fit,
  // the same choice Task 5 already made for the `mcp-tool-description` origin.
  it('covers at least six distinct effects', () => {
    expect(Object.keys(counts(SCENARIOS.map((s) => s.effect))).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps documented and synthetic cells countable apart', () => {
    const documented = SCENARIOS.filter((s) => s.incident !== null);
    const synthetic = SCENARIOS.filter((s) => s.incident === null);
    expect(documented.length).toBe(12);
    expect(synthetic.length).toBeGreaterThanOrEqual(7);
    for (const s of synthetic) expect(s.class).not.toBeNull();
  });

  it('gives every scenario a unique id in NN-kebab-case order', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{2}-[a-z0-9-]+$/);
    expect([...ids].sort()).toEqual(ids);
  });
});
