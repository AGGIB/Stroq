import { win32 } from 'node:path';

/**
 * Which agent a program on the command line is, so `stroq run` can check that
 * Stroq's hooks are installed for it.
 *
 * The launcher is handed a command, not an agent id, and the two are not the same
 * word: Cursor's CLI is `cursor-agent`, and Stroq's own id for it is `cursor`. The
 * mapping is a short table rather than an inference, because every wrong answer here
 * is the same wrong answer — a launch that reports the wrong agent's hook state — and
 * no answer at all is strictly better than a guess: `stroq run` says it checked
 * nothing and carries on.
 *
 * The ids on the right are exactly the ones `stroq doctor` and `stroq init --agent`
 * use, and a test asserts that every one of them is an agent `doctor` knows.
 */
export const LAUNCH_COMMANDS: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  'cursor-agent': 'cursor',
  codex: 'codex',
  copilot: 'copilot',
  openclaw: 'openclaw',
  windsurf: 'windsurf',
  antigravity: 'antigravity',
};

/**
 * The agent's own state directory under the user's home, which `--sandbox` has to
 * leave writable: an agent that cannot write its history, its session files or its
 * own configuration does not start.
 *
 * Deliberately NOT `doctor`'s `AGENT_DIRS`, which these resemble. That table answers
 * "is this agent used on this machine", and it is narrowed for exactly that purpose
 * — Antigravity's entry there is `.gemini/antigravity-cli`, because a bare `.gemini`
 * is also the Gemini CLI's. Narrowing a DETECTION heuristic makes it quieter;
 * narrowing a write grant breaks the agent. Two purposes, two tables, and a comment
 * on each saying which is which.
 */
export const AGENT_STATE_DIRS: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['.claude'],
  cursor: ['.cursor'],
  codex: ['.codex'],
  copilot: ['.copilot'],
  openclaw: ['.openclaw'],
  windsurf: ['.codeium'],
  antigravity: ['.gemini'],
};

/**
 * Agents that ship a sandbox of their own, so `--sandbox` adds a second boundary
 * around one that is already there rather than the first one. Said out loud in the
 * launcher's output, because implying blanket protection across all seven agents
 * would be the wrong claim — the sandbox's value is concentrated on the other five.
 */
export const OWN_SANDBOX_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'antigravity']);

/**
 * Windows shim suffixes. An npm-installed CLI is `claude.cmd` there, and the loader
 * treats the suffix as part of how the program is found rather than as part of its
 * name — so it is stripped on Windows and, deliberately, nowhere else: on POSIX a
 * file called `claude.cmd` is a different file from `claude`, and quietly treating
 * one as the other is how a launcher ends up reporting on a program it did not start.
 */
const WINDOWS_SUFFIX = /\.(com|exe|bat|cmd|ps1)$/;

/**
 * The Stroq agent id for a command, or `null` when the command is not one of the
 * supported agents. `plat` defaults to the real platform; a test overrides it.
 *
 * Windows path separators and case-folding apply on Windows only, which is where the
 * filesystem itself behaves that way. `win32.basename` reads both separators, so a
 * path written with either is handled there; on POSIX a backslash is an ordinary
 * character in a filename and is left alone.
 */
export function agentIdFor(
  command: string,
  plat: NodeJS.Platform = process.platform,
): string | null {
  if (command === '') return null;
  if (plat !== 'win32') {
    const base = command.slice(command.lastIndexOf('/') + 1);
    return LAUNCH_COMMANDS[base] ?? null;
  }
  const base = win32.basename(command).toLowerCase().replace(WINDOWS_SUFFIX, '');
  return LAUNCH_COMMANDS[base] ?? null;
}
