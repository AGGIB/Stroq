/**
 * The processor time this process has used, in milliseconds, as a reference machine would have
 * used it. A test that a reading stays linear asks how long the reading took, and the wall clock
 * answers something else when the machine is busy or asleep: processor time counts only what the
 * reading itself used.
 *
 * It is divided by how much slower this machine is than the one the bounds were written on, found
 * with a fixed piece of work that does not touch the code under test (so that code which gets
 * slower is still seen). A shared runner with coverage switched on takes several times as long
 * for the same reading, and a bound that fails on the machine and not on the code only teaches
 * people to ignore the test.
 *
 * This is the CLI package's own copy: its tests do not reach into the core package's test folder.
 */

/** What the fixed piece of work took, in milliseconds of processor time, on the reference machine. */
const REFERENCE_MS = 170;
/** A machine slower than this is not corrected for any further: something else is wrong with it. */
const MAX_SLOWNESS = 16;

const processorTime = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

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
  const started = processorTime();
  if (fixedWork() <= 0) return 1;
  const took = processorTime() - started;
  return Math.min(MAX_SLOWNESS, Math.max(1, took / REFERENCE_MS));
}

/** How many times slower than the reference machine this one is, at least 1. Measured once. */
export const SLOWNESS = measureSlowness();

export function cpuNow(): number {
  return processorTime() / SLOWNESS;
}
