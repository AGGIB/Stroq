import { toolResultToText } from './claude-code.js';
import { isBashTool } from './codex-input.js';
import { mcpToolName } from './cursor-mcp-name.js';
import { kindToolInput, type ToolKind } from './kind-input.js';
import { toolInputRecord } from './tool-input.js';
import { streamResultText } from './tool-result.js';

/**
 * Reading a Google Antigravity hook payload: which tool `toolCall.name` is, and where
 * in `toolCall.args` the shell command, the file path or the URL actually is.
 *
 * The one thing genuinely new here is the CASING. Antigravity's tool arguments are
 * PascalCase throughout — `CommandLine`, `Cwd`, `AbsolutePath`, `TargetFile`, `Url`,
 * `Pattern` — and every reader Stroq already had looks for `command`/`cmd`/`input`/
 * `script`/`raw` and `path`/`file_path`/`url`. Against an Antigravity payload those
 * find nothing at all, which is the single most likely way to ship an adapter that
 * looks installed and classifies every call as an empty action. The fix is in the
 * SHARED spelling lists (`codex-input.ts`'s `COMMAND_FIELDS`, `kind-input.ts`'s
 * `PATH_FIELDS` and `URL_FIELDS`), appended last so no other agent's first candidate
 * moves, exactly as Windsurf's `command_line` was added — one list, one fix.
 *
 * The second safety net is the shared `unreadableGuard`: only `CommandLine` and `Cwd`
 * appear in Antigravity's own documentation, and the rest of the PascalCase spellings
 * are read off the Windsurf/Cascade lineage this agent is built on. A spelling guessed
 * wrong therefore surfaces as an `antigravity-unreadable-input` deny naming the keys,
 * not as a silent allow.
 */

/**
 * The server name Stroq attributes an MCP call to. Antigravity's hooks report the
 * tool's own name and no server at all — only its permission syntax (`mcp(server/
 * tool)`) knows one — so a synthetic server is the only way to compose a name core's
 * `parseMcpToolName` accepts, and `mcp.call` is what puts the arguments in front of
 * the secret-egress guard.
 */
export const ANTIGRAVITY_MCP_SERVER = 'antigravity';

/** What a native Antigravity tool does; the kinds are the shared set every agent maps onto. */
export type AntigravityKind = ToolKind;

/**
 * Shell spellings, on top of the one Antigravity documents (`run_command`).
 * `isBashTool` already covers `Bash`, `shell`, `exec_command` and `local_shell`; the
 * rest are added here. A spelling that misses this set is treated as an MCP tool —
 * `mcp__antigravity__sh` — and the whole shell rule set never runs on it, so
 * `curl … | sh` would be allowed in an untainted session. Reading a name Stroq does
 * not need costs nothing; missing one is a command nobody classified.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'run_terminal_command',
  'bash',
  'sh',
  'zsh',
  'powershell',
  'terminal',
]);
const isShellTool = (rawTool: string): boolean => SHELL_TOOLS.has(rawTool) || isBashTool(rawTool);

/**
 * Antigravity documents no patch tool, but its argument shapes are Cascade's and the
 * `apply_patch` body format is shared across agents. Naming it costs nothing and
 * missing it would mean a patch whose declared paths — `.agents/hooks.json` among
 * them — nobody classified.
 */
const PATCH_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'ApplyPatch']);

/**
 * Write tools. `create_file` and `edit_file` are documented; `write_to_file` and
 * `replace_file_content` are the Cascade lineage's spellings for the same two.
 * Missing a WRITE spelling is not the harmless direction the way missing a search
 * tool is: core's `config.self` check for an MCP-shaped call needs the protected path
 * to sit under a key its `PATH_LIKE_KEY` recognises, and `AbsolutePath`/`TargetFile`
 * are not among them — so an unnamed write tool is a write to Stroq's own hook file
 * that `deny-self-tamper` never sees.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
]);
/** The one documented write name that CREATES rather than edits; see `antigravityToolName`. */
const CREATE_TOOLS: ReadonlySet<string> = new Set(['create_file', 'write_to_file']);

/**
 * Read tools. Naming them matters for the `post` side rather than the `pre` side:
 * Antigravity's `PostToolUse` carries no result text, so a `read` is the one kind
 * where Stroq can still scan what the model saw — by opening the file itself. A read
 * spelling Stroq does not know is an MCP call, which is more scrutiny on `pre` and no
 * taint at all on `post`.
 */
const READ_TOOLS: ReadonlySet<string> = new Set(['view_file', 'read_file', 'view_line_range']);

/** Antigravity's documented fetch tool, plus the spelling the other agents use. */
const FETCH_TOOLS: ReadonlySet<string> = new Set(['read_url_content', 'web_fetch']);

/**
 * Native tools whose Stroq name is fixed and whose arguments need no reshaping.
 *
 * `ask_question` and `finish` map to themselves: they classify to nothing, and giving
 * them an MCP name would put a tool that never leaves the session in front of the
 * egress guard as if it did. The searches map onto the Stroq names the classifier
 * knows.
 *
 * Deliberately absent, and each for a reason: `start_subagent` and `generate_image`
 * are documented but both bring content into the session from outside it, so they get
 * an MCP call's scrutiny the way OpenClaw's media generators do; `browser_*` is
 * undocumented; and `find_by_name` — Cascade's spelling of `find_file`, the tool in
 * Pillar Security's prompt-injection-to-RCE chain (disclosed 2026-01-07, fixed
 * 2026-02-28) — is left to the MCP fallback on purpose. For a SEARCH tool the
 * fallback is strictly more scrutiny (its whole argument record reaches the
 * secret-egress guard, and a Stroq error on it is fail-closed), so there is nothing
 * to gain by naming it and something to lose.
 */
const PLAIN_NAMES: ReadonlyMap<string, string> = new Map([
  ['search_web', 'WebSearch'],
  ['search_directory', 'Grep'],
  ['grep_search', 'Grep'],
  ['find_file', 'Glob'],
  ['list_directory', 'Glob'],
  ['ask_question', 'ask_question'],
  ['finish', 'finish'],
]);

const KIND_NAMES = { shell: 'Bash', patch: 'Write', read: 'Read', fetch: 'WebFetch' } as const;

export function antigravityToolKind(rawTool: string): AntigravityKind {
  if (isShellTool(rawTool)) return 'shell';
  if (PATCH_TOOLS.has(rawTool)) return 'patch';
  if (WRITE_TOOLS.has(rawTool)) return 'write';
  if (READ_TOOLS.has(rawTool)) return 'read';
  if (FETCH_TOOLS.has(rawTool)) return 'fetch';
  return PLAIN_NAMES.has(rawTool) ? 'plain' : 'mcp';
}

/**
 * Antigravity's native tool list is short and documented, so a name that is not in it
 * is almost certainly an MCP tool — and the mis-guess is safe in one direction only:
 * an unlisted native tool classified as `mcp.call` is merely scanned, while a real MCP
 * call left unclassified is a `.env` value nobody looked at. `Write` and `Edit`
 * classify identically (both are in core's `WRITE_TOOLS`), so the split is for the
 * audit's readability, not for the decision.
 */
export function antigravityToolName(rawTool: string): string {
  const kind = antigravityToolKind(rawTool);
  if (kind === 'write') return CREATE_TOOLS.has(rawTool) ? 'Write' : 'Edit';
  if (kind === 'plain') return PLAIN_NAMES.get(rawTool) ?? rawTool;
  if (kind !== 'mcp') return KIND_NAMES[kind];
  return rawTool.startsWith('mcp__')
    ? mcpToolName('', rawTool)
    : mcpToolName(ANTIGRAVITY_MCP_SERVER, rawTool);
}

/**
 * Dropped from the record a file tool hands the engine: each of these has just been
 * rewritten as the `file_path` every rule, summary and audit line reads, and two keys
 * meaning the same thing is how they drift apart.
 */
const DROPPED_FILE_FIELDS: readonly string[] = ['path', 'AbsolutePath', 'TargetFile'];

/** The subset of an Antigravity event this module reads: `toolCall`, flattened. */
export interface AntigravityToolCall {
  readonly name: string;
  readonly args?: unknown;
}

/**
 * `toolCall` as a name and its arguments. Unlike every other adapter the name is
 * NESTED, so a payload that carries no readable one is malformed rather than merely
 * unknown — and malformed input is fail-closed, not ignored. Throwing here is what
 * routes it to `antigravityFailClosedOutput`, which denies a `pre`; returning an empty
 * name instead would classify the call as an MCP call with no arguments, which is an
 * allow.
 */
export function antigravityToolCall(toolCall: unknown): AntigravityToolCall {
  const record = toolInputRecord(toolCall);
  const name = record['name'];
  if (typeof name !== 'string')
    throw new Error('Antigravity payload has no readable toolCall.name; denied fail-closed');
  return { name, args: record['args'] };
}

/**
 * The project directory policy is applied in: the first workspace path Antigravity
 * reports, which is the workspace the IDE opened and not anything the model chose.
 *
 * `toolCall.args.Cwd` is never read for this, on any tool kind — a model that could
 * point it elsewhere could point the project's `.env*` secret index and the path
 * rules at an empty directory and walk a credential straight past the guard (the
 * OpenClaw Critical, corrected before ship, and the same call the Windsurf adapter
 * makes). A multi-root workspace is indexed through its first root only, exactly as
 * Cursor's `workspace_roots[0]` is.
 */
export function antigravityWorkspace(workspacePaths: unknown): string {
  if (!Array.isArray(workspacePaths)) return '';
  for (const path of workspacePaths) if (typeof path === 'string' && path !== '') return path;
  return '';
}

/**
 * The record the engine sees. The reading is `kind-input.ts`'s, shared with the
 * Copilot, OpenClaw and Windsurf adapters; the only Antigravity-specific parts are
 * which kind the tool name maps to and which keys a file tool drops. A `fetch` and an
 * MCP call keep their whole record rather than being reduced to one field, so the
 * secret-egress guard sees everything a call carries.
 */
export const antigravityToolInput = (call: AntigravityToolCall): Record<string, unknown> =>
  kindToolInput(antigravityToolKind(call.name), call.args, DROPPED_FILE_FIELDS);

/** A thrown or serialised error reduced to its message, wherever the payload put it. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const record = toolInputRecord(error);
  const message = record['message'];
  return typeof message === 'string' ? message : '';
}

/**
 * The text of a completed action.
 *
 * Antigravity's `PostToolUse` carries the same envelope as `PreToolUse` plus an
 * optional `error`, and NO result field — so a command's output, a fetched page and
 * an MCP result are all invisible to the hook, which is this adapter's largest
 * documented limit. What is left is the error text, which the model does see, and
 * whatever result field a future build might add: the stream shapes below are read by
 * the same helpers every other adapter uses, so the day one appears it is scanned
 * without a change here.
 */
export function antigravityResultText(result: unknown, error: unknown = undefined): string {
  const parts = [streamResultText(result), toolResultToText(errorText(error))];
  return parts.filter((part) => part !== '').join('\n');
}

/**
 * Tools that only look at things. A Stroq internal error on one of these answers with
 * silence rather than a deny, and that is a deliberate trade-off, not a claim that
 * nothing here is ever denied: a `view_file` of `.env` in a tainted session IS denied
 * (`deny-secrets-when-tainted`), so an internal error on that call fails open on a
 * real deny. It is the same call Claude Code, Codex, Copilot, OpenClaw and Windsurf
 * make for their own read tools — the fail-closed path exists for the actions that
 * change something, and stalling the agent on every failed read buys less than it
 * costs. Everything else — including a name Stroq has never heard of, and an empty
 * one — is high impact, because an unknown name is an MCP call.
 */
const LOW_IMPACT: ReadonlySet<string> = new Set([...READ_TOOLS, ...PLAIN_NAMES.keys()]);

export const isAntigravityHighImpact = (rawTool: string): boolean => !LOW_IMPACT.has(rawTool);
