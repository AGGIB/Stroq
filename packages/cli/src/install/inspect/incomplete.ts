// Whether a passport lacks what a reading would have found.
//
// A passport is made even when a reading fails, so that a person can see what the others found. But
// it is not a complete one, and a command that confirms an artifact on the strength of a passport
// (`vet --expect`, `add`) must not take it for one: it refuses, and exits with a failure. The fact is
// read from the `signals` of the passport, whose rule ids are fixed words and never text of the
// artifact, and not from its lines or blind spots, which hold text that an artifact can influence.
import type { Passport } from '../types.js';

const PREFIX = 'reading-failed:';

/** The readings that failed when the passport was made, by name, once each and in order. */
export function failedReadings(passport: Pick<Passport, 'signals'>): string[] {
  const names = passport.signals
    .filter((signal) => signal.ruleId.startsWith(PREFIX))
    .map((signal) => signal.ruleId.slice(PREFIX.length));
  return [...new Set(names)].sort();
}

/** True when a reading failed, so that the passport does not hold everything the reading finds. */
export const passportIsIncomplete = (passport: Pick<Passport, 'signals'>): boolean =>
  failedReadings(passport).length > 0;
