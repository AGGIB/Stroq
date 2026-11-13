import { GATE_TIMINGS, leastTime, timeOf } from './cpu-time.js';
import { expect } from 'vitest';

/**
 * The gate for readers of text from outside: each one is timed on text built to be slow for it, at three
 * sizes, in processor time (never the wall clock). What is held is the growth and not a number of
 * milliseconds: linear work takes about four times as long for four times the text, a quadratic one sixteen.
 */
const SIZE = 256 * 1024;
export const SIZES = [SIZE / 16, SIZE / 4, SIZE] as const;
/** A time under this is not slow, however much it grew. */
export const BOUND_MS = 300;
export const MAX_GROWTH = 11;

export const repeat =
  (unit: string) =>
  (size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

export type EntryPoint = (text: string) => unknown;

/**
 * Fails if a time is both slow and more than `MAX_GROWTH` times the one before it. A size that looks so is
 * timed again, up to `GATE_TIMINGS` times in all, and the least is kept (`leastTime`). `measure` is the
 * processor time of a run, except in the test of the gate itself, which counts steps instead: a test of
 * the gate that timed a quadratic reader was slow on a coverage runner (past its time limit) and too
 * fast to cross the bound on another, and the gate's arithmetic is what that test is about.
 */
export function expectLinear(
  inputs: readonly string[],
  run: EntryPoint,
  measure: (run: () => unknown) => number = timeOf,
): void {
  const times: number[] = [];
  for (const input of inputs) {
    const before = times[times.length - 1];
    const tooSlow = (took: number): boolean =>
      before !== undefined && took >= BOUND_MS && took >= MAX_GROWTH * before;
    times.push(leastTime(() => measure(() => run(input)), tooSlow, GATE_TIMINGS));
  }
  const growth = times.map((ms, i) => `${ms.toFixed(1)} ms at ${(SIZES[i] ?? 0) / 1024} KiB`);
  for (let i = 1; i < times.length; i += 1) {
    const small = times[i - 1] ?? 0;
    const big = times[i] ?? 0;
    expect(big < BOUND_MS || big < MAX_GROWTH * small, growth.join(', ')).toBe(true);
  }
}
