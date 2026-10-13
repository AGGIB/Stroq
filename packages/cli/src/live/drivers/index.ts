// Which driver drives which host.
import type { HostDriver } from '../types.js';
import { DRIVEN_AGENTS } from './agents.js';
import { createClaudeDriver } from './claude.js';
import { createCodexDriver } from './codex.js';

/** The variable that names the `claude` program to drive, when it is not the one on the PATH. */
export const CLAUDE_BIN_ENV = 'STROQ_CLAUDE_BIN';
export const CODEX_BIN_ENV = 'STROQ_CODEX_BIN';

export interface DriverOptions {
  /** The command `stroq init` writes for the agent: what the host runs as its hook. */
  readonly hookLine: string;
  /** Where `STROQ_CLAUDE_BIN` is looked for. By default the environment of the process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Aborted when the check is interrupted: the host is killed. */
  readonly signal?: AbortSignal;
}

export { DRIVEN_AGENTS };

/** The driver for an agent, or null when there is none (yet). */
export function driverFor(agent: string, options: DriverOptions): HostDriver | null {
  // One case for each of DRIVEN_AGENTS (`driver-for.test.ts` holds the two to each other).
  if (agent !== 'claude-code' && agent !== 'codex') return null;
  const env = options.env ?? process.env;
  const bin = env[agent === 'codex' ? CODEX_BIN_ENV : CLAUDE_BIN_ENV];
  const create = agent === 'codex' ? createCodexDriver : createClaudeDriver;
  return create({
    hookLine: options.hookLine,
    ...(bin === undefined || bin === '' ? {} : { bin }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    env,
  });
}
