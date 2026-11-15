import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { SLOWNESS, TIMINGS, cpuNow, leastTime, timeOf } from './cpu-time.js';

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

  it('is the processor time used divided by how slow the machine is', () => {
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

  it.skipIf(typeof process.threadCpuUsage !== 'function')(
    'does not count what another thread of the process uses',
    () => {
      // A worker spends SPAN_MS of its own processor time while this thread sleeps on a lock: the process has
      // used that time, and the thread a reading would run in has not.
      const done = new Int32Array(new SharedArrayBuffer(4));
      const worker = new Worker(
        `const { workerData } = require('node:worker_threads');
        const done = new Int32Array(workerData.done);
        const started = process.threadCpuUsage();
        let spent = 0;
        for (let pieces = 0; pieces < ${MAX_PIECES}; pieces += 1) {
          for (let i = 0; i < ${PIECE}; i += 1) spent += Math.sqrt(i);
          const used = process.threadCpuUsage(started);
          if ((used.user + used.system) / 1000 >= ${SPAN_MS}) break;
        }
        Atomics.store(done, 0, spent > 0 ? 1 : 2);
        Atomics.notify(done, 0);`,
        { eval: true, workerData: { done: done.buffer } },
      );
      const processBefore = process.cpuUsage();
      const started = cpuNow();
      Atomics.wait(done, 0, 0, 60_000);
      const own = (cpuNow() - started) * SLOWNESS;
      const used = process.cpuUsage(processBefore);
      void worker.terminate();

      expect(Atomics.load(done, 0)).toBe(1);
      expect((used.user + used.system) / 1000).toBeGreaterThanOrEqual(SPAN_MS);
      // A tick of the Windows clock (16 ms) and the start of the worker, at most.
      expect(own).toBeLessThan(SPAN_MS / 4);
    },
  );
});

describe('timeOf', () => {
  it('is the time of one run of what it is given', () => {
    let runs = 0;
    const took = timeOf(() => {
      runs += 1;
      return piece();
    });

    expect(runs).toBe(1);
    expect(took).toBeGreaterThanOrEqual(0);
  });
});

describe('leastTime', () => {
  /** A measure that answers `times` in turn, and counts how often it was asked. */
  const answering = (times: readonly number[]) => {
    let asked = 0;
    return {
      measure: (): number => times[Math.min(asked++, times.length - 1)] as number,
      asked: (): number => asked,
    };
  };
  const over = (bound: number) => (ms: number) => ms >= bound;

  it('takes a time that is not too slow once', () => {
    const m = answering([90, 10]);

    expect(leastTime(m.measure, over(100))).toBe(90);
    expect(m.asked()).toBe(1);
  });

  it('takes a time that looks too slow again, and keeps the least', () => {
    const m = answering([150, 80, 120]);

    expect(leastTime(m.measure, over(100))).toBe(80);
    expect(m.asked()).toBe(2);
  });

  it('keeps a time that is too slow every time, as a quadratic reading is', () => {
    const m = answering([400, 390, 410, 395, 405, 1]);

    expect(leastTime(m.measure, over(100))).toBe(390);
    expect(m.asked()).toBe(TIMINGS);
    expect(leastTime(answering([400, 390, 410, 395, 405, 1]).measure, over(100), 5)).toBe(390);
  });

  it('never takes the mean, which would keep the noise in it', () => {
    expect(leastTime(answering([300, 120, 30]).measure, over(100))).toBe(30);
    expect(leastTime(answering([300, 300, 300]).measure, over(100))).toBe(300);
  });
});
