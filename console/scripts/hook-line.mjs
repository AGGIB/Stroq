// The hook line `stroq init` writes for an agent, as the console writes and compares it. It is
// `hookCommand` in packages/cli/src/commands/hook-command.ts, which the console's scripts cannot import
// as they run; `console/lib/hook-line.test.ts` holds the two to each other.

/** What follows Claude Code's line: a Stroq that cannot run exits 2, which Claude Code reads as a block. */
export const CLAUDE_CODE_FAIL_CLOSED =
  " || { echo 'Stroq could not run, so this call is blocked. In a terminal: stroq doctor' >&2; exit 2; }";

/** The line for `agent`, with the node binary and the CLI's entry file. */
export const hookLine = (node, cli, agent) =>
  `"${node}" "${cli}" hook ${agent}${agent === 'claude-code' ? CLAUDE_CODE_FAIL_CLOSED : ''}`;
