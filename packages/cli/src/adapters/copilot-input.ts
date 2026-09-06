import { toolResultToText } from './claude-code.js';
import { applyPatchPaths, commandOf, patchTextOf } from './codex-input.js';
import { mcpToolName } from './cursor-mcp-name.js';
import { isRecord, toolInputRecord } from './tool-input.js';
import { streamResultText } from './tool-result.js';

/**
 * Reading a Copilot CLI hook payload: which tool it names, and where in `toolArgs`
 * the shell command, the patch body or the file path actually is.
 *
 * The command, argv and patch readers are Codex's (`codex-input.ts`), not copies:
 * both agents send a shell command under a handful of field spellings and an
 * `apply_patch` body in the same format, and a divergence between the two readers
 * would be a bypass that only reproduces on one agent.
 */

/**
 * The server name Stroq attributes an MCP call to. Copilot's hooks report the tool's
 * own name and no server at all — only its permission syntax (`Server(tool)`) knows
 * one — so a synthetic server is the only way to compose a name core's
 * `parseMcpToolName` accepts, and `mcp.call` is what puts the arguments in front of
 * the secret-egress guard.
 */
export const COPILOT_MCP_SERVER = 'copilot';

/** What a native Copilot tool does, which decides both its Stroq name and its input shape. */
export type CopilotKind = 'shell' | 'patch' | 'write' | 'read' | 'fetch' | 'plain' | 'mcp';

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);
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
  if (SHELL_TOOLS.has(rawTool)) return 'shell';
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

/** Copilot spells the file argument `path`; every rule, summary and audit line reads `file_path`. */
const PATH_FIELDS = ['path', 'file_path', 'raw'] as const;

const pathOf = (record: Readonly<Record<string, unknown>>): string => {
  for (const key of PATH_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
};

/**
 * Dropped from the record a file tool hands the engine. `path` goes because it has
 * just been rewritten as `file_path` and two keys meaning the same thing is how they
 * drift apart; `command` goes because it is `str_replace_editor`'s sub-command, and
 * `summarizeInput` prefers a key of that name — keeping it would label every editor
 * call `str_replace` in `stroq log` instead of naming the file it touched.
 */
const DROPPED_FILE_FIELDS: readonly string[] = ['command', 'path'];

const withoutKeys = (
  record: Readonly<Record<string, unknown>>,
  drop: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !drop.includes(key)));

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The subset of a Copilot event this module reads. */
export interface CopilotToolCall {
  readonly toolName: string;
  readonly toolArgs?: unknown;
}

export function copilotToolInput(call: CopilotToolCall): Record<string, unknown> {
  const record = toolInputRecord(call.toolArgs);
  const kind = copilotToolKind(call.toolName, call.toolArgs);
  if (kind === 'shell') return { command: commandOf(call.toolArgs) };
  if (kind === 'patch') {
    const paths = applyPatchPaths(patchTextOf(call.toolArgs));
    return { file_path: paths[0] ?? '', file_paths: [...paths] };
  }
  if (kind === 'write' || kind === 'read')
    return { ...withoutKeys(record, DROPPED_FILE_FIELDS), file_path: pathOf(record) };
  // Everything else keeps its whole record: `network.fetch` and `mcp.call` are egress
  // classes, and the secret guard reads `JSON.stringify(toolInput)`, so a field
  // dropped here is a value that can never be caught leaving through this call.
  if (kind === 'fetch') return { ...record, url: stringOf(record['url']) };
  return record;
}

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
 * silence rather than exit 2: there is nothing there for a deny to stop, and stalling
 * the agent buys no safety. Everything else — including a name Stroq has never heard
 * of, and an empty one — is high impact, because an unknown name is an MCP call.
 * `str_replace_editor` is high impact whatever its sub-command says: the fail-closed
 * path is reached exactly when the arguments could not be read.
 */
const LOW_IMPACT: ReadonlySet<string> = new Set([...READ_TOOLS, ...PLAIN_NAMES.keys()]);

export const isCopilotHighImpact = (rawTool: string): boolean => !LOW_IMPACT.has(rawTool);
