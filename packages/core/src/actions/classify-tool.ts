import type { ActionClass } from '../types.js';
import { classifyCommand, type CommandClassification } from './classify-bash.js';
import { isGitExecPath } from './git-exec.js';
import { SELF_CONFIG_FILE } from './self-config.js';

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
const READ_SHAPED_TOOL = /(read|view|search|grep|list|cat)/i;
const PATH_LIKE_KEY = /^(path|filepath|file_path|file|target|dest|destination|uri|url)s?$/i;
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

/**
 * Lexical normalisation before matching, because the patterns below describe paths
 * and the tool argument is a string.
 *
 * `.claude//settings.json` and `.claude/./settings.json` name the file that
 * `.claude/settings.json` names, and every one of those reached the filesystem while
 * only the last was classified. `..` is resolved for the same reason. Case is folded
 * too: macOS and Windows resolve `.CLAUDE/settings.json` to the same file, and on a
 * case-sensitive filesystem folding can only over-match, which is the direction this
 * gate is supposed to err in.
 *
 * A backslash is read as a separator first, because on Windows it is the only one the
 * agent ever sends: `.claude\settings.json` arrived here as a single segment with
 * nothing to collapse and nothing to resolve, so every evasion this function exists
 * to close — the extra slash, the `.`, the `..` — worked there untouched. On POSIX a
 * backslash is a legal filename character, so folding it can only over-match a file
 * somebody named with one, which costs a confirmation rather than opening a hole.
 *
 * Lexical, not `realpath`: resolving on disk would follow symlinks and stat files the
 * agent named, which is both slow on a hot path and a way to be pointed at something.
 * A symlink into a protected directory is therefore still uncovered, and is recorded
 * as a limit rather than implied away.
 */
export function normalizePathForMatch(path: string): string {
  // `/./` first, then the `//` it leaves behind — the other order leaves a double slash.
  const collapsed = path
    .replace(/\\/g, '/')
    .replace(/(^|\/)\.(?=\/)/g, '$1')
    .replace(/\/{2,}/g, '/');
  const segments: string[] = [];
  for (const segment of collapsed.split('/')) {
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/').toLowerCase();
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
  return Object.entries(toolInput).flatMap(([key, value]) => {
    if (!keyPattern.test(key)) return [];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  });
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
  const write = WRITE_SHAPED_TOOL.test(mcp.tool);
  const read = READ_SHAPED_TOOL.test(mcp.tool);
  const paths = write || read ? pathValues(toolInput, PATH_LIKE_KEY) : [];
  const files = classifyPaths(paths, write);
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

export function classifyTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    return classifyCommand(command, cwd);
  }
  if (WRITE_TOOLS.has(toolName)) return classifyPath(pathOf(toolInput), true);
  if (toolName === 'Read') return classifyPath(pathOf(toolInput), false);
  if (toolName === 'Grep') return classifyPaths(pathValues(toolInput, GREP_PATH_KEY), false);
  if (toolName === 'WebFetch') return classifyFetch(toolInput);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, toolInput);
  return EMPTY;
}
