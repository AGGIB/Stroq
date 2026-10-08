import { describe, expect, it } from 'vitest';
import { SLOWNESS, cpuNow } from './cpu-time.js';

/** Processor time that the work of the next test is made to take, at least. */
const SPAN_MS = 200;
/** The work is done in pieces of this size, so that it can stop soon after `SPAN_MS`. */
const PIECE = 500_000;
/** Pieces after which the work stops whatever the clock says, so that a clock that never moves fails the test. */
const MAX_PIECES = 10_000;

const piece = (): number => {
  let spent = 0;
  for (let i = 0; i < PIECE; i += 1) spent += Math.sqrt(i);
  return spent;
};

describe('cpuNow', () => {
  it('only goes forward', () => {
    const first = cpuNow();
    let spent = 0;
    for (let i = 0; i < 200_000; i += 1) spent += Math.sqrt(i);
    const second = cpuNow();

    expect(spent).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('is the processor time of the process divided by how slow the machine is', () => {
    // Windows counts processor time in ticks of about 16 ms, so work of a few milliseconds reads as nothing or as
    // one tick, and the comparison below was made of that (it failed on a runner with `expected 0 to be greater
    // than 4`). Work of 200 ms is a dozen ticks, and the one tick that is missing or extra is a small part of it.
    const before = process.cpuUsage();
    let spent = 0;
    let pieces = 0;
    let raw = 0;
    while (raw < SPAN_MS && pieces < MAX_PIECES) {
      spent += piece();
      pieces += 1;
      const used = process.cpuUsage(before);
      raw = (used.user + used.system) / 1000;
    }
    const started = cpuNow();
    for (let i = 0; i < pieces; i += 1) spent += piece();
    const scaled = cpuNow() - started;

    expect(spent).toBeGreaterThan(0);
    expect(raw).toBeGreaterThanOrEqual(SPAN_MS);
    // The same work, twice: the second is read through the correction, so it is no more than about the first.
    expect(scaled * SLOWNESS).toBeGreaterThan(raw / 4);
    expect(scaled * SLOWNESS).toBeLessThan(raw * 4 + 50);
  });

  it('never makes a machine out to be faster than the reference one', () => {
    expect(SLOWNESS).toBeGreaterThanOrEqual(1);
    expect(SLOWNESS).toBeLessThanOrEqual(16);
  });
});
