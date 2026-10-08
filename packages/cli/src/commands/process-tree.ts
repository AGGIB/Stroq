import type { ChildProcess } from 'node:child_process';

/**
 * Ends a process and everything it started: its process group where it has one (a child that was
 * started `detached` is the leader of one), the process where not. `SIGKILL` for a process that
 * does not answer, `SIGTERM` where it is to be let finish what it is writing.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}
