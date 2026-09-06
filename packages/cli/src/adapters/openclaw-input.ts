import { toolResultToText } from './claude-code.js';
import { isBashTool } from './codex-input.js';
import { mcpToolName } from './cursor-mcp-name.js';
import { kindToolInput, type ToolKind } from './kind-input.js';
import { isRecord } from './tool-input.js';
import { streamResultText } from './tool-result.js';

/**
 * Reading an OpenClaw tool call: which tool it names, and where in `params` the shell
 * command, the patch body, the file path or the URL actually is.
 *
 * The command, argv and patch readers are Codex's (`codex-input.ts`) and the
 * kind-to-record reader — path and URL candidates included — is `kind-input.ts`'s,
 * shared with the Copilot adapter. None of them is a copy: the shapes are the same
 * shapes, and a divergence between two readers of one shape is a bypass that only
 * reproduces on one agent.
 */

/**
 * The server name Stroq attributes an MCP call to. OpenClaw's documentation says
 * nothing about how an MCP tool's name reaches a hook, so a synthetic server is the
 * only way to compose a name core's `parseMcpToolName` accepts — and `mcp.call` is
 * what puts the arguments in front of the secret-egress guard.
 */
export const OPENCLAW_MCP_SERVER = 'openclaw';

/** What a native OpenClaw tool does; the kinds are the shared set every agent maps onto. */
export type OpenClawKind = ToolKind;

/**
 * `exec` is the documented shell tool; the rest are defensive aliases. `isBashTool`
 * already covers `shell`, `exec_command` and `local_shell` (plus Codex's capitalised
 * `Bash`), and the names below are added for the same reason: a spelling that misses
 * this set becomes `mcp__openclaw__sh` and the whole shell rule set never runs on it,
 * so `curl … | sh` would be allowed in an untainted session. Reading a name Stroq
 * does not need costs nothing; missing one is a command nobody classified.
 *
 * `terminal` is here because its input IS a command line — it was an MCP call until
 * the whole-branch review found exactly the gap above: `terminal { command: 'curl …
 * | sh' }` was allowed untainted while the identical `exec` call was denied. Its
 * siblings `process` and `code_execution` deliberately are NOT: their parameter
 * shapes are undocumented, so the shell kind — which reduces `params` to one
 * `command` field — would turn every call Stroq cannot read into an
 * `openclaw-unreadable-input` deny. They stay side-effect MCP tools instead, which
 * means their command text is not classified by the shell rules when the session is
 * untainted; see the README's OpenClaw limits.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'exec',
  'bash',
  'sh',
  'zsh',
  'run_command',
  'terminal',
]);
const isShellTool = (rawTool: string): boolean => SHELL_TOOLS.has(rawTool) || isBashTool(rawTool);

const PATCH_TOOLS: ReadonlySet<string> = new Set(['apply_patch']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['read']);
const FETCH_TOOL = 'web_fetch';

/**
 * Native tools whose Stroq name is fixed and whose arguments need no reshaping.
 * `ask_user`, `progress_card`, `heartbeat_respond` and `get_goal` map to themselves —
 * and ONLY these four: each neither leaves the session, returns external content, nor
 * mutates state, so classifying them to nothing costs nothing. `web_search`/`x_search`
 * map onto the real `WebSearch` tool name instead of to themselves, which is scanned
 * and low impact exactly as `Read` is.
 *
 * Task 1 review ruling: this list used to also self-map `view_image`,
 * `image_generate`, `music_generate`, `video_generate`, `tts`, `tool_search`,
 * `tool_search_code`, `tool_describe`, `create_goal` and `update_goal`. Every one of
 * those returns external content (a search result, a generated asset, a tool's own
 * docstring) or otherwise warrants the same scrutiny as a real MCP call, and
 * self-mapping them exempted each one from the `post` scan (core's `SCANNED_TOOLS`
 * never matches a bare name), the secret-egress guard (only `mcp.call` reads the
 * whole argument record for a known secret) and the fail-closed path all at once —
 * `tts` given a secret value was silently allowed, and a poisoned `tool_describe`
 * result never tainted the session. All ten now fall through to the `mcp` kind below.
 */
const PLAIN_NAMES: ReadonlyMap<string, string> = new Map([
  ['web_search', 'WebSearch'],
  ['x_search', 'WebSearch'],
  ['ask_user', 'ask_user'],
  ['progress_card', 'progress_card'],
  ['heartbeat_respond', 'heartbeat_respond'],
  ['get_goal', 'get_goal'],
]);

const KIND_NAMES = { shell: 'Bash', patch: 'Write', read: 'Read', fetch: 'WebFetch' } as const;

/**
 * OpenClaw's own tool names are not guaranteed to arrive in one case or already
 * trimmed — `EXEC`, `Exec` and `'exec '` have all been seen from real integrations —
 * and a spelling that misses its kind for nothing but casing or whitespace becomes
 * `mcp__openclaw__EXEC`, silently skipping the whole shell (or write, or read, …) rule
 * set. Every kind and name lookup below runs on the normalised name; the tool name
 * Stroq actually EMITS is unaffected, since it always comes from a fixed table
 * (`KIND_NAMES`, `PLAIN_NAMES`'s values) rather than from the raw string's own casing.
 */
const normalizeToolName = (rawTool: string): string => rawTool.trim().toLowerCase();

/**
 * Unlike Copilot's, this needs no arguments: OpenClaw has no editor tool that hides a
 * sub-command in a field called `command`, so the name alone decides the kind.
 */
export function openclawToolKind(rawTool: string): OpenClawKind {
  const tool = normalizeToolName(rawTool);
  if (isShellTool(tool)) return 'shell';
  if (PATCH_TOOLS.has(tool)) return 'patch';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (READ_TOOLS.has(tool)) return 'read';
  if (tool === FETCH_TOOL) return 'fetch';
  return PLAIN_NAMES.has(tool) ? 'plain' : 'mcp';
}

/**
 * OpenClaw's native tool list is documented and finite, so a name that is not in it —
 * or one of the side-effecting natives whose parameter shapes are not documented
 * (`message`, `browser`, `process`, `code_execution`, …) — is treated as
 * an MCP call. The mis-guess is safe in one direction only: a native tool classified
 * as `mcp.call` is merely scanned, while a real egress left unclassified is a `.env`
 * value nobody looked at. `Write` and `Edit` classify identically (both are in core's
 * `WRITE_TOOLS`), so the split between `write` and `edit` is for the audit's
 * readability, not for the decision.
 */
export function openclawToolName(rawTool: string): string {
  const tool = normalizeToolName(rawTool);
  const kind = openclawToolKind(tool);
  if (kind === 'write') return tool === 'write' ? 'Write' : 'Edit';
  if (kind === 'plain') return PLAIN_NAMES.get(tool) ?? tool;
  if (kind !== 'mcp') return KIND_NAMES[kind];
  return tool.startsWith('mcp__') ? mcpToolName('', tool) : mcpToolName(OPENCLAW_MCP_SERVER, tool);
}

/**
 * Dropped from the record a file tool hands the engine: `path` has just been rewritten
 * as the `file_path` every rule, summary and audit line reads, and two keys meaning the
 * same thing is how they drift apart.
 */
const DROPPED_FILE_FIELDS: readonly string[] = ['path'];

/** The subset of an OpenClaw event this module reads. */
export interface OpenClawToolCall {
  readonly toolName: string;
  readonly params?: unknown;
}

/**
 * The record the engine sees. The reading is `kind-input.ts`'s, shared with Copilot;
 * the only OpenClaw-specific parts are which kind the tool name maps to and which
 * keys a file tool drops. Two consequences worth naming: a shell call is reduced to
 * `{ command }`, so `cwd` and `timeout` are not carried into the action — where a
 * command runs is not part of what it does, and `params.cwd` is never read for policy
 * purposes anywhere (see `handleOpenClawHook`, which uses only the trusted top-level
 * `cwd`), it stays in `call.params` for the audit trail alone; and a `fetch` or an MCP
 * call keeps its whole record, since an MCP call's secret-egress check reads
 * `JSON.stringify(toolInput)` and a field dropped here could never be caught leaving
 * through `mcp.call` — which is what a `message` body and a `browser` form fill are.
 */
export const openclawToolInput = (call: OpenClawToolCall): Record<string, unknown> =>
  kindToolInput(openclawToolKind(call.toolName), call.params, DROPPED_FILE_FIELDS);

/** A failed tool's message, preferred over its JSON shape when it has one. */
function errorText(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return toolResultToText(error);
}

/**
 * The text of a completed action. OpenClaw's `after_tool_call` carries `result` in
 * whatever shape the tool produced — a string, a `{ text }`, a `{ content: [...] }`
 * block list, a `{ output }` or `{ stdout, stderr }` pair, or arbitrary JSON — all of
 * which `streamResultText` and `toolResultToText` already read for the other agents.
 * `error` is appended rather than replacing it: a tool that failed *after* printing a
 * poisoned page has still shown the model the poison, and a poisoned failure message
 * is itself content that has to be scanned.
 */
export function openclawResultText(result: unknown, error: unknown = undefined): string {
  const parts = [streamResultText(result), toolResultToText(errorText(error))];
  return parts.filter((part) => part !== '').join('\n');
}

/**
 * Tools that only look at things. A Stroq internal error on one of these answers
 * `allow` rather than a block, and that is a deliberate trade-off, not a claim that
 * nothing here is ever denied: a `read` of `.env` in a tainted session IS denied
 * (`deny-secrets-when-tainted`), so an internal error on that call fails open on a
 * real deny. It is the same call Claude Code, Codex and Copilot make for their own
 * read tools — the fail-closed path exists for the actions that change something, and
 * blocking every read and search in a session because Stroq failed once buys less
 * than it costs. Everything else — including a name Stroq has never heard of, and an
 * empty one — is high impact, because an unknown name is an MCP call.
 */
const LOW_IMPACT: ReadonlySet<string> = new Set([...READ_TOOLS, ...PLAIN_NAMES.keys()]);

export const isOpenClawHighImpact = (rawTool: string): boolean =>
  !LOW_IMPACT.has(normalizeToolName(rawTool));
