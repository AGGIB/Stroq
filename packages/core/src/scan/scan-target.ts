import type { ScanTarget } from '../rules/atr-types.js';

export const SCANNED_TOOLS = /^(Read|WebFetch|WebSearch|Bash|PowerShell|Grep|mcp__)/;

/**
 * Names of files whose *content* is instructions to the agent rather than repository
 * material, so a `Read` of one is an `instruction_file` and not `repo_content`. The
 * distinction matters because a rule scoped to instruction files would otherwise go
 * dark exactly where those files are read at run time — the tool name alone cannot
 * tell `CLAUDE.md` from `README.md`, but the path can.
 *
 * Kept deliberately narrow (the well-known agent instruction files, plus anything under
 * a `.claude`/`.cursor`/`.codex`/`.windsurf` directory, plus `SKILL.md`): a file this
 * does not recognise is read as `repo_content`, which is the wider surface for the
 * rules that matter there and therefore the safe way to be wrong.
 */
const INSTRUCTION_READ_PATH =
  /(?:^|[/\\])(?:CLAUDE(?:\.local)?|AGENTS(?:\.override)?|GEMINI|SKILL|copilot-instructions)\.md$|(?:^|[/\\])\.(?:cursorrules|windsurfrules)$|(?:^|[/\\])\.(?:claude|cursor|codex|windsurf)[/\\]|(?:^|[/\\])\.github[/\\]instructions[/\\]/i;

/**
 * The surface a tool's output arrives on, or `'any'` when the tool name says nothing
 * about it — under which every rule fires, exactly as before surfaces existed.
 * A wrong narrow answer here is a hole, so each case below is one the tool name
 * settles, with one named exception:
 *
 * - `tools/list` through the MCP proxy returns the servers' tool *descriptions*, which
 *   is where tool poisoning lives; every other `mcp__` call returns `tool_result` —
 *   including `resources/read` and `prompts/get`, minted as
 *   `mcp__<srv>__resources_read` and `mcp__<srv>__prompts_get` by `MCP_METHOD_TOOL` in
 *   `packages/cli/src/mcp/judge.ts`. Those two are not actually settled by the tool
 *   name: a prompt template is text the agent is meant to obey, which by this
 *   codebase's own definition is `instruction_file`, and a resource read is closer to
 *   `repo_content` than to a tool call's own result. They share `tool_result` today as
 *   a placeholder, which costs nothing measurable because nothing is scoped to
 *   `instruction_file` or `repo_content` in a way that a stray `mcp__` result could
 *   wrongly feed — but the day a rule category such as `skill-compromise` is scoped
 *   away from `any`, these two need their own branch here rather than continuing to
 *   share `tool_result` with `tools/call`.
 * - `Bash` and Claude Code's `PowerShell` return a command's output.
 * - `Read` returns a file, classified by path (see `INSTRUCTION_READ_PATH`); `Grep` returns
 *   repository lines.
 * - `WebFetch`/`WebSearch` return fetched documents — prose, like repository docs, and
 *   the surface the published false-positive rate is measured on.
 */
export function scanTargetForTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>> = {},
): ScanTarget {
  if (toolName.startsWith('mcp__')) {
    return toolName.endsWith('__tools_list') ? 'tool_description' : 'tool_result';
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'command_output';
  if (toolName === 'Read') {
    const path = toolInput.file_path ?? toolInput.notebook_path;
    return typeof path === 'string' && INSTRUCTION_READ_PATH.test(path)
      ? 'instruction_file'
      : 'repo_content';
  }
  if (toolName === 'Grep' || toolName === 'WebFetch' || toolName === 'WebSearch') {
    return 'repo_content';
  }
  return 'any';
}

/**
 * The fields of the rule format that the result of a tool fills in, beside `content`. The text of
 * what an MCP server returns, or a web fetch or search, is a tool's response, and the text of
 * `tools/list` is what a server says its tools are: about three hundred rules read those fields and
 * matched nothing while nobody supplied them (see `supplied-fields.ts`). A local result (a file, a
 * listing, a command's output) fills neither: those rules were written for what another party
 * answers, and on one's own work they fire as often as the rules on `content` do.
 *
 * A field that is the scanned text is read in each form the scanner makes of it.
 */
export function scanFieldsForTool(
  toolName: string,
  text: string,
): Readonly<Record<string, string>> {
  if (toolName.startsWith('mcp__')) {
    return toolName.endsWith('__tools_list') ? { tool_description: text } : { tool_response: text };
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return { tool_response: text };
  return {};
}
