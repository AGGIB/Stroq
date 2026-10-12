import { homedir } from 'node:os';
import { stroqHome } from '../paths.js';
import type { Fs, HardenEnv } from '../harden/types.js';
import type { Terminal } from '../ui/terminal.js';
import { stroqVersion } from '../version.js';

/**
 * What `stroq harden` needs from the machine, named so that a test can say what the machine is: the
 * folder it runs in, the user's home, the Stroq home, the clock, the version, and the terminal a person
 * answers on. In use none is given and the process's own are taken; in a test all are given, and the real
 * home, the real Stroq home and the real terminal are never touched.
 */
export interface HardenDeps {
  readonly cwd?: string;
  /** The user's home directory (where `~/.claude/settings.json` is), not the Stroq home. */
  readonly home?: string;
  readonly stroqHome?: string;
  readonly now?: () => Date;
  readonly version?: string;
  /** `CLAUDE_CONFIG_DIR`; without one, the process's own environment says. */
  readonly claudeConfigDir?: string;
  /** The file system the engine writes with; a test makes one of its calls fail or interfere. */
  readonly fs?: Fs;
  /** A terminal for the question; without one the process's own is used when a person is at it. */
  readonly terminal?: Terminal;
}

export interface HardenContext {
  readonly cwd: string;
  readonly home: string;
  /** Where Claude Code is told to keep its configuration, when it is told. */
  readonly claudeConfigDir: string | undefined;
  /** What the engine is given: the Stroq home, the clock and the version it records. */
  readonly env: HardenEnv;
  /** The terminal a person can answer on, or `null` when none can (a pipe, a script, CI). */
  askable(): Promise<Terminal | null>;
}

/**
 * The terminal to ask on, or `null`. A person has to be there: standard input and output are terminals,
 * it is not `TERM=dumb` and this is not CI (`Terminal.interactive`). The terminal code is loaded only
 * when asked for, so that a plan, which never asks, does not read it.
 */
async function processTerminal(): Promise<Terminal | null> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return null;
  const { currentTerminal } = await import('../ui/terminal.js');
  const terminal = currentTerminal();
  return terminal.interactive ? terminal : null;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

export function contextOf(deps: HardenDeps): HardenContext {
  return {
    cwd: deps.cwd ?? process.cwd(),
    home: deps.home ?? homedir(),
    // An empty variable is not a folder.
    claudeConfigDir: nonEmpty(deps.claudeConfigDir ?? process.env['CLAUDE_CONFIG_DIR']),
    env: {
      home: deps.stroqHome ?? stroqHome(),
      now: deps.now ?? (() => new Date()),
      version: deps.version ?? stroqVersion(),
      ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    },
    askable: async () =>
      deps.terminal === undefined
        ? processTerminal()
        : deps.terminal.interactive
          ? deps.terminal
          : null,
  };
}
