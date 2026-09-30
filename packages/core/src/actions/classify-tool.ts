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
 * `touch`, `chmod`, `modifyFile`, `take_screenshot`, `FSCopy` all wrote a file and none of
 * them was on it.
 *
 * It is still a list, and a tool named with a verb that is not here reads as a tool that
 * only looks. What makes that safe to leave open on the read side is that a credential
 * path is caught whatever the tool is called (see `classifyMcp`), and on the write side
 * that a key which names a DESTINATION (`dst`, `output`, `save_as`) makes its value a
 * write target whatever the tool is called (see `isDestKey`).
 */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'delete',
  'remove',
  'move',
  'rename',
  'append',
  'prepend',
  'put',
  'save',
  'saveas',
  'update',
  'upsert',
  'persist',
  'mkdir',
  'mkfile',
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
  'symlink',
  'ln',
  'download',
  'extract',
  'unzip',
  'untar',
  'unpack',
  'decompress',
  'rm',
  'unlink',
  'rmdir',
  'erase',
  'wipe',
  'purge',
  'screenshot',
  'snapshot',
  'export',
  'dump',
  'store',
  'clone',
  'pdf',
]);
/**
 * Verbs that write only beside a noun that says what: `create_directory`, `create_note`
 * write, `create_issue` and `create_pull_request_review` do not, and a review comment
 * carries a `path` that is merely the file it is about. The same reasoning kept `add`,
 * `set`, `apply`, `link`, `import`, `sync`, `generate`, `make` and `checkout` off the list
 * altogether: each names a file as INPUT as often as it writes one, and a tool that
 * takes a destination has a key that says so (`isDestKey`).
 */
const CREATE_NOUNS: ReadonlySet<string> = new Set([
  'file',
  'files',
  'directory',
  'dir',
  'folder',
  'document',
  'doc',
  'note',
  'text',
]);
/**
 * Words of a name, after a snake-, kebab- or camelCase split that also breaks an acronym
 * from the word after it (`FSCopy` is `fs copy`, `JSONPatch` is `json patch`).
 */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])(?=[A-Z])/g, '$1 ')
    // A lookahead, not a group that runs on: `([A-Z]+)([A-Z][a-z])` was quadratic on a long
    // run of capitals, and a key name is chosen by the agent.
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
const isWriteShaped = (tool: string): boolean => {
  if (WRITE_SHAPED_TOOL.test(tool)) return true;
  const words = wordsOf(tool);
  return (
    words.some((word) => WRITE_WORDS.has(word)) ||
    (words.includes('create') && words.some((word) => CREATE_NOUNS.has(word)))
  );
};

const DEST_WORDS: ReadonlySet<string> = new Set([
  'dst',
  'dest',
  'destination',
  'out',
  'output',
  'outputs',
  'outdir',
  'saveas',
  'saveto',
  'write',
  'save',
  'export',
]);
/**
 * Whether an argument key names where the tool WRITES (`dst`, `output`, `outputPath`,
 * `save_as`, `write_to`, `export_file`, `new_name`). A value under one is a write target
 * even when the tool's own name says nothing about writing: `convert_asset`, `render` and
 * `export` are not verbs anyone lists, and the argument is the more reliable witness.
 */
function isDestKey(key: string): boolean {
  const words = wordsOf(key);
  if (words.some((word) => DEST_WORDS.has(word))) return true;
  return /\bnew (?:name|path|file)\b/.test(words.join(' '));
}

/**
 * The argument keys that tell a tool WHERE to act, by what a tool author would call
 * them: anything ending in path, file, dir, directory or folder, with or without a
 * `name` after it and a digit (`source_path`, `relativePath`, `outputDir`, `file_name`,
 * `path2`), and the short names for a source or a destination. A key that carries prose
 * (`body`, `text`, `title`) is not one, so a path mentioned in a message is still just a
 * message.
 */
const PATH_LIKE_KEY =
  /(?:path|file|dir|directory|folder)(?:[_-]?name)?\d*s?$|^(?:src|source|from|to|dest|destination|dst|out|output|save_?as|save_?to|write_?to|export_?to|new_?(?:name|path)|target|location|uri|url|cwd|root)\d*s?$/i;
/**
 * The short keys that are sometimes a path and sometimes a paragraph (`source` is a file
 * for a copy tool and the code under analysis for a linter). A value under one is read
 * as a path only when it is one line, which a path is and prose seldom is; a value under
 * a key that ENDS in `path` or `file` is read whatever it looks like.
 */
const AMBIGUOUS_KEY = /^(?:src|source|from|to|output|out|target|location)\d*s?$/i;
/** Keys whose value is prose or a payload: not searched for a path, at any depth. */
const PROSE_KEY =
  /^(?:body|text|content|contents|message|comment|description|title|note|query|sql|prompt|html|markdown)$/i;
/**
 * What is read of one call's arguments, and no more, so that an input made of thousands
 * of keys is not thousands of checks. Past any of these the call is reported unreadable
 * (see `scanPaths`), never silently truncated: the agent writes the arguments, and a
 * limit it can fill with decoys is a limit it can use to hide the real path.
 */
const MAX_PATH_VALUES = 4096;
const MAX_PATH_CHARS = 2 * 1024 * 1024;
/**
 * Containers nested deeper than this are not searched. Arrays count as a level as well as
 * objects, or a deep enough array overflows the stack, and a throw is an allow for the
 * tools the hook does not fail closed on.
 */
const MAX_PATH_DEPTH = 6;
/**
 * A key longer than this is not a key: nobody names an argument with a paragraph. One that
 * would otherwise be read as a path key makes the call unreadable, and no work is done on
 * its text.
 */
const MAX_KEY_CHARS = 256;
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
 * A `file:` URI as the path it names, read the way the server that opens it reads it: a
 * URL parser drops tabs and line breaks, the host, the query and the fragment, resolves
 * `.` and `..` segments and treats `%2e` as a dot, and what is left is percent-decoded a
 * run at a time, so one malformed escape cannot leave the rest of the path undecoded.
 */
function fileUriPath(raw: string): string {
  if (!/^file:/i.test(raw)) return raw;
  const cleaned = raw.replace(/[\t\r\n]/g, '');
  let path: string;
  try {
    path = new URL(cleaned).pathname;
  } catch {
    path = cleaned.replace(/^file:(?:\/\/[^/]*)?/i, '').replace(/[?#][\s\S]*$/, '');
  }
  return path.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function classifyPath(rawPath: string, write: boolean): ToolClassification {
  const path = normalizePathForMatch(fileUriPath(rawPath));
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

interface PathEntry {
  readonly path: string;
  /** The value sat under a key that names where the tool writes. */
  readonly dest: boolean;
}

interface PathScan {
  readonly entries: readonly PathEntry[];
  /** False when a limit was reached and some path-like values were not read. */
  readonly complete: boolean;
}

interface ScanState {
  readonly entries: PathEntry[];
  readonly seen: Set<string>;
  chars: number;
  complete: boolean;
}

/**
 * The values under path-like keys of `toolInput`: at the top level, inside an options
 * bag (`{ options: { path } }`), in a list of targets (`{ files: [{ path }] }`) and in an
 * object under a path-like key (`{ output: { path } }`), to `MAX_PATH_DEPTH` objects
 * deep. A path mentioned under a key that carries prose (`body`, `text`, `title`, …)
 * does not count: that is incidental text, not an argument telling the tool where to act.
 *
 * Every value is read IN FULL, because `./` padding, `a/..` pairs and doubled slashes are
 * resolved away by the server, so the protected part of a path can be its tail. Identical
 * values are read once, so a thousand decoys of `x` cost one; a call with more distinct
 * values than `MAX_PATH_VALUES`, or more text than `MAX_PATH_CHARS`, comes back with
 * `complete: false` rather than with what happened to fit.
 */
function scanPaths(toolInput: Readonly<Record<string, unknown>>, keyPattern: RegExp): PathScan {
  const state: ScanState = { entries: [], seen: new Set(), chars: 0, complete: true };
  visit(toolInput, keyPattern, '', false, false, 0, state);
  return { entries: state.entries, complete: state.complete };
}

function visit(
  value: unknown,
  keyPattern: RegExp,
  key: string,
  isPathKey: boolean,
  dest: boolean,
  depth: number,
  state: ScanState,
): void {
  if (typeof value === 'string') {
    if (isPathKey) addPath(value, key, dest, state);
    return;
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_PATH_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, keyPattern, key, isPathKey, dest, depth + 1, state);
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    const childIsPath = keyPattern.test(childKey);
    if (!childIsPath && PROSE_KEY.test(childKey)) continue;
    if (childIsPath && childKey.length > MAX_KEY_CHARS) {
      state.complete = false;
      continue;
    }
    const childDest = dest || (childIsPath && isDestKey(childKey));
    visit(child, keyPattern, childKey, childIsPath, childDest, depth + 1, state);
  }
}

function addPath(value: string, key: string, dest: boolean, state: ScanState): void {
  // A value with a line break under a short key that is sometimes prose is read a line at a
  // time, keeping the lines that could be a path (no whitespace inside): a server that takes
  // a list of files takes them one per line, and one that trims a stray newline still opens
  // the file. Dropping the whole value because it had a break let the agent hide a path by
  // adding one.
  if (/[\r\n]/.test(value) && AMBIGUOUS_KEY.test(key)) {
    for (const line of value.split(/\r\n|\r|\n/)) {
      const path = line.trim();
      if (path !== '' && !/\s/.test(path)) addOne(path, dest, state);
    }
    return;
  }
  addOne(value, dest, state);
}

function addOne(value: string, dest: boolean, state: ScanState): void {
  const id = `${dest ? 'w' : 'r'}\n${value}`;
  if (state.seen.has(id)) return;
  if (state.entries.length >= MAX_PATH_VALUES || state.chars + value.length > MAX_PATH_CHARS) {
    state.complete = false;
    return;
  }
  state.seen.add(id);
  state.chars += value.length;
  state.entries.push({ path: value, dest });
}

function classifyPaths(entries: readonly PathEntry[], write: boolean): ToolClassification {
  const results = entries.map((entry) => classifyPath(entry.path, write || entry.dest));
  return {
    classes: [...new Set(results.flatMap((result) => result.classes))],
    hosts: [],
    signals: [...new Set(results.flatMap((result) => result.signals))],
  };
}

/**
 * A scan that hit a limit is the same kind of answer as a shell command Stroq could not
 * read: not a claim that the call is dangerous, a refusal to claim it is safe. It reuses
 * that class, and the policy that turns it into an `ask`.
 */
const UNREADABLE_ARGUMENTS = {
  classes: ['shell.unparsed'] as const,
  signal: 'mcp-args-unreadable',
};

function classifyGrep(toolInput: Readonly<Record<string, unknown>>): ToolClassification {
  const scan = scanPaths(toolInput, GREP_PATH_KEY);
  const files = classifyPaths(scan.entries, false);
  if (scan.complete) return files;
  return {
    classes: [...files.classes, ...UNREADABLE_ARGUMENTS.classes],
    hosts: [],
    signals: [...files.signals, UNREADABLE_ARGUMENTS.signal],
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
  // write classes still need a write-shaped tool, or a key that names a destination.
  const scan = scanPaths(toolInput, PATH_LIKE_KEY);
  const files = classifyPaths(scan.entries, write);
  const classes: ActionClass[] = ['mcp.call', ...files.classes];
  if (sideEffect) classes.push('mcp.side_effect');
  if (!scan.complete) classes.push(...UNREADABLE_ARGUMENTS.classes);
  const signals: string[] = [...files.signals];
  if (sideEffect) signals.push('mcp-side-effect-name');
  if (!scan.complete) signals.push(UNREADABLE_ARGUMENTS.signal);
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
  if (toolName === 'Grep') return classifyGrep(toolInput);
  if (toolName === 'WebFetch') return classifyFetch(toolInput);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, toolInput);
  return EMPTY;
}
