// What the arguments of `stroq init` say about the first-run screen. Kept apart from the screen
// itself (`init-interactive.ts`, `init-flow.ts`) so that deciding whether to draw it reads none of it.
import { parseArgs } from 'node:util';
import { HOOK_AGENTS, INIT_OPTIONS } from './init.js';

/** The flags of the screen, which the installer is not given. */
export const FLOW_FLAGS: ReadonlySet<string> = new Set(['--yes', '--no-input']);

export const isAgentFlag = (arg: string): boolean =>
  arg === '--agent' || arg.startsWith('--agent=');

/**
 * The agent an explicit `--agent` names, or null. The last one named is the one the installer reads
 * (`--agent mcp --agent cursor` is Cursor), and `--agent` with nothing after it names nothing, which
 * is not the same as no `--agent`.
 */
export function explicitAgent(args: readonly string[]): string | null {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i] as string;
    if (arg === '--agent') return args[i + 1] ?? '';
    if (arg.startsWith('--agent=')) return arg.slice('--agent='.length);
  }
  return null;
}

/** The arguments the installer takes: all of them but the screen's flags and the agent, which is passed on its own. */
export function installerArgs(args: readonly string[]): string[] {
  return args.filter((arg, i) => {
    if (FLOW_FLAGS.has(arg) || isAgentFlag(arg)) return false;
    return !(i > 0 && args[i - 1] === '--agent');
  });
}

/** Whether the installer would take these arguments: what it would refuse is for it to say, before a question. */
function installerTakes(args: readonly string[]): boolean {
  try {
    parseArgs({ args: [...args], options: INIT_OPTIONS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether these arguments are a first run that may be drawn: not a preview, not told not to ask, not
 * for the MCP proxy (whose config is not a hook an agent calls), and arguments the installer takes.
 */
export function mayDraw(args: readonly string[]): boolean {
  if (args.includes('--dry-run') || args.includes('--no-input')) return false;
  // What follows `--` is not an option: the `--agent` that the screen adds would be one more word.
  if (args.includes('--') || !installerTakes(args)) return false;
  const agent = explicitAgent(args);
  return agent === null || (HOOK_AGENTS as readonly string[]).includes(agent);
}
