import { mcpToolName } from './cursor-mcp-name.js';
import { isRecord, toolInputRecord } from './tool-input.js';

/**
 * Reading a Codex `PreToolUse` payload: which tool it names, and where in
 * `tool_input` the shell command or the `apply_patch` body actually is.
 *
 * Only `Bash`, `apply_patch` and `mcp__…` are documented by OpenAI; the other
 * spellings below are defensive aliases seen in third-party integrations and in
 * Codex's own unified-exec naming. Reading a field spelling Stroq does not know
 * costs nothing; missing one means a command that classifies to nothing, and a
 * command that classifies to nothing is a command that is allowed.
 *
 * The readers below are shared with the Copilot adapter (`copilot-input.ts`): Copilot
 * sends the same three shapes under different names (`toolArgs` rather than
 * `tool_input`), and an `apply_patch` body identical to Codex's.
 */

/** Every `tool_name` that carries a shell command. */
const BASH_TOOLS: ReadonlySet<string> = new Set(['Bash', 'exec_command', 'shell', 'local_shell']);
/** Every `tool_name` that carries a patch body. */
const PATCH_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'ApplyPatch']);

export const isBashTool = (name: string): boolean => BASH_TOOLS.has(name);
export const isPatchTool = (name: string): boolean => PATCH_TOOLS.has(name);

/**
 * Tool shapes where a Codex deny actually stops a high-impact action, and so the
 * ones an internal error answers with exit code 2 — the single block Codex honours
 * without parsing stdout. Kept identical to the `PreToolUse` matcher `init` writes
 * (`commands/codex-hooks.ts`), so Stroq never sees a Pre event it cannot answer.
 */
export const CODEX_HIGH_IMPACT_TOOL =
  /^(Bash|exec_command|shell|local_shell|apply_patch|ApplyPatch|mcp__)/;

/**
 * Codex names an MCP tool `mcp__<server>__<tool>` in `tool_name` and reports no
 * separate server, so the shared sanitiser is called with an empty server: it then
 * splits at the FIRST `__` and re-sanitises each half, so a tool whose own name
 * carries a second separator cannot forge a different server. Every patch spelling
 * becomes `Write` and every shell spelling `Bash` (the tool names the classifier's
 * rules know); everything else is passed through unchanged and classifies to nothing.
 */
export function codexToolName(rawTool: string): string {
  if (isPatchTool(rawTool)) return 'Write';
  if (isBashTool(rawTool)) return 'Bash';
  if (rawTool.startsWith('mcp__')) return mcpToolName('', rawTool);
  return rawTool;
}

/** `bash`, `sh`, `/bin/zsh`, `/usr/bin/dash`: argv[0] of a `<shell> -c <script>` call. */
const ARGV_SHELL = /^(?:\/\w+\/)*(?:bash|sh|zsh|dash)$/;
/**
 * `-c`, `-lc`, `-ec`, `-xc`, `-ce`, …: the flag that makes the next element a script
 * rather than a word. Deliberately narrow — the shell's other single-letter options
 * only — so a long option that merely contains a `c` (`-check`, `-nocorrect`) stays
 * an ordinary argument instead of hiding everything before it from the classifier.
 */
const ARGV_SHELL_FLAG = /^-[eilx]{0,3}c[eilx]{0,2}$/;
/** Whitespace or a character a shell reads as syntax rather than as literal text. */
const NEEDS_QUOTING = /[\s'"$`\\|&;<>()*?[\]#~]/;

const quoteArg = (arg: string): string =>
  NEEDS_QUOTING.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;

/**
 * argv as one command line. `['bash','-lc',script]` classifies the script alone,
 * because that is the command that actually runs. Every other array is joined with
 * each element quoted the way a shell would need it: a naive space-join turns
 * `['git','commit','-m','rm -rf /']` into `git commit -m rm -rf /`, which the
 * classifier reads as a root wipe and the policy turns into an `ask` — and on Codex
 * an `ask` is a deny the user has no way to answer.
 */
export function joinArgv(values: readonly unknown[]): string {
  const argv = values.filter((v): v is string => typeof v === 'string');
  const [shell, flag, ...rest] = argv;
  const isShellCall =
    shell !== undefined &&
    flag !== undefined &&
    rest.length > 0 &&
    ARGV_SHELL.test(shell) &&
    ARGV_SHELL_FLAG.test(flag);
  return isShellCall ? rest.join(' ') : argv.map(quoteArg).join(' ');
}

/** Where a Codex build might put the shell command, most official first. */
const COMMAND_FIELDS = ['command', 'cmd', 'input', 'script', 'raw'] as const;
/** The string fields of a nested object that may hold it — one level down only. */
const NESTED_TEXT_FIELDS = ['text', 'command', 'cmd'] as const;

function nestedText(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const key of NESTED_TEXT_FIELDS) {
    const inner = value[key];
    if (typeof inner === 'string' && inner !== '') return inner;
  }
  return '';
}

const fieldCommand = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return joinArgv(value);
  return nestedText(value);
};

/**
 * EVERY command `tool_input` could be carrying, in field order and de-duplicated:
 * an object under any of the field spellings above (string, argv array, or a
 * one-level-nested `{ text }`), a bare argv array, or a plain string used verbatim
 * through `toolInputRecord`'s `raw` fallback.
 *
 * All of them, not the first: taking only the first would let `{ command: 'ls',
 * cmd: 'curl … | sh' }` classify `ls` and allow the call, with whichever field
 * Codex actually meant never examined. The caller runs one `engine.pre` per
 * candidate and takes the worst, the same way it treats an `apply_patch`'s paths.
 * An empty result is denied fail-closed rather than handed to the engine as an
 * empty action — the classifier and the secret-egress guard both read this field,
 * and a command that reaches neither is a command that runs.
 */
export function commandCandidates(toolInput: unknown): readonly string[] {
  if (Array.isArray(toolInput)) {
    const joined = joinArgv(toolInput);
    return joined === '' ? [] : [joined];
  }
  const record = toolInputRecord(toolInput);
  const found = new Set<string>();
  for (const key of COMMAND_FIELDS) {
    const text = fieldCommand(record[key]);
    if (text !== '') found.add(text);
  }
  return [...found];
}

/** The command the engine and the secret guard see in `command`: the first candidate. */
export const commandOf = (toolInput: unknown): string => commandCandidates(toolInput)[0] ?? '';

/**
 * The patch body, unioned across every field this Codex build might use for it —
 * including `raw` (the whole `tool_input`, populated by `toolInputRecord` when it
 * was not an object at all) — rather than stopping at the first non-empty one. An
 * earlier field can hold something unrelated (even Codex's own tool name,
 * `command: 'apply_patch'`) while a later one carries the real patch text: reading
 * only the first found would silently drop that patch's paths, and a dropped path
 * is a `deny-self-tamper` that never fires. More fields can only add paths to the
 * union, never hide ones another field already carries.
 */
const PATCH_FIELDS = ['command', 'input', 'patch', 'raw', 'cmd', 'script', 'arguments'] as const;

/**
 * A byte-order mark before the first `*** …` line would defeat the anchored header
 * match below and hide the file a one-header patch touches.
 */
const stripBom = (text: string): string => (text.startsWith('\uFEFF') ? text.slice(1) : text);

const joinLines = (values: readonly unknown[]): string =>
  values
    .filter((v): v is string => typeof v === 'string')
    .map(stripBom)
    .join('\n');

/** One field's contribution to the union; `depth` allows exactly one nested object. */
function patchFieldTexts(value: unknown, depth: number): string[] {
  if (typeof value === 'string') return value === '' ? [] : [stripBom(value)];
  if (Array.isArray(value)) {
    const joined = joinLines(value);
    return joined === '' ? [] : [joined];
  }
  if (depth > 0 && isRecord(value))
    return PATCH_FIELDS.flatMap((key) => patchFieldTexts(value[key], depth - 1));
  return [];
}

export function patchTextOf(toolInput: unknown): string {
  if (Array.isArray(toolInput)) return joinLines(toolInput);
  const record = toolInputRecord(toolInput);
  return PATCH_FIELDS.flatMap((key) => patchFieldTexts(record[key], 1)).join('\n');
}

/**
 * A header only counts at column 0. Patch body lines are prefixed with `+`, `-` or a
 * space, so an anchored match is what stops a patch that merely *contains*
 * `*** Add File: /home/dev/.ssh/id_rsa` from claiming to touch a file it does not —
 * and, in the other direction, from hiding the file it really does touch behind noise.
 * The capture may be empty (a header with no path, or one whose path is a lone `\r`):
 * the caller drops those, which is why it is `[^\r\n]*?` and not `.+?`.
 */
const PATCH_HEADER =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*([^\r\n]*?)[ \t\r]*$/;

/**
 * Every distinct path an `apply_patch` body declares, in the order it declares them.
 * No length cap: splitting a string and running one anchored regex per line is cheap,
 * and `MAX_PATCH_PATHS` is the actual timeout bound — a cap here would let a patch
 * that pads its early lines past a fixed character count hide a later header
 * (e.g. `*** Update File: .codex/hooks.json`) from ever being seen at all, which is
 * strictly worse than the slow-but-thorough scan this function does instead.
 */
export function applyPatchPaths(patchText: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patchText.split('\n')) {
    const path = PATCH_HEADER.exec(line)?.[1] ?? '';
    if (path !== '') paths.add(path);
  }
  return [...paths];
}

/** The subset of a Codex event this module reads. */
export interface CodexToolCall {
  readonly tool_name: string;
  readonly tool_input?: unknown;
}

export function codexToolInput(input: CodexToolCall): Record<string, unknown> {
  if (isBashTool(input.tool_name)) return { command: commandOf(input.tool_input) };
  if (isPatchTool(input.tool_name)) {
    const paths = applyPatchPaths(patchTextOf(input.tool_input));
    return { file_path: paths[0] ?? '', file_paths: [...paths] };
  }
  return toolInputRecord(input.tool_input);
}

/** True when `tool_input` carried nothing at all to act on. */
export function isEmptyToolInput(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * What Stroq saw, for a deny reason it will print, log and audit: the sorted
 * top-level key NAMES of an object, or the type of a value that was not one. Never
 * a value — `tool_input` is exactly where a secret would be.
 */
export function describeToolInput(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (isRecord(value)) return Object.keys(value).sort().join(', ');
  return value === null ? 'null' : typeof value;
}
