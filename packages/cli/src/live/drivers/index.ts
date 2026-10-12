// Which driver drives which host.
import type { HostDriver } from '../types.js';
import { createClaudeDriver } from './claude.js';

/** The variable that names the `claude` program to drive, when it is not the one on the PATH. */
export const CLAUDE_BIN_ENV = 'STROQ_CLAUDE_BIN';

export interface DriverOptions {
  /** The command `stroq init` writes for the agent: what the host runs as its hook. */
  readonly hookLine: string;
  /** Where `STROQ_CLAUDE_BIN` is looked for. By default the environment of the process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Aborted when the check is interrupted: the host is killed. */
  readonly signal?: AbortSignal;
}

/** The ids of the agents there is a driver for. */
export const DRIVEN_AGENTS: readonly string[] = ['claude-code'];

/** The driver for an agent, or null when there is none (yet). */
export function driverFor(agent: string, options: DriverOptions): HostDriver | null {
  if (agent !== 'claude-code') return null;
  const env = options.env ?? process.env;
  const bin = env[CLAUDE_BIN_ENV];
  return createClaudeDriver({
    hookLine: options.hookLine,
    ...(bin === undefined || bin === '' ? {} : { bin }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env,
  });
}
