import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { largest, smallest } from '../../src/sent/extremes.js';
import { byteMatcher, textMatcher } from '../../src/sent/needles.js';

/**
 * A call takes only so many arguments, and a machine can hold more key spellings than that, so
 * the shortest and longest spellings are found by a loop, never by spreading a list into
 * `Math.min`. The loops are tested on 300,000 values; the matchers, which run them, are built
 * over a few thousand keys, which takes seconds even under coverage. Every value is made up.
 */

const MANY = 300_000;
const ord = (i: number): number => 100 + (i % 50);

describe('the smallest and the largest over many values', () => {
  it('the smallest, below the ceiling, even when it comes last', () => {
    const values = Array.from({ length: MANY }, (_, i) => (i === MANY - 1 ? 3 : ord(i)));
    expect(smallest(values, (v) => v, 64)).toBe(3);
  });

  it('the ceiling when no value is below it, and for no values at all', () => {
    const values = Array.from({ length: MANY }, (_, i) => ord(i));
    expect(smallest(values, (v) => v, 64)).toBe(64);
    expect(smallest([], (v: number) => v, 64)).toBe(64);
  });

  it('the largest, above the floor, even when it comes last', () => {
    const values = Array.from({ length: MANY }, (_, i) => (i === MANY - 1 ? 9_000 : ord(i)));
    expect(largest(values, (v) => v, 0)).toBe(9_000);
    expect(largest([], (v: number) => v, 0)).toBe(0);
  });

  it('measures each item once, by the measure given', () => {
    const lists = Array.from({ length: MANY }, (_, i) => ({ depth: ord(i) }));
    expect(smallest(lists, (l) => l.depth, Number.POSITIVE_INFINITY)).toBe(100);
    expect(largest(lists, (l) => l.depth, 0)).toBe(149);
  });
});

describe('building the matchers over a few thousand keys', () => {
  const keys = Array.from({ length: 5_000 }, (_, i) => `FAKEvalue${i}x0123456789abcdef`);

  it('the text matcher finds the last key', () => {
    expect([...textMatcher(keys).find(`a ${keys[4_999]} b`)]).toEqual([4_999]);
  });

  it('the byte matcher finds the last key in a file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'stroq-sent-build-')), 'session.jsonl');
    writeFileSync(path, `a ${keys[4_999]} b`);
    expect([...byteMatcher(keys, []).findInFile(path)]).toEqual([4_999]);
  });
});
