import type { ActionClass } from '../types.js';
import { classifyCommand, type CommandClassification } from './classify-bash.js';
import { isGitExecPath } from './git-exec.js';
import { normalizePathForMatch } from './normalize-path.js';
import { INSTRUCTION_FILE, SELF_CONFIG_FILE } from './self-config.js';

export { normalizePathForMatch } from './normalize-path.js';

export interface ToolClassification extends CommandClassification {
  readonly mcp?: { readonly server: string; readonly tool: string };
}

/**
 * The credential directories are matched bare as well as with a trailing slash.
 *
 * `/\.ssh\/` needed something after the directory, so `Read` or `Grep` pointed at
 * `~/.ssh` itself — which returns the key files' names, and for `Grep` their
 * contents — carried no class at all and stayed allowed in a tainted session. The
 * bare form ends at the token so `/.sshconfig` and `myaws/` do not match.
 *
 * A backslash counts as a separator here as well, even though `normalizePathForMatch`
 * has already folded them: this constant is matched against a raw path in tests and
 * could be reused elsewhere, and a credential pattern that only works when someone
 * remembered to normalise first is the kind that quietly stops checking.
 */
const SECRET_PATH =
  /((^|[/\\])\.ssh([/\\]|$)|\bid_(rsa|ed25519|ecdsa|dsa)\b|(^|[/\\])\.aws([/\\]|$)|(^|[/\\])\.env(\.[\w-]+)?$|\.(pem|p12|pfx|key)$|[/\\]\.(npmrc|netrc|pgpass|git-credentials)$|[/\\]\.kube([/\\]config$|$)|[/\\]\.config[/\\]gcloud([/\\]|$)|\/etc\/(shadow|passwd)$)/;
const SIDE_EFFECT_TOOL =
  /(send|post|publish|upload|email|mail|message|notify|pay|transfer|purchase|delete|remove|drop|deploy|execute|exec|run|shell|write|update|create|comment|merge|push)/i;
// `config.self` on an MCP call requires BOTH a write-shaped tool name and the
// protected path sitting in a path-like argument key — a path merely
// mentioned in a text/body/title value, or read by a read-shaped tool, is
// not self-tampering.
const WRITE_SHAPED_TOOL =
  /(write|edit|delete|remove|move|rename|append|put|save|update|create_file|mkdir)/i;
/**
 * Whole words of a tool name that mean it changes a file. Read as words, after a
 * snake-, kebab- or camelCase split, because the list of verbs above is matched inside
 * the name and a file tool is called what its author liked: `copy_file`, `str_replace`,
 * `touch`, `chmod`, `modifyFile` all wrote a file and none of them was on it.
 */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'delete',
  'remove',
  'move',
  'rename',
  'append',
  'put',
  'save',
  'update',
  'create',
  'mkdir',
  'copy',
  'cp',
  'mv',
  'patch',
  'replace',
  'insert',
  'overwrite',
  'touch',
  'chmod',
  'chown',
  'truncate',
  'modify',
  'apply',
  'set',
  'link',
  'symlink',
  'ln',
  'download',
  'extract',
  'unzip',
  'untar',
  'rm',
]);
const toolWords = (tool: string): string[] =>
  tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
const isWriteShaped = (tool: string): boolean =>
  WRITE_SHAPED_TOOL.test(tool) || toolWords(tool).some((word) => WRITE_WORDS.has(word));
/**
 * The argument keys that tell a tool WHERE to act, by what a tool author would call
 * them: anything ending in path, file, dir, directory or folder, with or without a
 * `name` after it (`source_path`, `relativePath`, `outputDir`, `file_name`), and the
 * short names for a source or a destination. A key that carries prose (`body`, `text`,
 * `title`) is not one, so a path mentioned in a message is still just a message.
 */
const PATH_LIKE_KEY =
  /(?:path|file|dir|directory|folder)(?:[_-]?name)?s?$|^(?:src|source|from|to|dest|destination|target|location|uri|url|cwd|root)s?$/i;
/** Keys whose value is prose or a payload: not searched for a path, at any depth. */
const PROSE_KEY =
  /^(?:body|text|content|contents|message|comment|description|title|note|query|sql|prompt|html|markdown)$/i;
const MAX_PATH_VALUE = 4096;
const MAX_PATH_VALUES = 256;
const GREP_PATH_KEY = /^(path|file_path|notebook_path|directory|root|files|paths)$/i;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EMPTY: CommandClassification = { classes: [], hosts: [], signals: [] };

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  // The separator after the server is the first one. MCP tool names may themselves
  // contain `__`; splitting at the last one would turn `write__file` into `file`
  // and lose the write/side-effect classification.
  const idx = rest.indexOf('__');
  if (idx <= 0 || idx === rest.length - 2) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

function pathOf(toolInput: Readonly<Record<string, unknown>>): string {
  const candidate = toolInput['file_path'] ?? toolInput['notebook_path'] ?? toolInput['path'] ?? '';
  return typeof candidate === 'string' ? candidate : '';
}

function classifyPath(rawPath: string, write: boolean): ToolClassification {
  const path = normalizePathForMatch(rawPath);
  const classes: ActionClass[] = [];
  const signals: string[] = [];
  if (write && SELF_CONFIG_FILE.test(path)) {
    classes.push('config.self');
    signals.push('self-config-write');
  }
  // A Write or Edit is how an agent installs repository-supplied execution without
  // ever running `git config`: the file is plain text and the hook that would notice
  // the command never sees one.
  if (write && isGitExecPath(path)) {
    classes.push('config.git_exec');
    signals.push('git-exec-file');
  }
  if (write && INSTRUCTION_FILE.test(path)) {
    classes.push('config.instructions');
    signals.push('instruction-file-write');
  }
  if (SECRET_PATH.test(path)) {
    classes.push('fs.secrets');
    signals.push('secret-path');
  }
  return { classes, hosts: [], signals };
}

/**
 * Scans path-like keys of `toolInput` (one level deep, plus arrays of
 * strings under such a key) for the protected path. A path mentioned in a
 * non-path key (`body`, `text`, `title`, …) does not count — that is
 * incidental text, not an argument telling the tool where to write.
 */
function pathValues(toolInput: Readonly<Record<string, unknown>>, keyPattern: RegExp): string[] {
  const out: string[] = [];
  collectPaths(toolInput, keyPattern, 0, out);
  return out;
}

/**
 * The values under path-like keys, at the top level and one object down: tools that
 * take an options bag (`{ options: { path } }`) or a list of targets
 * (`{ files: [{ path }] }`) put the path there. A value is a path, so it is cut at
 * `MAX_PATH_VALUE`; and at most `MAX_PATH_VALUES` are collected, so an input with
 * thousands of keys is not thousands of checks.
 */
function collectPaths(value: unknown, keyPattern: RegExp, depth: number, out: string[]): void {
  if (out.length >= MAX_PATH_VALUES || depth > 1 || typeof value !== 'object' || value === null)
    return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, keyPattern, depth + 1, out);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (out.length >= MAX_PATH_VALUES) return;
    if (keyPattern.test(key)) {
      const values = Array.isArray(entry) ? entry : [entry];
      for (const v of values) if (typeof v === 'string') out.push(v.slice(0, MAX_PATH_VALUE));
    } else if (!PROSE_KEY.test(key)) {
      collectPaths(entry, keyPattern, depth + 1, out);
    }
  }
}

function classifyPaths(paths: readonly string[], write: boolean): ToolClassification {
  const results = paths.map((path) => classifyPath(path, write));
  return {
    classes: [...new Set(results.flatMap((result) => result.classes))],
    hosts: [],
    signals: [...new Set(results.flatMap((result) => result.signals))],
  };
}

function classifyMcp(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): ToolClassification {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return EMPTY;
  const sideEffect = SIDE_EFFECT_TOOL.test(mcp.tool);
  const write = isWriteShaped(mcp.tool);
  // Read for every tool, not only the ones whose name says read or write: a credential
  // path in a path-like argument is a credential read however the tool is named. The
  // write classes still need a write-shaped tool.
  const files = classifyPaths(pathValues(toolInput, PATH_LIKE_KEY), write);
  const classes: ActionClass[] = ['mcp.call', ...files.classes];
  if (sideEffect) classes.push('mcp.side_effect');
  const signals: string[] = [...files.signals];
  if (sideEffect) signals.push('mcp-side-effect-name');
  return { classes, hosts: [], signals, mcp };
}

function classifyFetch(toolInput: Readonly<Record<string, unknown>>): ToolClassification {
  const url = typeof toolInput['url'] === 'string' ? toolInput['url'] : '';
  const host = /^https?:\/\/([^/\s:]+)/.exec(url)?.[1];
  return { classes: ['network.fetch'], hosts: host ? [host] : [], signals: ['web-fetch'] };
}

/**
 * Tools that run a shell command from `command`. Claude Code has three: `Bash`,
 * `PowerShell`, and `Monitor`, whose script "runs in the same shell environment as
 * Bash" and streams its output back as notifications. All three are judged by what
 * the command does; `classifyCommand` reads PowerShell syntax as well as POSIX.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor']);
const UNREADABLE_COMMAND: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['shell-command-unreadable'],
};

export function classifyTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput['command'];
    // A shell tool whose command Stroq cannot read is not an empty command: a host
    // that renamed the field would otherwise have every call allowed without a word.
    if (typeof command !== 'string') return UNREADABLE_COMMAND;
    return classifyCommand(command, cwd);
  }
  if (WRITE_TOOLS.has(toolName)) return classifyPath(pathOf(toolInput), true);
  if (toolName === 'Read') return classifyPath(pathOf(toolInput), false);
  if (toolName === 'Grep') return classifyPaths(pathValues(toolInput, GREP_PATH_KEY), false);
  if (toolName === 'WebFetch') return classifyFetch(toolInput);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, toolInput);
  return EMPTY;
}
