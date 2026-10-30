import { classifyTool } from '../actions/classify-tool.js';
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
export const INSTRUCTION_READ_PATH =
  /(?:^|[/\\])(?:CLAUDE(?:\.local)?|AGENTS(?:\.override)?|GEMINI|QWEN|CRUSH|CONVENTIONS|SKILL|copilot-instructions)\.md$|(?:^|[/\\])\.(?:cursorrules|windsurfrules|clinerules)$|(?:^|[/\\])\.(?:claude|cursor|codex|windsurf|clinerules|roo|kiro|junie|kilocode|continue)[/\\]|(?:^|[/\\])\.github[/\\]instructions[/\\]/i;

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
 * - `WebFetch`/`WebSearch` return fetched documents: `web_content`, written by somebody else
 *   like an MCP result, and the surface the published false-positive rate is measured on. Kept
 *   apart from `repo_content` so a rule written for attacker text (a poisoned tool description,
 *   a template-injection payload) can read the web without reading the developer's own code.
 */
export function scanTargetForTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>> = {},
  cwd = '/',
): ScanTarget {
  if (toolName.startsWith('mcp__')) {
    return toolName.endsWith('__tools_list') ? 'tool_description' : 'tool_result';
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return printsTextOfOthers(toolName, toolInput, cwd) ? 'web_content' : 'command_output';
  }
  if (toolName === 'Read') {
    const path = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof path === 'string' && DEPENDENCY_DIR.test(path)) return 'web_content';
    return typeof path === 'string' && INSTRUCTION_READ_PATH.test(withinWorktree(path))
      ? 'instruction_file'
      : 'repo_content';
  }
  if (toolName === 'Grep') {
    const path = toolInput.path;
    return typeof path === 'string' && DEPENDENCY_DIR.test(path) ? 'web_content' : 'repo_content';
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'web_content';
  return 'any';
}

/** Where an agent keeps a working copy of the project: `.claude/worktrees/<name>/`, `~/.codex/worktrees/<id>/`. */
const WORKTREE_MARKERS = ['/.claude/worktrees/', '/.codex/worktrees/'];

/**
 * A path in a working copy an agent keeps of the project, as it is from the root of that copy: the
 * files there are the project's, and the `.claude` on the way to them made each an instruction file.
 * The path as it is when it is in none. Read with `indexOf`, not a pattern: the path is the agent's.
 */
export function withinWorktree(path: string): string {
  const unified = `/${path.replace(/\\/g, '/')}`;
  let end = -1;
  for (const marker of WORKTREE_MARKERS) {
    const at = unified.lastIndexOf(marker);
    if (at !== -1 && at + marker.length > end) end = at + marker.length;
  }
  if (end === -1) return path;
  const slash = unified.indexOf('/', end);
  return slash === -1 ? path : unified.slice(slash + 1);
}

/**
 * A folder of dependencies: their files were written by a package's author, not the developer,
 * and a package README addressed to agents is a known way in, so they are read as web content.
 */
const DEPENDENCY_DIRS =
  '(?:node_modules|site-packages|dist-packages|bower_components|jspm_packages|vendor|third_party|third-party|Pods|Carthage|\\.venv|venv|\\.tox|\\.nox|\\.cargo[\\\\/]registry|pkg[\\\\/]mod)';
export const DEPENDENCY_DIR = new RegExp(`(?:^|[\\\\/])${DEPENDENCY_DIRS}(?:[\\\\/]|$)`);
/** The same folders named in a command line, where a space, a quote or `=` comes before them too. */
export const DEPENDENCY_DIR_WORD = new RegExp(
  `(?:^|[\\s'"=:\\\\/])${DEPENDENCY_DIRS}(?:[\\\\/\\s'"]|$)`,
);

/** A program that prints a page from the network, as a word of a command (by path, or quoted). */
const FETCH_WORD =
  /(?:^|[\s;&|(`'"])(?:[\w.~-]*\/)?(?:curl|wget|https?|lynx|w3m|elinks|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)(?=[\s'"])/i;
/** A `gh` command that prints what other people wrote: issues, pull requests, comments, the API. */
const GH_READ =
  /(?:^|[\s;&|(`'"])(?:[\w.~-]*\/)?gh['"]?\s+(?:issue|pr|api|release|search|repo|gist|run)(?=[\s'"])/i;
/**
 * What the action classifier says about a command whose output is text somebody else wrote: it
 * reached the network, or it could not be read at all (a variable command word, a program built
 * at run time), so where its output came from is unknown.
 */
const OTHERS_TEXT: ReadonlySet<string> = new Set([
  'shell.network',
  'network.fetch',
  'shell.unparsed',
]);

/**
 * Whether a command's output is text somebody else wrote (a fetched page, an issue): it is then
 * read as `web_content`, like WebFetch's result, and the rules written for attacker text read it.
 * The words above catch the plain spellings; the action classifier, which reads paths, quotes,
 * wrappers and the programs an interpreter is given, decides the rest. A false yes only reads a
 * local output more strictly, so every doubt (a classifier that throws included) answers yes.
 */
function printsTextOfOthers(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): boolean {
  const command = toolInput.command;
  if (typeof command !== 'string') return false;
  if (FETCH_WORD.test(command) || GH_READ.test(command)) return true;
  try {
    return classifyTool(toolName, toolInput, cwd).classes.some((c) => OTHERS_TEXT.has(c));
  } catch {
    return true;
  }
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
  target?: ScanTarget,
): Readonly<Record<string, string>> {
  // A command that fetched a page printed what WebFetch would have returned: the rules written for
  // a tool's response read it too.
  if (target === 'web_content' && (toolName === 'Bash' || toolName === 'PowerShell'))
    return { tool_response: text };
  if (toolName.startsWith('mcp__')) {
    return toolName.endsWith('__tools_list') ? { tool_description: text } : { tool_response: text };
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return { tool_response: text };
  return {};
}
