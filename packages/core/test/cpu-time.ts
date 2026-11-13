/**
 * The processor time this thread has used, in milliseconds, as a reference machine would have used it.
 *
 * A test that a reading stays linear asks how long the reading took, and the wall clock answers
 * something else when the machine is busy or asleep: a run on a laptop that went to sleep for a
 * quarter of an hour reported a test of a few milliseconds as taking fifteen minutes. Processor
 * time counts only what the reading itself used.
 *
 * It is the time of the thread that reads, not of the whole process. V8 marks a large heap and
 * compiles in threads of its own, beside the reading, and the time of the process counts those too,
 * more the larger the text: a test of a reading that the hook's clock stops at eight seconds read
 * 8,199 ms of processor time in a test that took 8,147 ms on a shared runner, and the reader of a
 * bare repository's names took 20 ms at 64 KiB in its own thread and in the process alike, and at
 * 256 KiB 125 ms in its thread and 160 ms in the process: a growth of six for the reading and of
 * eight for the process, which on a shared Windows runner went past the gate's eleven. What the
 * reading thread does, a pattern that backtracks or a loop over a loop, is counted in full; where
 * Node cannot say what one thread used, the whole process is read, as before.
 *
 * It is divided by how much slower this machine is than the one the bounds were written on. A
 * shared runner with coverage switched on takes four to five times as long for the same reading
 * (a reading that takes 1.7 s on a laptop took 8.9 s there, against a bound of 8 s), and a bound
 * that fails on the machine and not on the code only teaches people to ignore the test. The speed
 * is measured with a fixed piece of work that does not touch the code under test, so that a
 * reading that gets slower is still seen. That work is timed as it was when `REFERENCE_MS` was
 * taken, in the time of the whole process, so that the correction means what it did.
 */

/** What the fixed piece of work took, in milliseconds of processor time, on the machine the bounds were written on. */
const REFERENCE_MS = 170;
/** A machine slower than this is not corrected for any further: something else is wrong with it. */
const MAX_SLOWNESS = 16;

const inMs = (used: NodeJS.CpuUsage): number => (used.user + used.system) / 1000;

/** The processor time of the whole process, every thread of it. */
const processTime = (): number => inMs(process.cpuUsage());

/** The processor time of the thread that calls it; `process.threadCpuUsage` is not in every Node 22. */
const threadTime: () => number =
  typeof process.threadCpuUsage === 'function' ? () => inMs(process.threadCpuUsage()) : processTime;

/** A fixed amount of string and pattern work. */
function fixedWork(): number {
  let total = 0;
  const words: string[] = [];
  for (let i = 0; i < 40_000; i += 1) words.push(`w${(i * 2654435761) % 9973}`);
  const text = words.join(' ');
  for (let round = 0; round < 12; round += 1) {
    total += text.split(' ').length;
    total += (text.match(/w\d+7\b/g) ?? []).length;
    total += text.replace(/\d+/g, (digits) => String(digits.length)).length;
    total += [...words].sort().length;
  }
  return total;
}

function measureSlowness(): number {
  const started = processTime();
  if (fixedWork() <= 0) return 1;
  const took = processTime() - started;
  return Math.min(MAX_SLOWNESS, Math.max(1, took / REFERENCE_MS));
}

/** How many times slower than the reference machine this one is, at least 1. Measured once for the process. */
export const SLOWNESS = measureSlowness();

export function cpuNow(): number {
  return threadTime() / SLOWNESS;
}

/** The processor time `run` takes, as the reference machine would have used it. */
export function timeOf(run: () => unknown): number {
  const started = cpuNow();
  run();
  return cpuNow() - started;
}

/** How often a time that looks too slow is taken, the first time included, where a test does not say. */
export const TIMINGS = 3;

/**
 * The same for the largest size of a growth gate, which takes a second or two on a runner and so has room
 * for more. Three timings were not enough there: a slow spell on a shared runner lasts seconds, and on
 * Linux with coverage a command of 256 KiB read 1,247 ms (the most a growth of eleven allowed was 1,188)
 * three times in a row, in a test that took 8.9 s where the same shape takes 1.7 to 3.2 s on other runs.
 * Five reach further past such a spell, and a reading that is quadratic is no faster on the fifth.
 */
export const GATE_TIMINGS = 5;

/**
 * `measure()`, taken again while the least time so far is one `tooSlow` fails, `timings` times at most,
 * and the least of them.
 *
 * Noise only adds to a processor time: a neighbour on the same core, a cache another process emptied,
 * a collection of what an earlier test left. One measurement of the same reading has differed by a
 * factor of three on a shared runner, and a reading that is quadratic is slow every time it is taken.
 * The least is kept and not the mean, which would hold the noise in it; and a time that does not look
 * too slow is not taken again, so a test that passes costs one measurement.
 */
export function leastTime(
  measure: () => number,
  tooSlow: (ms: number) => boolean,
  timings: number = TIMINGS,
): number {
  let least = measure();
  for (let taken = 1; taken < timings && tooSlow(least); taken += 1)
    least = Math.min(least, measure());
  return least;
}
