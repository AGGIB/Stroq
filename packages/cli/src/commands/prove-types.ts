// What `stroq prove` is handed, so that a test can say what the world is (a host, a terminal, a signal)
// without owning one. Every field has a real default in `prove.ts`.
import type { HostDriver } from '../live/types.js';
import type { IdSource } from '../live/verify-types.js';
import type { Terminal } from '../ui/terminal.js';

/** Where signals arrive. The real one is `process`; a test supplies its own. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ProveDeps {
  /** Where the report goes. By default standard output. */
  readonly out?: (text: string) => void;
  /** Where the notice of a JSON run, the progress and the errors go. By default standard error. */
  readonly err?: (text: string) => void;
  /** The terminal a question is asked on. By default this process's own. */
  readonly terminal?: Terminal;
  /** The environment: the owner's ledger is looked for in it, and the host is started with it. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** The command the host runs as its hook. By default the line `stroq init` writes for this Stroq. */
  readonly hookLine?: string;
  /**
   * The driver of the host, given the hook line and the signal that is aborted if the check is interrupted.
   * By default the one for the agent (`live/drivers`). Null: there is none.
   */
  readonly makeDriver?: (hookLine: string, signal: AbortSignal) => HostDriver | null;
  readonly signals?: SignalSource;
  /** Ends the process as the signal would have, once the check has cleaned up. */
  readonly reraise?: (signal: NodeJS.Signals) => void;
  readonly now?: () => Date;
  readonly ids?: Partial<IdSource>;
}

/** The writers of a run, with the default and the safe form of each. */
export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}
