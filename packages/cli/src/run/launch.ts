import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { killChildTree, type KillSpawn, type Killable } from '../mcp/kill-child.js';

/**
 * Starting the agent, and getting out of its way.
 *
 * A launcher is only worth using if it is invisible once the agent is up. Three
 * things make it so, and each of them is a way this could be worse than not
 * existing at all:
 *
 * - **The terminal.** `stdio: 'inherit'` hands the agent Stroq's own descriptors, so
 *   a full-screen TUI gets the real tty, its size, and its resize events. Piping
 *   them would put a Node process between the agent and the terminal for no reason.
 * - **Signals.** Registering a handler for SIGINT and SIGTERM stops Node's default
 *   action, which is to terminate — so Ctrl-C no longer kills the launcher out from
 *   under a child that is still shutting down. The signal is relayed and then this
 *   process waits for the agent's own answer. (On a tty the agent is in the same
 *   process group and receives Ctrl-C directly too; the relay is what covers a
 *   `kill` sent to the launcher, and delivering a second copy of a signal a process
 *   already has is a no-op.)
 * - **The exit code.** Whatever the agent exited with is what this returns. A death
 *   by signal becomes `128 + signal`, the convention every shell and CI runner
 *   reads, so an agent stopped with Ctrl-C does not come back looking like an agent
 *   that finished cleanly.
 */

/** The subset of `ChildProcess` this module uses. */
export interface LaunchChild extends Killable {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/** The one shape of `spawn` this module uses; injected so a test starts nothing. */
export type LaunchSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: 'inherit' },
) => LaunchChild;

/** Where signals arrive. The real one is `process`; a test supplies its own. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** The signals a launcher relays. Everything else is left to its default action. */
const RELAYED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A program that is not there. The shell's code for it, and the one CI expects. */
const NOT_FOUND = 127;

/**
 * The exit code for a child that closed with `code`/`signal`.
 *
 * Windows has no signals: Node maps every one of them onto `TerminateProcess` and
 * reports the request back as `SIGTERM`, so `128 + 15` there would be a number
 * describing something that did not happen. A plain failure is the honest answer.
 */
export function exitCodeFor(
  code: number | null,
  signal: NodeJS.Signals | null,
  plat: NodeJS.Platform,
): number {
  if (signal === null) return code ?? 1;
  if (plat === 'win32') return 1;
  const number = (constants.signals as Record<string, number | undefined>)[signal];
  return number === undefined ? 1 : 128 + number;
}

export interface LaunchOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** The full environment for the child, hardening included; not merged with anything here. */
  readonly env: NodeJS.ProcessEnv;
  readonly plat?: NodeJS.Platform;
  readonly spawnFn?: LaunchSpawn;
  readonly signals?: SignalSource;
  readonly stderr?: { write(text: string): unknown };
  /** How the child is stopped; defaults to the tree kill the MCP proxy uses. */
  readonly kill?: (child: Killable, signal: NodeJS.Signals) => void;
  /** Passed through to `killChildTree` so a test can see the Windows tree kill. */
  readonly killSpawn?: KillSpawn;
}

export async function launch(options: LaunchOptions): Promise<number> {
  const plat = options.plat ?? process.platform;
  const spawnFn = options.spawnFn ?? (spawn as unknown as LaunchSpawn);
  const signals = options.signals ?? process;
  const stderr = options.stderr ?? process.stderr;
  const kill =
    options.kill ??
    ((child: Killable, signal: NodeJS.Signals) =>
      options.killSpawn === undefined
        ? killChildTree(child, signal, plat)
        : killChildTree(child, signal, plat, options.killSpawn));

  const child = spawnFn(options.command, options.args, {
    env: options.env,
    stdio: 'inherit',
  });

  const relays = RELAYED.map((signal) => ({ signal, listener: () => kill(child, signal) }));
  for (const { signal, listener } of relays) signals.on(signal, listener);

  try {
    return await new Promise<number>((resolve) => {
      child.on('error', (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        stderr.write(
          code === 'ENOENT'
            ? `stroq run: cannot start "${options.command}": no such program on PATH\n`
            : `stroq run: cannot start "${options.command}": ${err.message}\n`,
        );
        resolve(code === 'ENOENT' ? NOT_FOUND : 1);
      });
      // `close` rather than `exit`: by then the child's inherited descriptors are
      // released, so nothing it wrote last is still in flight when this returns.
      child.on('close', (code, signal) => resolve(exitCodeFor(code, signal, plat)));
    });
  } finally {
    // Leaving a relay registered would keep this process reachable by signals it no
    // longer has anything to do with, and hold a reference to a child that is gone.
    for (const { signal, listener } of relays) signals.off(signal, listener);
  }
}
