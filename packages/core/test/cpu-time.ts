/**
 * The processor time this process has used, in milliseconds.
 *
 * A test that a reading stays linear asks how long the reading took, and the wall clock answers
 * something else when the machine is busy or asleep: a run on a laptop that went to sleep for a
 * quarter of an hour reported a test of a few milliseconds as taking fifteen minutes. Processor
 * time counts only what the reading itself used.
 */
export function cpuNow(): number {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
}
