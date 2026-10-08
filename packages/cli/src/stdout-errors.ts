import { HANGUP_EXIT_CODE, runInterruptCleanups } from './ui/cleanup.js';

/**
 * What to do when writing to standard output fails. `stroq log --json | head -1` closes the pipe after
 * one line: that is the reader being done, not a failure, and must not end in a stack trace. A terminal
 * that went away (a hang-up, a closed window) fails the write with `EIO`: nobody is there to write to, what
 * a screen that was drawn has made is undone, and the process ends as a hang-up ends it. Any other error
 * is a failure, and is thrown.
 */
export function handleStdoutError(
  err: NodeJS.ErrnoException,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (err.code === 'EPIPE') {
    exit(Number(process.exitCode ?? 0));
    return;
  }
  if (err.code === 'EIO') {
    runInterruptCleanups();
    exit(HANGUP_EXIT_CODE);
    return;
  }
  throw err;
}
