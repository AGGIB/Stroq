// What Claude Code is started with for one request of the live check. Pure: no process is started here.
//
// Every word was measured on a real host (2026-10-12), and the ones that look arbitrary are not:
//
// - `acceptEdits`, not `dontAsk`. Under `dontAsk` the host's own rules block `echo x > file` (a redirect
//   needs a write permission) and nothing is proven. Under `acceptEdits` the commands of the probes that
//   `--allowedTools` names run unasked, and anything else is stopped by the host's own permission step,
//   which is what the control is there to tell. Measured on 2.1.271: the control of the deny probe, a
//   `git config --file ...`, is stopped by that step ("This command requires approval") unless
//   `Bash(git config:*)` is among the allowed tools, and then it runs.
// - `--setting-sources project` and an inline `--settings`: the only hook is the one this check hands over.
//   The user's own settings file is not read, and the check does not say it is.
// - `--allowedTools` is variadic: it takes every word after it, so it is last.
// - Not `--bare`, `--safe-mode` or `--dangerously-skip-permissions`: each changes what the host does with a
//   hook or with its own permission step, which is the thing being looked at.
//
// The real run and the control are started with IDENTICAL words but for the command of the hook (and the
// session and the prompt, which carry the nonce of each request): `test/live/driver-contract.ts` holds that.
import { promptFor, shellWord } from '../probes.js';
import type { Probe, ProbeContext } from '../types.js';

/** The model, by the alias the host resolves: the cheapest one, since the probes ask for one command. */
export const CLAUDE_MODEL = 'haiku';

export const CLAUDE_PERMISSION_MODE = 'acceptEdits';

/** What may run unasked: the commands of the three probes (`echo`, `git config`, `curl`), and nothing else. */
export const CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  'Bash(echo:*)',
  'Bash(git config:*)',
  'Bash(curl:*)',
];

/**
 * The hook of a control run. It exits 0 and prints nothing, so the host goes on as if no hook were there; it
 * never says "allow", which in some hosts skips their own permission step. No quote in it, so that it is the
 * same word for any shell.
 */
export const NOOP_HOOK_LINE = 'node -e 0';

/**
 * The command the host runs as its hook. For a real run it is the line `stroq init` writes, run with the
 * throwaway home and Stroq home, so that it reads the policy of the check and writes its audit log to the
 * check's own directory and not to the user's. The host keeps the real HOME, because its login lives there.
 */
export function hookCommandFor(
  ctx: Pick<ProbeContext, 'home' | 'stroqHome' | 'hookMode'>,
  hookLine: string,
): string {
  if (ctx.hookMode === 'noop') return NOOP_HOOK_LINE;
  const home = shellWord(ctx.home);
  return `env HOME=${home} USERPROFILE=${home} STROQ_HOME=${shellWord(ctx.stroqHome)} ${hookLine}`;
}

/** The inline settings: one hook, for every tool call, before it is made. */
export function claudeSettings(command: string): string {
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
  });
}

/** The arguments of `claude` for one request (not the program). */
export function claudeArgv(probe: Probe, ctx: ProbeContext, hookLine: string): string[] {
  return [
    '-p',
    promptFor(probe),
    '--model',
    CLAUDE_MODEL,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--session-id',
    ctx.sessionId,
    '--setting-sources',
    'project',
    '--settings',
    claudeSettings(hookCommandFor(ctx, hookLine)),
    '--strict-mcp-config',
    '--tools',
    'Bash',
    '--permission-mode',
    CLAUDE_PERMISSION_MODE,
    '--allowedTools',
    ...CLAUDE_ALLOWED_TOOLS,
  ];
}
