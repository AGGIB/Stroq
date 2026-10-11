/**
 * The tools that run a shell command taken from their `command` field: Claude Code's
 * `Bash`, `PowerShell`, and `Monitor`, whose script "runs in the same shell environment
 * as Bash" and streams its output back as notifications.
 *
 * Four places decide whether a tool carries a command: the classifier (what the command
 * does), the secret guard (the text it looks for a known value in), the decoy-file check
 * (the words that name a path) and the provenance atoms (what was copied from earlier
 * output). Each kept a list of its own and the lists drifted twice, once to `Bash` alone:
 * a command typed into `PowerShell` or `Monitor` was judged by the classifier and then
 * not read at all by the other three. They all read this one, and
 * `test/actions/shell-tools.test.ts` holds each of them to it.
 *
 * A leaf module on purpose, so that `secrets/` and `provenance/` can import it without
 * pulling the classifier in behind it.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor']);

/** Whether `toolName` runs the command in its `command` field. Exact: `bash` and `Shell` are not it. */
export const isShellTool = (toolName: string): boolean => SHELL_TOOLS.has(toolName);
