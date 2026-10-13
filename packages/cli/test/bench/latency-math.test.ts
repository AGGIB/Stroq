import { describe, expect, it } from 'vitest';
import { nearestRank, summarizeMetric } from '../../src/bench/latency-math.js';

describe('nearestRank', () => {
  it('returns 0 for empty array', () => {
    expect(nearestRank([], 50)).toBe(0);
  });

  it('handles single element array', () => {
    expect(nearestRank([42], 50)).toBe(42);
    expect(nearestRank([42], 95)).toBe(42);
    expect(nearestRank([42], 99)).toBe(42);
  });

  it('computes nearest rank percentiles for 10 elements', () => {
    // 10 elements: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    const vals = [10, 1, 5, 2, 9, 3, 8, 4, 7, 6];
    // rank = ceil(50/100 * 10) = 5 -> index 4 -> 5
    expect(nearestRank(vals, 50)).toBe(5);
    // rank = ceil(95/100 * 10) = 10 -> index 9 -> 10
    expect(nearestRank(vals, 95)).toBe(10);
    // rank = ceil(99/100 * 10) = 10 -> index 9 -> 10
    expect(nearestRank(vals, 99)).toBe(10);
  });

  it('computes nearest rank percentiles for 100 elements', () => {
    // 1 to 100
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    // p50: ceil(50) = 50 -> index 49 -> 50
    expect(nearestRank(vals, 50)).toBe(50);
    // p95: ceil(95) = 95 -> index 94 -> 95
    expect(nearestRank(vals, 95)).toBe(95);
    // p99: ceil(99) = 99 -> index 98 -> 99
    expect(nearestRank(vals, 99)).toBe(99);
  });
});

describe('summarizeMetric', () => {
  it('summarizes metrics with rounding to 1 decimal place', () => {
    const vals = [10.23, 15.67, 20.89, 25.12, 30.45];
    const summary = summarizeMetric(vals);
    // 5 elements:
    // p50: ceil(0.5 * 5) = 3 -> index 2 -> 20.89 -> 20.9
    // p95: ceil(0.95 * 5) = 5 -> index 4 -> 30.45 -> 30.5
    // p99: ceil(0.99 * 5) = 5 -> index 4 -> 30.45 -> 30.5
    expect(summary.p50).toBe(20.9);
    expect(summary.p95).toBe(30.5);
    expect(summary.p99).toBe(30.5);
    expect(summary.min).toBe(10.2);
    expect(summary.max).toBe(30.5);
  });

  it('handles empty samples gracefully', () => {
    const summary = summarizeMetric([]);
    expect(summary.p50).toBe(0);
    expect(summary.p95).toBe(0);
    expect(summary.p99).toBe(0);
    expect(summary.min).toBe(0);
    expect(summary.max).toBe(0);
  });
});
