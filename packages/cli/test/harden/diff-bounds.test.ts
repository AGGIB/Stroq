import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_EDIT_DISTANCE,
  unifiedDiff,
} from '../../src/harden/diff.js';
import { HardenError } from '../../src/harden/types.js';
import { cpuNow } from '../../../core/test/cpu-time.js';
import { applyUnifiedDiff, diff, lines, numbers } from './diff-apply.js';

describe('unifiedDiff: size bound', () => {
  it('exports the bounds it refuses at', () => {
    expect(MAX_DIFF_BYTES).toBe(512 * 1024);
    expect(MAX_DIFF_LINES).toBe(20_000);
  });

  it('refuses an input above 512 KiB, on either side, with a typed error', () => {
    const big = `${'x'.repeat(MAX_DIFF_BYTES)}y`;
    for (const attempt of [() => diff(big, 'a'), () => diff('a', big)]) {
      let error: unknown;
      try {
        attempt();
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(HardenError);
      expect(error).toMatchObject({ code: 'diff-too-large' });
    }
  });

  it('refuses an input above 20,000 lines, on either side', () => {
    const many = '\n'.repeat(MAX_DIFF_LINES + 1);
    expect(() => diff(many, 'a\n')).toThrowError(/too large/);
    expect(() => diff('a\n', many)).toThrowError(/too large/);
  });

  it('counts a last line without its newline as a line', () => {
    const almost = `${'\n'.repeat(MAX_DIFF_LINES)}x`;
    expect(() => diff(almost, '')).toThrowError(/too large/);
  });

  it('accepts an input exactly at the bounds', () => {
    const atLines = 'a\n'.repeat(MAX_DIFF_LINES);
    expect(() => diff(atLines, `${atLines}b\n`.slice(2))).not.toThrow();
    const atBytes = 'x'.repeat(MAX_DIFF_BYTES);
    expect(() => diff(atBytes, `${atBytes.slice(1)}y`)).not.toThrow();
  });

  it('measures bytes, not characters', () => {
    const wide = 'é'.repeat(MAX_DIFF_BYTES / 2 + 1);
    expect(() => diff(wide, '')).toThrowError(/too large/);
  });
});

describe('unifiedDiff: it is a diff of the two texts', () => {
  it('applies back to give the other text, for any two texts and any final newline', () => {
    const line = fc.constantFrom('a', 'b', 'c', 'd', 'e', '');
    const text = fc.tuple(fc.array(line, { maxLength: 14 }), fc.boolean()).map(([rows, final]) => {
      const joined = rows.join('\n');
      return rows.length > 0 && final ? `${joined}\n` : joined;
    });
    fc.assert(
      fc.property(text, text, fc.integer({ min: 0, max: 4 }), (a, b, context) => {
        expect(applyUnifiedDiff(a, unifiedDiff(a, b, { path: 'f', context }))).toBe(b);
      }),
      { numRuns: 1500 },
    );
  });

  it('is a shortest edit: it changes exactly as many lines as the two texts differ in', () => {
    const lcs = (x: readonly string[], y: readonly string[]): number => {
      const table = Array.from({ length: x.length + 1 }, () =>
        new Array<number>(y.length + 1).fill(0),
      );
      for (let i = 1; i <= x.length; i += 1) {
        for (let j = 1; j <= y.length; j += 1) {
          table[i]![j] =
            x[i - 1] === y[j - 1]
              ? table[i - 1]![j - 1]! + 1
              : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
        }
      }
      return table[x.length]![y.length]!;
    };
    const rows = fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 18 });
    fc.assert(
      fc.property(rows, rows, (a, b) => {
        const out = unifiedDiff(lines(...a), lines(...b), { path: 'f' });
        const body = out.split('\n').slice(2);
        const removed = body.filter((row) => row.startsWith('-')).length;
        const added = body.filter((row) => row.startsWith('+')).length;
        const common = lcs(a, b);
        expect(removed).toBe(a.length - common);
        expect(added).toBe(b.length - common);
      }),
      { numRuns: 1500 },
    );
  });

  it('is the same every time', () => {
    const a = lines(...numbers(1, 60));
    const b = lines(...numbers(1, 20), 'x', ...numbers(21, 40), ...numbers(45, 60));
    expect(diff(a, b)).toBe(diff(a, b));
  });
});

describe('unifiedDiff: large inputs', () => {
  it('diffs two 20,000-line files that differ in one line without slowing down', () => {
    const a = lines(...numbers(1, MAX_DIFF_LINES));
    const rows = numbers(1, MAX_DIFF_LINES);
    rows[10_000] = 'changed';
    const b = lines(...rows);
    const started = cpuNow();

    const out = diff(a, b);

    expect(cpuNow() - started).toBeLessThan(5_000);
    expect(out).toContain('-10001\n+changed\n');
    expect(applyUnifiedDiff(a, out)).toBe(b);
  });

  it('still gives a correct diff when almost every line differs, in bounded time', () => {
    const count = MAX_EDIT_DISTANCE + 500;
    const a = lines(...Array.from({ length: count }, (_, i) => `old ${i}`));
    const b = lines(...Array.from({ length: count }, (_, i) => `new ${i}`));
    const started = cpuNow();

    const out = diff(a, b);

    expect(cpuNow() - started).toBeLessThan(10_000);
    expect(applyUnifiedDiff(a, out)).toBe(b);
    expect(out.split('\n').filter((row) => row.startsWith('-old')).length).toBe(count);
  });

  // Long runs of equal lines are the shape that makes a line diff slow: every diagonal can follow a
  // long run of matches before it fails.
  it('copes with thousands of repeated lines and changes scattered among them', () => {
    const rows = (every: number): string[] =>
      Array.from({ length: 4_000 }, (_, i) => (i % every === 0 ? 'y' : 'x'));
    const a = lines(...rows(7));
    const b = lines(...rows(11));
    const started = cpuNow();

    const out = diff(a, b);

    expect(cpuNow() - started).toBeLessThan(10_000);
    expect(applyUnifiedDiff(a, out)).toBe(b);
  });
});
