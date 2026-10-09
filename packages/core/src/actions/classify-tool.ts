import type { ActionClass } from '../types.js';
import { classifyCommand, type CommandClassification } from './classify-bash.js';
import { READING_DEADLINE_MS, withDeadline } from './deadline.js';
import { monitorSocket, monitorSocketHost, type MonitorSocket } from './monitor-socket.js';
import { isTooCostly } from './reading-cost.js';
import { splitCommand } from './shell-segments.js';
import { isShellTool } from './shell-tools.js';
import { commandSegments } from './shell-top-level.js';
import {
  agentDefinitionHasHooks,
  isAgentDefinitionPath,
  isMcpConfigPath,
  mcpConfigRunsCode,
} from './agent-config.js';
import {
  editorAutorunText,
  iniRisk,
  isEditorAutorunPath,
  isGitConfigPath,
  isGitExecPath,
  type GitConfigRisk,
} from './git-exec.js';
import {
  commandWrittenFiles,
  isPersistencePath,
  isSshConfigPath,
  sshConfigRunsCommand,
} from './persistence.js';
import { decodePrograms, newBudget } from './shell-input.js';
import { classifyReferencedScripts } from './script-exec.js';
import { resolveThroughLinks } from './symlink.js';
import { commandTexts, writtenTexts } from './written-text.js';
import { decodePercentRuns } from '../normalize/percent-runs.js';
import { normalizePathForMatch } from './normalize-path.js';
import { INSTRUCTION_FILE, SELF_CONFIG_FILE } from './self-config.js';

export { normalizePathForMatch } from './normalize-path.js';

/**
 * What a tool call reaches, read from its arguments, for a task's scope to be held against.
 * Nothing builds one yet: it will be filled when the task lock reads the paths, URLs and
 * shell use of each call.
 */
export interface ToolResources {
  /** The files the call reads or writes, as written, with the path once symlinks are resolved. */
  readonly paths: readonly {
    readonly path: string;
    readonly real?: string;
    readonly op: 'read' | 'write';
  }[];
  /**
   * False when the call may touch paths that `paths` does not list: a glob, a variable, a
   * command too complex to read.
   */
  readonly pathsComplete: boolean;
  /** The network addresses the call reaches, with their hosts. */
  readonly urls: readonly {
    readonly url: string;
    readonly host: string;
    readonly method?: string;
  }[];
  /** Whether the call runs a shell command. */
  readonly shell: boolean;
}

export interface ToolClassification extends CommandClassification {
  readonly mcp?: { readonly server: string; readonly tool: string };
  /**
   * What the call reaches (see `ToolResources`). Not set yet; a classification without it
   * says nothing about resources, not that there are none.
   */
  readonly resources?: ToolResources;
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
  /((^|[/\\])\.ssh([/\\]|$)|\bid_(rsa|ed25519|ecdsa|dsa)\b|(^|[/\\])\.aws([/\\]|$)|(^|[/\\])\.env(?!\.(?:example|sample|template|dist)$)(\.[\w-]+)?$|\.(pem|p12|pfx|key)$|[/\\]\.(npmrc|netrc|pgpass|git-credentials)$|[/\\]\.kube([/\\]config$|$)|[/\\]\.config[/\\]gcloud([/\\]|$)|\/etc\/(shadow|passwd)$)/;
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
 * `path2`; not `profile`, which only ends in the letters), and the short names for a source
 * or a destination. A key that carries prose
 * (`body`, `text`, `title`) is not one, so a path mentioned in a message is still just a
 * message.
 */
const PATH_LIKE_KEY =
  /(?:path|(?<!pro)file|dir|directory|folder)(?:[_-]?name)?\d*s?$|^(?:src|source|from|to|dest|destination|dst|out|output|save_?as|save_?to|write_?to|export_?to|new_?(?:name|path)|target|location|uri|url|cwd|root)\d*s?$/i;
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

/** `value` without control characters and spaces at either end, in one pass. */
function trimControls(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/**
 * The paths a value can name. Ordinarily one: itself. A `file:` URI has more than one
 * reading, and a server takes whichever it takes, so every one is classified: what a URL
 * parser makes of it (host, query and fragment dropped, `.` and `..` resolved, `%2e` a
 * dot), and what is left when `file://` is simply cut off the front, which is how a server
 * that does `uri.replace('file://', '')` opens `file://.claude/settings.json`. Tabs and
 * line breaks are dropped and leading and trailing controls and spaces trimmed first,
 * as a URL parser does, or a space before the scheme hides the whole thing.
 */
function pathCandidates(raw: string): string[] {
  const stripped = trimControls(raw).replace(/[\t\r\n]/g, '');
  if (!/^file:/i.test(stripped)) return [raw];
  const candidates = [stripped];
  try {
    candidates.push(decodePercentRuns(new URL(stripped).pathname));
  } catch {
    // Not a URL a parser accepts; the cut-off reading below is all there is.
  }
  candidates.push(
    decodePercentRuns(stripped.replace(/^file:\/*/i, '').replace(/[?#][\s\S]*$/, '')),
  );
  return [...new Set(candidates)];
}

function classifyPath(rawPath: string, write: boolean): ToolClassification {
  const results = pathCandidates(rawPath).map((path) => classifyOnePath(path, write));
  if (results.length === 1) return results[0] as ToolClassification;
  return {
    classes: [...new Set(results.flatMap((result) => result.classes))],
    hosts: [],
    signals: [...new Set(results.flatMap((result) => result.signals))],
  };
}

function classifyOnePath(rawPath: string, write: boolean): ToolClassification {
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
  // A shell startup file, SSH `authorized_keys`, a scheduler or service directory: a
  // write that something else will run later, as the user.
  if (write && isPersistencePath(rawPath)) {
    classes.push('config.persistence');
    signals.push('persistence-file-write');
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
  /**
   * The value sat under a key nobody said was a path and was read as one because it looks
   * like one. Read only as a read, so it can find a credential and nothing else.
   */
  readonly weak: boolean;
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
  /** Values read only because they look like paths: their own list, budget and dedupe. */
  readonly weakEntries: PathEntry[];
  readonly weakSeen: Set<string>;
  weakChars: number;
}

interface Frame {
  readonly value: unknown;
  readonly key: string;
  readonly isPathKey: boolean;
  readonly dest: boolean;
}

/**
 * The values under path-like keys of `toolInput`, wherever they are nested: in an options
 * bag (`{ options: { path } }`), a list of targets (`{ files: [{ path }] }`), an object under
 * a path-like key (`{ output: { path } }`), or anything deeper. A path mentioned under a
 * key that carries prose (`body`, `text`, `title`, …) does not count: that is incidental
 * text, not an argument telling the tool where to act.
 *
 * With `weak`, a string under any other key, and an object key, is also read when it looks
 * like a path (one line, no whitespace, a separator or a leading dot or tilde), as a read
 * only: tools name their inputs `attachments`, `document`, `image`, `input`, `privateKey`
 * and no list of key names has them all, and a value is what gives a path away.
 *
 * The walk keeps its own stack, not the call stack, so a nesting the agent chooses cannot
 * overflow it (a throw is an allow for the tools the hook does not fail closed on) and
 * there is no depth to nest past. Every value is read IN FULL, because `./` padding, `a/..`
 * pairs and doubled slashes are resolved away by the server, so the protected part of a
 * path can be its tail. Identical values are read once, so a thousand decoys of `x` cost
 * one; a call with more distinct path values than `MAX_PATH_VALUES`, or more text than
 * `MAX_PATH_CHARS`, comes back with `complete: false` rather than with what happened to
 * fit. A value read only because it looks like a path never does that: it is best effort.
 */
function scanPaths(
  toolInput: Readonly<Record<string, unknown>>,
  keyPattern: RegExp,
  weak: boolean,
): PathScan {
  const state: ScanState = {
    entries: [],
    seen: new Set(),
    chars: 0,
    complete: true,
    weakEntries: [],
    weakSeen: new Set(),
    weakChars: 0,
  };
  const stack: Frame[] = [{ value: toolInput, key: '', isPathKey: false, dest: false }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value } = frame;
    if (typeof value === 'string') {
      if (frame.isPathKey) addPath(value, frame.key, frame.dest, state);
      else if (weak) addWeak(value, state);
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push({ ...frame, value: value[i] });
      continue;
    }
    const children: Frame[] = [];
    for (const [childKey, child] of Object.entries(value)) {
      const childIsPath = keyPattern.test(childKey);
      if (!childIsPath && PROSE_KEY.test(childKey)) continue;
      if (childIsPath && childKey.length > MAX_KEY_CHARS) {
        state.complete = false;
        continue;
      }
      if (!childIsPath && weak) addWeak(childKey, state);
      children.push({
        value: child,
        key: childKey,
        isPathKey: childIsPath,
        dest: frame.dest || (childIsPath && isDestKey(childKey)),
      });
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as Frame);
  }
  // The named keys first, so what they hold is classified whatever else was found.
  return { entries: [...state.entries, ...state.weakEntries], complete: state.complete };
}

/** A link is not a file the tool opens; `file:` is the one scheme that is. */
const LINK_SCHEME = /^(?:https?|ftp|wss?|data|blob):/i;
/**
 * Whether `value` is a link and not a path. Judged after `.` and `..` are resolved, because
 * `http:/../.claude/settings.json` starts like a link and is `.claude/settings.json` to a
 * server that resolves paths before it opens them.
 */
const isLink = (value: string): boolean =>
  LINK_SCHEME.test(value) && LINK_SCHEME.test(normalizePathForMatch(value));

/** What a value under an unnamed key must look like to be read as a path at all. */
const WEAK_PATH_CHARS = 1024;
/** Glob, selector, accessor and query characters: a pattern, not a path. */
const NOT_PATH_CHARS = /[\s*?[\]{}<>|()$^"'`;,=]/;
const looksLikePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= WEAK_PATH_CHARS &&
  /[\\/]/.test(value) &&
  !NOT_PATH_CHARS.test(value) &&
  !isLink(value);

/** Values read only because they look like paths are best effort: never a reason to give up. */
const MAX_WEAK_VALUES = 512;
const MAX_WEAK_CHARS = 256 * 1024;

function addWeak(value: string, state: ScanState): void {
  if (!looksLikePath(value)) return;
  if (state.weakSeen.has(value)) return;
  if (
    state.weakEntries.length >= MAX_WEAK_VALUES ||
    state.weakChars + value.length > MAX_WEAK_CHARS
  )
    return;
  state.weakSeen.add(value);
  state.weakChars += value.length;
  state.weakEntries.push({ path: value, dest: false, weak: true });
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
  // `url` and `uri` are path keys for the sake of `file:` URIs; an ordinary link under one
  // is not a file, and `https://github.com/o/r/blob/main/.env.example` is not a read of it.
  if (isLink(value)) return;
  const id = `${dest ? 'w' : 'r'}\n${value}`;
  if (state.seen.has(id)) return;
  if (state.entries.length >= MAX_PATH_VALUES || state.chars + value.length > MAX_PATH_CHARS) {
    state.complete = false;
    return;
  }
  state.seen.add(id);
  state.chars += value.length;
  state.entries.push({ path: value, dest, weak: false });
}

const NONE: ToolClassification = { classes: [], hosts: [], signals: [] };

function mergeClassifications(...items: readonly ToolClassification[]): ToolClassification {
  const mcp = items.find((item) => item.mcp !== undefined)?.mcp;
  const scripts = items.flatMap((item) => item.scripts ?? []);
  return {
    classes: [...new Set(items.flatMap((item) => item.classes))],
    hosts: [...new Set(items.flatMap((item) => item.hosts))],
    signals: [...new Set(items.flatMap((item) => item.signals))],
    ...(mcp === undefined ? {} : { mcp }),
    ...(scripts.length === 0 ? {} : { scripts }),
  };
}

/**
 * What the TEXT written to `path` is, beyond where it goes: git configuration that runs a
 * command, an editor task that runs on opening the folder, an SSH client configuration
 * that runs a program, an MCP server that starts a shell, an agent definition with hooks.
 * The path rules cannot see these, and the pages that steer an agent into writing them
 * are the ones the scan calls clean.
 *
 * Each string a write carries is read on its own: joined, a harmless `description` beside
 * the content diluted a config that was otherwise recognised.
 */
function classifyWrittenText(path: string, facts: WrittenTextFacts | null): ToolClassification {
  if (facts === null) return NONE;
  const { bodies } = facts;
  const classes: ActionClass[] = [];
  const signals: string[] = [];
  const found = (test: (body: string) => boolean): boolean => bodies.some(test);
  if (facts.gitConfig !== null && isGitConfigPath(path)) {
    if (facts.gitConfig === 'exec') {
      classes.push('config.git_exec');
      signals.push('git-exec-config-text');
    } else {
      classes.push('config.persistence');
      signals.push(
        facts.gitConfig === 'unread' ? 'git-config-text-unread' : 'git-config-runs-program',
      );
    }
  }
  // The path is asked first: a call can name thousands of paths and carry thousands of
  // strings, and only a file of one of these kinds is read for its text.
  if (isEditorAutorunPath(path) && found((body) => editorAutorunText(path, body))) {
    classes.push('config.persistence');
    signals.push('editor-autorun-task');
  }
  if (isSshConfigPath(path) && found((body) => sshConfigRunsCommand(path, body))) {
    classes.push('config.persistence');
    signals.push('ssh-config-command');
  }
  if (isMcpConfigPath(path) && found((body) => mcpConfigRunsCode(path, body))) {
    classes.push('config.instructions_payload');
    signals.push('mcp-config-runs-code');
  }
  if (isAgentDefinitionPath(path) && found((body) => agentDefinitionHasHooks(path, body))) {
    classes.push('config.instructions_payload');
    signals.push('agent-definition-hooks');
  }
  return { classes, hosts: [], signals };
}

/**
 * What about the written texts does not depend on where they are written, worked out once:
 * a call can name thousands of paths, and the text is the same for each. Null for no text.
 */
interface WrittenTextFacts {
  readonly bodies: readonly string[];
  readonly gitConfig: GitConfigRisk;
}

const GIT_RISK_ORDER: readonly GitConfigRisk[] = ['exec', 'program', 'unread'];

function writtenTextFacts(texts: readonly string[]): WrittenTextFacts | null {
  const bodies = texts.filter((text) => text !== '');
  if (bodies.length === 0) return null;
  const risks = new Set(bodies.map(iniRisk));
  const gitConfig = GIT_RISK_ORDER.find((risk) => risks.has(risk)) ?? null;
  return { bodies, gitConfig };
}

/**
 * A file tool's path judged as written, as read through any symlink on the way, and by
 * what is being written to it. The literal spelling and the real target are both
 * classified: an agent shown `project_settings.json` is writing `~/.ssh/authorized_keys`.
 */
function classifyFilePath(
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
  write: boolean,
): ToolClassification {
  const path = pathOf(toolInput);
  // The text without the path: it is among the strings a write carries, and a line of
  // path in front of a config file is a line that is not config.
  const facts = writtenTextFacts(write ? writtenTexts(toolInput).filter((t) => t !== path) : []);
  const literal = mergeClassifications(classifyPath(path, write), classifyWrittenText(path, facts));
  const real = resolveThroughLinks(path, cwd);
  if (real === null) return literal;
  const through = mergeClassifications(classifyPath(real, write), classifyWrittenText(real, facts));
  const added = through.classes.filter((cls) => !literal.classes.includes(cls));
  return mergeClassifications(
    literal,
    through,
    added.length > 0 ? { classes: [], hosts: [], signals: ['via-symlink'] } : NONE,
  );
}

/**
 * What a shell command writes into a file whose contents are the point: the command is
 * its own text (a heredoc body is its lines) and so is each quoted string in it, so
 * `cat > .mcp.json <<EOF …` and `echo '[core] fsmonitor = x' > .alt/config` are read as
 * the `Write` of the same text would be.
 */
function classifyCommandWrites(
  command: string,
  segments: readonly string[],
  cwd: string,
): ToolClassification {
  const files = commandWrittenFiles(segments, cwd);
  if (files.length === 0) return NONE;
  const facts = writtenTextFacts(commandTexts(command));
  return mergeClassifications(...files.map((file) => classifyWrittenText(file, facts)));
}

function classifyPaths(entries: readonly PathEntry[], write: boolean): ToolClassification {
  const results = entries.map((entry) =>
    classifyPath(entry.path, !entry.weak && (write || entry.dest)),
  );
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
  const scan = scanPaths(toolInput, GREP_PATH_KEY, false);
  const files = classifyPaths(scan.entries, false);
  if (scan.complete) return files;
  return {
    classes: [...files.classes, ...UNREADABLE_ARGUMENTS.classes],
    hosts: [],
    signals: [...files.signals, UNREADABLE_ARGUMENTS.signal],
  };
}

/** The most paths of one call that are resolved on disk for links: each is a system call. */
/**
 * The most paths of one call that are resolved on disk for links. A file tool names one
 * or a few; past this many the call is reported as not fully read, rather than
 * leaving the paths after the limit unchecked for a decoy to hide behind.
 */
const MAX_LINK_CHECKS = 64;

function classifyMcp(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return EMPTY;
  const sideEffect = SIDE_EFFECT_TOOL.test(mcp.tool);
  const write = isWriteShaped(mcp.tool);
  // Read for every tool, not only the ones whose name says read or write: a credential
  // path in a path-like argument is a credential read however the tool is named. The
  // write classes still need a write-shaped tool, or a key that names a destination.
  const scan = scanPaths(toolInput, PATH_LIKE_KEY, true);
  const files = classifyPaths(scan.entries, write);
  const written = scan.entries.filter((entry) => !entry.weak && (write || entry.dest));
  // The text without the paths: they are among the strings a call carries, and they are
  // not config lines.
  const pathStrings = new Set(scan.entries.map((entry) => entry.path));
  const facts = writtenTextFacts(
    write || scan.entries.some((e) => e.dest)
      ? writtenTexts(toolInput).filter((t) => !pathStrings.has(t))
      : [],
  );
  const literalContent = mergeClassifications(
    ...written.map((entry) => classifyWrittenText(entry.path, facts)),
  );
  // Where a path really goes, read or written: a link named like a settings file or a note
  // is a write to, or a read of, its target. Counted only for what it adds to what the
  // spelled paths already raised.
  const known = new Set<ActionClass>([...files.classes, ...literalContent.classes]);
  const named = scan.entries.filter((entry) => !entry.weak);
  const through = named.slice(0, MAX_LINK_CHECKS).map((entry) => {
    const real = resolveThroughLinks(entry.path, cwd);
    if (real === null) return NONE;
    const writes = write || entry.dest;
    const resolved = mergeClassifications(
      classifyPath(real, writes),
      writes ? classifyWrittenText(real, facts) : NONE,
    );
    return resolved.classes.some((cls) => !known.has(cls))
      ? mergeClassifications(resolved, { classes: [], hosts: [], signals: ['via-symlink'] })
      : NONE;
  });
  const unchecked: ToolClassification =
    named.length > MAX_LINK_CHECKS
      ? {
          classes: [...UNREADABLE_ARGUMENTS.classes],
          hosts: [],
          signals: ['mcp-links-unchecked'],
        }
      : NONE;
  const content = mergeClassifications(literalContent, ...through, unchecked);
  const classes: ActionClass[] = [
    'mcp.call',
    ...new Set<ActionClass>([...files.classes, ...content.classes]),
  ];
  if (sideEffect) classes.push('mcp.side_effect');
  if (!scan.complete) classes.push(...UNREADABLE_ARGUMENTS.classes);
  const signals: string[] = [...files.signals, ...content.signals];
  if (sideEffect) signals.push('mcp-side-effect-name');
  if (!scan.complete) signals.push(UNREADABLE_ARGUMENTS.signal);
  return { classes, hosts: [], signals, mcp };
}

function classifyFetch(toolInput: Readonly<Record<string, unknown>>): ToolClassification {
  const url = typeof toolInput['url'] === 'string' ? toolInput['url'] : '';
  const host = /^https?:\/\/([^/\s:]+)/.exec(url)?.[1];
  return { classes: ['network.fetch'], hosts: host ? [host] : [], signals: ['web-fetch'] };
}

// A tool that runs a shell command (see `shell-tools.ts`) is judged by what the command
// does; `classifyCommand` reads PowerShell syntax as well as POSIX.
const UNREADABLE_COMMAND: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['shell-command-unreadable'],
};

const COMMAND_TOO_LARGE: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['command-too-large'],
};

/**
 * Monitor's WebSocket mode (see `monitor-socket.ts`) has no command to read, but it is not
 * nothing: it is an outbound connection to an address the model chose. It is network-shaped
 * so that the secret guard, which runs on those alone, looks inside it, and a tainted
 * session is denied it. It keeps the class of a command Stroq could not read, so it is still
 * asked about as it was: this only adds, and no session is allowed more than it was.
 */
function classifySocket(socket: MonitorSocket): ToolClassification {
  const host = monitorSocketHost(socket.url);
  return {
    classes: ['shell.network', ...UNREADABLE_COMMAND.classes],
    hosts: host === null ? [] : [host],
    signals: [...UNREADABLE_COMMAND.signals, 'monitor-websocket'],
  };
}

/** The reading of the command went on past the clock (see `deadline.ts`): it is asked about, not read. */
const READING_TOOK_TOO_LONG: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['reading-took-too-long'],
};

export function classifyTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  if (isShellTool(toolName)) {
    const command = toolInput['command'];
    // A shell tool whose command Stroq cannot read is not an empty command: a host
    // that renamed the field would otherwise have every call allowed without a word.
    if (typeof command !== 'string') {
      const socket = toolName === 'Monitor' ? monitorSocket(toolInput) : null;
      return socket === null ? UNREADABLE_COMMAND : classifySocket(socket);
    }
    if (isTooCostly(command)) return COMMAND_TOO_LARGE;
    // All of what follows is one reading, and the clock runs from its first step: the split and the decoding
    // of the programs are made here, before `classifyCommand` begins its own, and are most of the work.
    return withDeadline(
      READING_DEADLINE_MS,
      () => classifyShellCommand(command, cwd),
      () => READING_TOOK_TOO_LONG,
    );
  }
  if (WRITE_TOOLS.has(toolName)) return classifyFilePath(toolInput, cwd, true);
  if (toolName === 'Read') return classifyFilePath(toolInput, cwd, false);
  if (toolName === 'Grep') return classifyGrep(toolInput);
  if (toolName === 'WebFetch') return classifyFetch(toolInput);
  if (toolName.startsWith('mcp__')) return classifyMcp(toolName, toolInput, cwd);
  return EMPTY;
}

function classifyShellCommand(command: string, cwd: string): ToolClassification {
  // The programs the shells in it are handed on standard input (`echo X | bash`), at every
  // level of nesting and within one budget: read once, for the classes and for the scripts.
  const split = splitCommand(command);
  const budget = newBudget(command.length);
  const decoded = decodePrograms(command, budget, split);
  const typed = classifyCommand(command, cwd, 0, { decoded, budget, split });
  // Cut where the shell cuts: a segment cut out of a quoted string runs nothing
  // (`grep "x\|PIN=" deploy.sh`), and a quoted `|` does not take a file from its command.
  // The programs decoded from it run commands too, and one of them may name a script.
  const segments = [
    ...commandSegments(command, split),
    ...decoded.texts.flatMap((text) => commandSegments(text, splitCommand(text, null))),
  ];
  // A script the command runs is read as the commands it contains: the hook sees
  // `bash cleanup.sh`, and what that deletes is in the file (see `script-exec.ts`).
  const scriptTexts: string[] = [];
  const scripts = classifyReferencedScripts(segments, cwd, scriptTexts, decoded.files);
  return mergeClassifications(
    typed,
    ...(scripts === null ? [] : [scripts]),
    classifyCommandWrites(command, segments, cwd),
    ...(scriptTexts.length === 0
      ? []
      : [{ classes: [], hosts: [], signals: [], scripts: scriptTexts }]),
  );
}
