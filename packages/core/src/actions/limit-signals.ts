/**
 * Which of the signals of a classification say that Stroq did not read a call to its end, and why.
 *
 * A call can be asked about because it is dangerous, or because Stroq could not judge it. The class
 * alone (`shell.unparsed`) does not say which, and the two are not the same kind of result for a
 * report that counts what the policy stopped:
 *
 * - a LIMIT gives the same answer for the same input on every machine: the command is too costly to
 *   read, the tool took no command, an argument list is longer than is read. Asking is the policy
 *   working as written, and a report may count it, apart from the asks that name a danger.
 * - the CLOCK gives an answer that depends on how busy the machine was. The reading of the command
 *   ran past its deadline (`deadline.ts`), and a quieter machine might have read it to its end and
 *   said something else. A report must not count that as a defence that held.
 *
 * The names are the classifier's own (`classify-shell-tool.ts`, `classify-bash.ts`,
 * `classify-tool.ts`); `limit-signals.test.ts` produces each of them with the real classifier, so a
 * rename there fails a test here and does not quietly turn a limit back into an ordinary ask.
 *
 * Other signals on `shell.unparsed` (`nested-commands-too-large`, `function-call-not-read`,
 * `script-limit`, `script:*:too-large`) are limits of a kind too, but they sit beside signals that
 * name what the command does, so an ask that carries one is not by itself an ask caused by the limit.
 */

/** Signals whose occurrence depends on the clock. */
export const CLOCK_SIGNALS: readonly string[] = ['reading-took-too-long'];

/** Signals of a limit that is the same for the same input, however busy the machine is. */
export const LIMIT_SIGNALS: readonly string[] = [
  'command-too-large',
  'shell-command-unreadable',
  'mcp-args-unreadable',
];

export function isClockSignal(signal: string): boolean {
  return CLOCK_SIGNALS.includes(signal);
}

export function isLimitSignal(signal: string): boolean {
  return LIMIT_SIGNALS.includes(signal);
}
