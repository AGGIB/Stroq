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
 * `classify-tool.ts`), except `instruction-scan-took-too-long`, which the engine adds;
 * `limit-signals.test.ts` and `engine-signals.test.ts` produce each of them with the real code, so a
 * rename there fails a test here and does not quietly turn a limit back into an ordinary ask.
 *
 * Other signals on `shell.unparsed` (`nested-commands-too-large`, `function-call-not-read`,
 * `script-limit`, `script:*:too-large`) are limits of a kind too, but they sit beside signals that
 * name what the command does, so an ask that carries one is not by itself an ask caused by the limit.
 */

/**
 * Signals whose occurrence depends on the clock. `reading-took-too-long` comes from the classifier;
 * `instruction-scan-took-too-long` from the engine, when the scan of the text a write puts into an
 * instruction file ran out of its budget (`engine.ts`).
 */
export const INSTRUCTION_SCAN_CLOCK_SIGNAL = 'instruction-scan-took-too-long';

export const CLOCK_SIGNALS: readonly string[] = [
  'reading-took-too-long',
  INSTRUCTION_SCAN_CLOCK_SIGNAL,
];

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
