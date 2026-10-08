import { describe, expect, it } from 'vitest';
import { SLOWNESS, cpuNow } from './cpu-time.js';

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
    const before = process.cpuUsage();
    let spent = 0;
    for (let i = 0; i < 3_000_000; i += 1) spent += Math.sqrt(i);
    const used = process.cpuUsage(before);
    const raw = (used.user + used.system) / 1000;
    const started = cpuNow();
    for (let i = 0; i < 3_000_000; i += 1) spent += Math.sqrt(i);
    const scaled = cpuNow() - started;

    expect(spent).toBeGreaterThan(0);
    // The same work, twice: the second is read through the correction, so it is no more than about the first.
    expect(scaled * SLOWNESS).toBeGreaterThan(raw / 4);
    expect(scaled * SLOWNESS).toBeLessThan(raw * 4 + 50);
  });

  it('never makes a machine out to be faster than the reference one', () => {
    expect(SLOWNESS).toBeGreaterThanOrEqual(1);
    expect(SLOWNESS).toBeLessThanOrEqual(16);
  });
});
