import { homedir } from 'node:os';
import { agentHookStatus, detectedAgents } from './doctor.js';
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
const isAgentFlag = (arg: string): boolean => arg === '--agent' || arg.startsWith('--agent=');
const command = (id: string): string => `stroq init --agent ${id}`;
const nameOf = (id: string, cwd: string): string => agentHookStatus(id, cwd)?.name ?? id;

export interface InitWhere {
  readonly cwd?: string;
  readonly home?: string;
}

export async function runInitCommand(
  args: readonly string[],
  where: InitWhere = {},
): Promise<number> {
  if (args.some(isAgentFlag)) return runInit(args);
  const cwd = where.cwd ?? process.cwd();
  const found = detectedAgents(cwd, where.home ?? homedir()).filter(isHookAgent);

  if (found.length === 0 || found.includes('claude-code')) {
    const code = await runInit(args);
    if (code === 0)
      noteUnguarded(
        found.filter((id) => id !== 'claude-code'),
        cwd,
      );
    return code;
  }

  const [only, ...others] = found;
  if (only !== undefined && others.length === 0) {
    process.stdout.write(
      `Claude Code was not found here; ${nameOf(only, cwd)} was, so that is the one guarded.\n`,
    );
    return runInit([...args, '--agent', only]);
  }

  process.stdout.write(
    `Found ${found.length} agents here, none of them Claude Code, and nothing was installed:\n` +
      `${found.map((id) => `  ${command(id).padEnd(34)}${nameOf(id, cwd)}`).join('\n')}\n` +
      'Run the one for the agent you want guarded first.\n',
  );
  return 1;
}

/** The agents found on this machine that Stroq is not guarding, with the command for each. */
function noteUnguarded(candidates: readonly string[], cwd: string): void {
  const unguarded = candidates.filter((id) => agentHookStatus(id, cwd)?.installed !== true);
  if (unguarded.length === 0) return;
  process.stdout.write(
    `Also found here, not guarded: ${unguarded.map((id) => nameOf(id, cwd)).join(', ')}\n${unguarded
      .map((id) => `  ${command(id)}\n`)
      .join('')}`,
  );
}
