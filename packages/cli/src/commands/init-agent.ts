import { homedir } from 'node:os';
import type { Terminal } from '../ui/terminal.js';
import { agentHookStatus, detectedAgents } from './doctor.js';
import { isAgentFlag, mayDraw } from './init-args.js';
import { HOOK_AGENTS, runInit } from './init.js';

/**
 * `stroq init` with no `--agent`: the command the front page and the site tell a newcomer
 * to run. It installed Claude Code's hooks whatever was on the machine, so someone with
 * only Cursor got a settings file no agent of theirs reads, and `stroq doctor` then
 * read green because at least one agent was "guarded".
 *
 * Kept out of `init.ts`, which `doctor.ts` imports: this needs `doctor`'s detection, and
 * a module that imports it from the file it is imported by is a load-order bug waiting
 * for the first constant that is read at import time.
 *
 * - Claude Code found, or nothing found: Claude Code, exactly as before.
 * - One other agent found: that one, and it says so.
 * - Several others found: nothing is installed, because guessing which of several
 *   agents' config to change is worse than asking. The exact commands are printed.
 *
 * Whichever agent was installed, the ones found and not yet guarded are named with the
 * command for each: a machine with three agents and one guard should not look done.
 */
const isHookAgent = (id: string): boolean => (HOOK_AGENTS as readonly string[]).includes(id);
const command = (id: string, user: boolean): string =>
  `stroq init --agent ${id}${user ? ' --user' : ''}`;
const nameOf = (id: string, cwd: string): string => agentHookStatus(id, cwd)?.name ?? id;

export interface InitWhere {
  readonly cwd?: string;
  readonly home?: string;
  /** A terminal to draw on, for a test. Without one, the process's own is used when a person is at it. */
  readonly terminal?: Terminal;
}

/**
 * The terminal to draw the first-run screen on, or null where none is wanted: a person has to be
 * there (both streams are terminals, not CI, not `TERM=dumb`), and the arguments must be a first
 * run (not a preview, not told `--no-input`, not the MCP proxy). The screen's code is loaded only
 * then, so that nothing of it is read by the hook process, which starts for every tool call.
 */
async function screenFor(args: readonly string[], where: InitWhere): Promise<Terminal | null> {
  if (!mayDraw(args)) return null;
  if (where.terminal !== undefined) return where.terminal.interactive ? where.terminal : null;
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return null;
  const { currentTerminal } = await import('../ui/terminal.js');
  const term = currentTerminal();
  return term.interactive ? term : null;
}

export async function runInitCommand(
  args: readonly string[],
  where: InitWhere = {},
): Promise<number> {
  const cwd = where.cwd ?? process.cwd();
  const screen = await screenFor(args, where);
  if (screen !== null) {
    const { runInteractiveInit } = await import('./init-interactive.js');
    return runInteractiveInit(args, screen, { cwd, home: where.home ?? homedir() });
  }
  if (args.some(isAgentFlag)) return runInit(args);
  // The advice below is a command to run, and `--user` is part of what was asked for.
  const user = args.includes('--user');
  // The home directory only: a `.agents` or `.cursor` folder that came with a repository
  // says what its authors use, and would otherwise decide which config gets written.
  const home = where.home ?? homedir();
  // A home that is not set is an empty string, and a path joined to it is the project's own.
  const found = home === '' ? [] : detectedAgents(cwd, home, 'user').filter(isHookAgent);

  if (found.length === 0 || found.includes('claude-code')) {
    const code = await runInit(args);
    if (code === 0)
      noteUnguarded(
        found.filter((id) => id !== 'claude-code'),
        cwd,
        user,
      );
    return code;
  }

  const [only, ...others] = found;
  if (only !== undefined && others.length === 0) {
    note(`Claude Code was not found here; ${nameOf(only, cwd)} was, so that is the one guarded.\n`);
    return runInit([...args, '--agent', only]);
  }

  process.stdout.write(
    `Found ${found.length} agents here, none of them Claude Code, and nothing was installed:\n` +
      `${found.map((id) => `  ${command(id, user).padEnd(34)}${nameOf(id, cwd)}`).join('\n')}\n` +
      'Run the one for the agent you want guarded first.\n',
  );
  return 1;
}

/**
 * Advice goes to stderr: `init --dry-run` prints the config it would write on stdout,
 * and a line of prose in front of it is a file that no longer parses.
 */
const note = (text: string): void => {
  process.stderr.write(text);
};

/** The agents found on this machine that Stroq is not guarding, with the command for each. */
function noteUnguarded(candidates: readonly string[], cwd: string, user: boolean): void {
  const unguarded = candidates.filter((id) => agentHookStatus(id, cwd)?.installed !== true);
  if (unguarded.length === 0) return;
  note(
    `Also found here, not guarded: ${unguarded.map((id) => nameOf(id, cwd)).join(', ')}\n${unguarded
      .map((id) => `  ${command(id, user)}\n`)
      .join('')}`,
  );
}
