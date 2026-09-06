import { toolResultToText } from './claude-code.js';
import { applyPatchPaths, commandOf, isBashTool, patchTextOf } from './codex-input.js';
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

/** Copilot spells the file argument `path`; every rule, summary and audit line reads `file_path`. */
const PATH_FIELDS = ['path', 'file_path', 'raw'] as const;

/**
 * Every distinct non-empty path candidate among `path`, `file_path` and `raw`, in
 * that order — not just the first: `{ path: 'safe.txt', file_path: '<protected>' }`
 * would otherwise let the protected value disappear behind whichever field a
 * first-match reader happened to check first. More than one candidate is judged the
 * way an `apply_patch`'s paths already are: `copilotToolInput` exposes the whole
 * list under `file_paths` and `preGuards`/`preInputs` fan out one `engine.pre` per
 * path, worst wins.
 */
const pathsOf = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const found = new Set<string>();
  for (const key of PATH_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.add(value);
  }
  return [...found];
};

/** Where a `web_fetch` call might put the URL, the documented spelling first. */
const URL_FIELDS = ['url', 'uri', 'href', 'raw'] as const;

/**
 * Every distinct non-empty URL candidate, read exactly the way `pathsOf` reads a
 * path — because the failure mode is the same and worse: core classifies `WebFetch`
 * on `url` alone and scans `url`/`prompt` for secret values, so a URL that does not
 * land in `url` as a string is a fetch with no host, no secret candidate and no
 * reason to deny. A bare-string `toolArgs` arrives under `raw`; an array of strings
 * contributes each element (a two-URL call is judged on both); anything else
 * contributes nothing, and a call left with no candidate at all is denied by
 * `unreadableInput` rather than run through the engine as an empty fetch.
 */
const urlsOf = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const found = new Set<string>();
  for (const key of URL_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.add(value);
    else if (Array.isArray(value))
      for (const item of value) if (typeof item === 'string' && item !== '') found.add(item);
  }
  return [...found];
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

/**
 * The record the engine sees for a call whose real subject is one of several
 * candidates: the first under the canonical key the classifier reads, and the whole
 * list under `<key>s` when they disagreed, which is what `preInputs` fans out over.
 */
const withCandidates = (
  base: Readonly<Record<string, unknown>>,
  key: 'file_path' | 'url',
  candidates: readonly string[],
): Record<string, unknown> => {
  const one = { ...base, [key]: candidates[0] ?? '' };
  return candidates.length > 1 ? { ...one, [`${key}s`]: [...candidates] } : one;
};

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
    return withCandidates(withoutKeys(record, DROPPED_FILE_FIELDS), 'file_path', pathsOf(record));
  // Kept whole, not reduced to `url` alone: an MCP call's secret-egress check reads
  // `JSON.stringify(toolInput)`, so a field dropped here could never be caught
  // leaving through `mcp.call`. A `network.fetch` (this `web_fetch` case) is narrower
  // today — core's secret guard scans only `url` and `prompt` for WebFetch, so a
  // value placed in another field (e.g. a header) is not caught yet, the same gap
  // Claude Code's own WebFetch has (see the spec's limits section) — but the record
  // stays whole here too, so the audit summary carries it and a future widening of
  // the guard needs no change in this adapter.
  if (kind === 'fetch') return withCandidates(record, 'url', urlsOf(record));
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
