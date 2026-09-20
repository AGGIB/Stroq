import { spawn } from 'node:child_process';

/**
 * Stopping a server Stroq started, on a platform that has no signals.
 *
 * Every other kill in this package was written as `child.kill('SIGTERM')`, which is
 * exactly right on POSIX and does two wrong things on Windows. Node maps any signal
 * there onto `TerminateProcess`, so the graceful rung of a SIGTERM-then-SIGKILL
 * ladder is already a hard kill — noted, not fixable, Windows has nothing gentler to
 * offer a detached console process. The one that matters is reach: `TerminateProcess`
 * ends exactly one process. Almost every MCP server is launched through `npx` or
 * `uvx`, which on Windows resolve to `npx.cmd`/`uvx.exe` shims that run the real
 * `node` or `python` as a child of their own. Killing the shim leaves that server
 * running, holding the environment it was handed, after the client that asked for it
 * has gone — and a probe that timed out precisely because the server was misbehaving
 * is the case where walking away from it is worst.
 *
 * `taskkill /T` is the platform's own answer: it walks the process tree from the pid
 * down. It is spawned rather than linked because there is no Win32 tree-kill in
 * Node's API, and fired without being awaited because every caller here is on a
 * shutdown path that must not block on it.
 */

/** The one shape of `spawn` this module uses; injected so a test never starts one. */
export type KillSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly stdio: 'ignore'; readonly windowsHide: true },
) => { on: (event: 'error', listener: (err: Error) => void) => unknown; unref: () => unknown };

/** The subset of `ChildProcess` this module needs, so callers need not own a real one. */
export interface Killable {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Ends `child` and, on Windows, everything it started. `plat` and `spawnFn` default
 * to the real process; a test overrides them to exercise one platform's rules on the
 * other, the way `childEnv` does.
 *
 * The direct signal is sent on both platforms, Windows included: `taskkill` can be
 * missing from a stripped image or blocked by policy, and a failed tree kill must
 * still leave the shim dead rather than leave everything alive. Sending it as well
 * costs nothing — terminating an already-terminated process is a no-op that Node
 * reports through `ESRCH`, which `kill` swallows.
 */
export function killChildTree(
  child: Killable,
  signal: NodeJS.Signals,
  plat: NodeJS.Platform = process.platform,
  spawnFn: KillSpawn = spawn as unknown as KillSpawn,
): void {
  const pid = child.pid;
  if (plat === 'win32' && pid !== undefined) {
    try {
      const killer = spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // An unhandled `error` on a ChildProcess is an uncaught exception, and a
      // firewall that crashes while shutting down is worse than one that leaks.
      killer.on('error', () => undefined);
      killer.unref();
    } catch {
      // `taskkill` is not on PATH, or spawning is refused outright. The direct
      // signal below is the fallback, and the shim at least does not survive.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process is already gone; there is nothing left to stop.
  }
}
