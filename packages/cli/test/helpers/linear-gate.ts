import { cpuNow } from './cpu-time.js';
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
const TRIES = 3;

export const repeat =
  (unit: string) =>
  (size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

export type EntryPoint = (text: string) => unknown;

const timed = (run: () => unknown): number => {
  const started = cpuNow();
  run();
  return cpuNow() - started;
};

/**
 * Fails if a time is both slow and more than `MAX_GROWTH` times the one before it. `measure` is the
 * processor time of a run, except in the test of the gate itself, which counts steps instead: a test of
 * the gate that timed a quadratic reader was slow on a coverage runner (past its time limit) and too
 * fast to cross the bound on another, and the gate's arithmetic is what that test is about.
 */
export function expectLinear(
  inputs: readonly string[],
  run: EntryPoint,
  measure: (run: () => unknown) => number = timed,
): void {
  const times: number[] = [];
  for (const input of inputs) {
    const before = times[times.length - 1];
    let took = measure(() => run(input));
    for (
      let tries = 1;
      tries < TRIES && before !== undefined && took >= BOUND_MS && took >= MAX_GROWTH * before;
      tries += 1
    ) {
      took = Math.min(
        took,
        measure(() => run(input)),
      );
    }
    times.push(took);
  }
  const growth = times.map((ms, i) => `${ms.toFixed(1)} ms at ${(SIZES[i] ?? 0) / 1024} KiB`);
  for (let i = 1; i < times.length; i += 1) {
    const small = times[i - 1] ?? 0;
    const big = times[i] ?? 0;
    expect(big < BOUND_MS || big < MAX_GROWTH * small, growth.join(', ')).toBe(true);
  }
}
