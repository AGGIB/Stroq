/**
 * A deadline for the reading of one command, checked where the reading goes round again.
 *
 * The estimate of what a command costs (`reading-cost.ts`) is made before it is read, and is right for the shapes
 * it was measured on. A shape that was not measured is read as slowly as it is: a reviewer's soup of sixteen
 * kilobytes of every construct at once took eleven seconds, where the host gives up at fifteen and allows. The
 * clock stops what the estimate did not, and the command is asked about, as one that is too costly is.
 *
 * The check is cheap and is made where a text is taken apart (a lexing, a splitting into words, a round of
 * putting functions in place), which a slow command does many times; a single step that is itself slow (one
 * pattern that backtracks) is not interrupted by it, and is what the gate shapes in `classify-redos-gate.test.ts`
 * hold to be linear.
 */
const CHECK_EVERY = 16;

/** How long the reading of one command may take, from when it begins; the host waits fifteen seconds in all. */
export const READING_DEADLINE_MS = 8_000;

let until = Infinity;
let calls = 0;

/** What a check throws when the time is spent: caught by `withDeadline`, and by nothing else. */
export class ReadingTookTooLong extends Error {
  constructor() {
    super('reading took too long');
  }
}

/** Throws where the deadline of the reading that is going on has passed; otherwise nothing. */
export function checkDeadline(): void {
  calls += 1;
  if (calls % CHECK_EVERY === 0 && performance.now() > until) throw new ReadingTookTooLong();
}

/**
 * `read()`, or `expired()` where the clock stops it. A reading that is begun inside another has the deadline of
 * the one that is going on, if that is sooner.
 */
export function withDeadline<T>(ms: number, read: () => T, expired: () => T): T {
  const outer = until;
  until = Math.min(outer, performance.now() + ms);
  try {
    return read();
  } catch (error) {
    if (error instanceof ReadingTookTooLong) return expired();
    throw error;
  } finally {
    until = outer;
  }
}
