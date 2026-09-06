import { toolResultToText } from './claude-code.js';
import { isBashTool } from './codex-input.js';
import { mcpToolName } from './cursor-mcp-name.js';
import { kindToolInput, type ToolKind } from './kind-input.js';
import { isRecord, toolInputRecord } from './tool-input.js';
import { streamResultText } from './tool-result.js';

/**
 * Reading a Copilot CLI hook payload: which tool it names, and where in `toolArgs`
 * the shell command, the patch body or the file path actually is.
 *
 * The command, argv and patch readers are Codex's (`codex-input.ts`) and the
 * kind-to-record reader is `kind-input.ts`'s, shared with the OpenClaw adapter —
 * none of them copies: several agents send a shell command under the same handful of
 * field spellings and an `apply_patch` body in the same format, and a divergence
 * between two readers of one shape is a bypass that reproduces on one agent only.
 * What stays here is what is genuinely Copilot's: its tool names, the keys its file
 * tools have to drop, and where it puts a tool's result text.
 */

/**
 * The server name Stroq attributes an MCP call to. Copilot's hooks report the tool's
 * own name and no server at all — only its permission syntax (`Server(tool)`) knows
 * one — so a synthetic server is the only way to compose a name core's
 * `parseMcpToolName` accepts, and `mcp.call` is what puts the arguments in front of
 * the secret-egress guard.
 */
export const COPILOT_MCP_SERVER = 'copilot';

/** What a native Copilot tool does; the kinds are the shared set every agent maps onto. */
export type CopilotKind = ToolKind;

/**
 * Shell spellings GitHub does NOT document, on top of the two it does (`bash`,
 * `powershell`). `isBashTool` already covers `shell`, `exec_command` and
 * `local_shell` (plus Codex's capitalised `Bash`); the rest are added here. A
 * spelling that misses this set is treated as an MCP tool — `mcp__copilot__sh` —
 * and the whole shell rule set never runs on it, so `curl … | sh` under `shell`
 * would be allowed in an untainted session. Reading a name Stroq does not need
 * costs nothing; missing one is a command nobody classified.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'sh',
  'zsh',
  'run_command',
]);
const isShellTool = (rawTool: string): boolean => SHELL_TOOLS.has(rawTool) || isBashTool(rawTool);
const PATCH_TOOLS: ReadonlySet<string> = new Set(['apply_patch']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create', 'edit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['view']);
const FETCH_TOOL = 'web_fetch';
const EDITOR_TOOL = 'str_replace_editor';
/** The one `str_replace_editor` sub-command that only reads. */
const EDITOR_READ_COMMAND = 'view';

/**
 * Native tools whose Stroq name is fixed and whose arguments need no reshaping.
 * `ask_user` and `task` map to themselves: they classify to nothing, and giving them
 * an MCP name would put a tool that never leaves the session in front of the egress
 * guard as if it did.
 */
const PLAIN_NAMES: ReadonlyMap<string, string> = new Map([
  ['web_search', 'WebSearch'],
  ['grep', 'Grep'],
  ['rg', 'Grep'],
  ['glob', 'Glob'],
  ['ask_user', 'ask_user'],
  ['task', 'task'],
]);

const KIND_NAMES = { shell: 'Bash', patch: 'Write', read: 'Read', fetch: 'WebFetch' } as const;

/**
 * `str_replace_editor` carries its own sub-command (`view`, `create`, `str_replace`,
 * `insert`, `undo_edit`) in a field called `command`. It is NOT a shell command and
 * must never reach the Bash classifier; all it decides here is read versus write, and
 * an absent or unreadable value is treated as a write — the safe direction.
 */
const editorCommand = (args: unknown): string => {
  const value = toolInputRecord(args)['command'];
  return typeof value === 'string' ? value : '';
};

export function copilotToolKind(rawTool: string, args: unknown): CopilotKind {
  if (isShellTool(rawTool)) return 'shell';
  if (PATCH_TOOLS.has(rawTool)) return 'patch';
  if (WRITE_TOOLS.has(rawTool)) return 'write';
  if (READ_TOOLS.has(rawTool)) return 'read';
  if (rawTool === EDITOR_TOOL)
    return editorCommand(args) === EDITOR_READ_COMMAND ? 'read' : 'write';
  if (rawTool === FETCH_TOOL) return 'fetch';
  return PLAIN_NAMES.has(rawTool) ? 'plain' : 'mcp';
}

/**
 * Copilot's native tool list is short and documented, so a name that is not in it is
 * almost certainly an MCP tool — and the mis-guess is safe in one direction only: an
 * unlisted native tool classified as `mcp.call` is merely scanned, while a real MCP
 * call left unclassified is a `.env` value nobody looked at. `Write` and `Edit`
 * classify identically (both are in core's `WRITE_TOOLS`), so the split between
 * `create` and the editors is for the audit's readability, not for the decision.
 */
export function copilotToolName(rawTool: string, args: unknown = undefined): string {
  const kind = copilotToolKind(rawTool, args);
  if (kind === 'write') return rawTool === 'create' ? 'Write' : 'Edit';
  if (kind === 'plain') return PLAIN_NAMES.get(rawTool) ?? rawTool;
  if (kind !== 'mcp') return KIND_NAMES[kind];
  return rawTool.startsWith('mcp__')
    ? mcpToolName('', rawTool)
    : mcpToolName(COPILOT_MCP_SERVER, rawTool);
}

/**
 * Dropped from the record a file tool hands the engine. `path` goes because it has
 * just been rewritten as the `file_path` every rule, summary and audit line reads,
 * and two keys meaning the same thing is how they drift apart; `command` goes because
 * it is `str_replace_editor`'s sub-command, and `summarizeInput` prefers a key of
 * that name — keeping it would label every editor call `str_replace` in `stroq log`
 * instead of naming the file it touched.
 */
const DROPPED_FILE_FIELDS: readonly string[] = ['command', 'path'];

/** The subset of a Copilot event this module reads. */
export interface CopilotToolCall {
  readonly toolName: string;
  readonly toolArgs?: unknown;
}

/**
 * The record the engine sees. The reading is `kind-input.ts`'s, shared with OpenClaw;
 * the only Copilot-specific parts are which kind the tool name maps to and which keys
 * a file tool drops. One narrowing worth knowing about: a `network.fetch` is scanned
 * for secret values on `url` and `prompt` alone, so a value placed in another field
 * (a header, say) is not caught yet — the same gap Claude Code's own `WebFetch` has
 * (see the spec's limits) — but the whole record still reaches the engine, so the
 * audit summary carries it and a future widening needs no change here.
 */
export const copilotToolInput = (call: CopilotToolCall): Record<string, unknown> =>
  kindToolInput(copilotToolKind(call.toolName, call.toolArgs), call.toolArgs, DROPPED_FILE_FIELDS);

/**
 * The text of a completed action. Copilot's own field is `textResultForLlm`; the
 * stream shapes below it are the ones a proxy or a future build might send, and are
 * read by the same helper the Codex adapter uses.
 */
export function copilotResultText(result: unknown): string {
  if (isRecord(result)) {
    const text = result['textResultForLlm'];
    if (typeof text === 'string' && text !== '') return toolResultToText(text);
  }
  return streamResultText(result);
}

/**
 * Tools that only look at things. A Stroq internal error on one of these answers with
 * silence rather than exit 2, and that is a deliberate trade-off, not a claim that
 * nothing here is ever denied: a `view` of `.env` in a tainted session IS denied
 * (`deny-secrets-when-tainted`), so an internal error on that call fails open on a
 * real deny. It is the same call Claude Code and Codex make for their own read tools
 * — the fail-closed path exists for the actions that change something, and stalling
 * the agent on every failed read buys less than it costs. Everything else —
 * including a name Stroq has never heard of, and an empty one — is high impact,
 * because an unknown name is an MCP call. `str_replace_editor` is high impact
 * whatever its sub-command says: the fail-closed path is reached exactly when the
 * arguments could not be read.
 */
const LOW_IMPACT: ReadonlySet<string> = new Set([...READ_TOOLS, ...PLAIN_NAMES.keys()]);

export const isCopilotHighImpact = (rawTool: string): boolean => !LOW_IMPACT.has(rawTool);
