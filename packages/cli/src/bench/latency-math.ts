/**
 * Latency metrics and nearest-rank percentile calculations.
 *
 * For a sorted list of N values, rank = ceil((P / 100) * N) (1-indexed).
 */

export interface MetricSummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

/** Computes the nearest-rank percentile of a list of values. */
export function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index] ?? 0;
}

const round1 = (val: number): number => Math.round(val * 10) / 10;

/** Computes summary statistics (p50, p95, p99, min, max) rounded to 1 decimal place. */
export function summarizeMetric(values: readonly number[]): MetricSummary {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round1(nearestRank(sorted, 50)),
    p95: round1(nearestRank(sorted, 95)),
    p99: round1(nearestRank(sorted, 99)),
    min: round1(sorted[0] ?? 0),
    max: round1(sorted[sorted.length - 1] ?? 0),
  };
}
