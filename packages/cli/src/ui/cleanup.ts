// What has to be undone if the process is ended by a signal, which runs no `finally` and no `exit`
// handler: a directory made for a check, a child started for one. A step that spins registers it while
// it runs, and the spinner's signal handler runs what is registered before it raises the signal again.
const pending = new Set<() => void>();

/** Registers `undo` to run if the process is interrupted; returns what takes it back out. */
export function onInterrupt(undo: () => void): () => void {
  pending.add(undo);
  return () => {
    pending.delete(undo);
  };
}

/**
 * Runs what is registered, each once, the last one first (what was started last is ended before what
 * it was started in: a hook is killed before the directory it writes into is removed), and never
 * throws: it runs while the process is going.
 */
export function runInterruptCleanups(): void {
  for (const undo of [...pending].reverse()) {
    pending.delete(undo);
    try {
      undo();
    } catch {
      // The process is ending; there is nobody to tell.
    }
  }
}

/** What a process that a hang-up ended exits with (128 and the signal's number). */
export const HANGUP_EXIT_CODE = 129;

/** What a process that Ctrl-\ ended exits with (128 and the signal's number), where it is not killed by it. */
export const QUIT_EXIT_CODE = 131;

/**
 * Answers Ctrl-\ for as long as it is wanted: what is registered is undone, and the process exits with
 * the code a shell shows for it. Left to itself, SIGQUIT is a core dump, which macOS holds an unkillable
 * process for while its crash reporter looks at it. Returns what takes the answer away. Not on Windows,
 * which has no such signal.
 */
export function exitOnQuit(): () => void {
  if (process.platform === 'win32') return () => undefined;
  const leave = (): void => {
    runInterruptCleanups();
    process.exit(QUIT_EXIT_CODE);
  };
  process.on('SIGQUIT', leave);
  return () => {
    process.removeListener('SIGQUIT', leave);
  };
}
