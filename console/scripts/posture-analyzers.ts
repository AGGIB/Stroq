import { posix } from 'node:path';
import {
  POSTURE_CATALOG,
  type PostureFinding,
  type PostureId,
  type PostureScope,
} from '../lib/posture';

/**
 * Pure checks over the parsed contents of one agent settings file. Each takes what a JSON or TOML
 * parser returned (anything at all) and says which weakening settings it holds. They never throw on
 * odd input, never read inherited properties, and never return a value from the file: only an id, the
 * scope and, for allow lists, how many rules matched.
 */

/** A rule list this long is a mistake or an attack; the count stops here and so does the work. */
const MAX_RULES = 10_000;
const MAX_RULE_CHARS = 512;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An own property only: a value that rides in on the prototype is not a setting. */
function own(value: unknown, key: string): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function at(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = own(current, key);
  return current;
}

const finding = (
  id: PostureId,
  scope: PostureScope,
  count: number | null = null,
): PostureFinding => ({
  id,
  agent: POSTURE_CATALOG[id].agent,
  scope,
  count,
});

const counted = (id: PostureId, scope: PostureScope, n: number): PostureFinding[] =>
  n > 0 ? [finding(id, scope, Math.min(n, MAX_RULES))] : [];

const nonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '';

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= MAX_RULES) break;
    if (typeof item === 'string' && item.length <= MAX_RULE_CHARS) out.push(item.trim());
  }
  return out;
}

/** Programs that run whatever comes after them, or send anything out, so allowing one is allowing everything. */
const OPEN_PROGRAMS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'curl',
  'wget',
  'nc',
  'ncat',
  'ssh',
  'scp',
  'sftp',
  'telnet',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
  'su',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
]);
const PYTHON = /^python[0-9.]*$/;
const CONTAINER_TOOLS = new Set(['docker', 'podman', 'kubectl']);
const CONTAINER_VERBS = new Set(['exec', 'run']);
/** `npm exec`, `pnpm dlx` and the like fetch and run any package. */
const RUNNER_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNER_VERBS = new Set(['exec', 'dlx', 'x']);
/** Programs that start another program, so `timeout 10 bash *` is `bash *`. */
const WRAPPERS = new Set([
  'timeout',
  'nohup',
  'command',
  'nice',
  'time',
  'stdbuf',
  'builtin',
  'setsid',
]);
const WRAPPER_ARGUMENT = /^(?:-[\w-]*|\d+(?:\.\d+)?[smhd]?)$/;

const baseName = (word: string): string =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();

/** What is left of a rule body once its wildcard tail (`*`, `:*`, ` *`, or `*` glued to the program) is cut; null when it has none. */
function withoutWildcardTail(text: string): string | null {
  let end = text.length;
  let star = false;
  while (end > 0) {
    const char = text[end - 1];
    if (char === '*') star = true;
    else if (char !== ':' && char !== ' ' && char !== '\t') break;
    end -= 1;
  }
  return star ? text.slice(0, end) : null;
}

function dropWrappers(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length && i < 4 && WRAPPERS.has(baseName(words[i] as string))) {
    i += 1;
    while (i < words.length && WRAPPER_ARGUMENT.test(words[i] as string)) i += 1;
  }
  return words.slice(i);
}

const isOpenProgram = (word: string): boolean => {
  const name = baseName(word);
  return OPEN_PROGRAMS.has(name) || PYTHON.test(name);
};

/**
 * Words that sit between an open program and the wildcard without naming anything of their own:
 * options (`-c`, `-e`, `-y`, `--`), environment assignments (`env FOO=1 bash`) and another open
 * program (`sudo bash`). A word that names a script or a subcommand makes the rule narrow.
 */
const addsNothing = (word: string): boolean =>
  word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || isOpenProgram(word);

function openProgram(words: readonly string[]): boolean {
  const first = baseName(words[0] as string);
  const second = (words[1] ?? '').toLowerCase();
  if (isOpenProgram(first)) return words.slice(1).every(addsNothing);
  if (words.length === 2 && CONTAINER_TOOLS.has(first) && CONTAINER_VERBS.has(second)) return true;
  if (words.length === 2 && RUNNER_TOOLS.has(first) && RUNNER_VERBS.has(second)) return true;
  return first === 'find' && words[words.length - 1] === '-exec';
}

const matchesAnything = (inner: string): boolean => /^[*:\s]+$/.test(inner);

/**
 * True when a rule lets a program that runs anything run with any arguments: `python *`, `node:*`,
 * `curl*`, `timeout 10 bash *`, `docker exec *`. A rule that names its arguments, such as
 * `node scripts/build.js`, is narrow and is not counted. `bare` is for lists whose entries are
 * prefixes by nature (Cursor and Devin), where a program alone already covers what follows it.
 */
function opensEverything(inner: string, bare: boolean): boolean {
  const body = withoutWildcardTail(inner) ?? (bare ? inner : null);
  if (body === null) return false;
  const words = dropWrappers(body.split(/[\s:]+/).filter((word) => word !== ''));
  return words.length > 0 && openProgram(words);
}

const RULE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/;

interface Rule {
  readonly tool: string;
  /** Null for a rule with no parentheses, which covers the whole tool. */
  readonly inner: string | null;
}

function rulesOf(list: unknown): Rule[] {
  const out: Rule[] = [];
  for (const text of strings(list)) {
    const match = RULE.exec(text);
    if (match !== null) out.push({ tool: match[1] as string, inner: match[2]?.trim() ?? null });
  }
  return out;
}

const anyOf = (rule: Rule): boolean => rule.inner === null || matchesAnything(rule.inner);

// ---------------------------------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json

const CLAUDE_HELPERS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
];
const CLAUDE_REDIRECTS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

export function analyzeClaudeSettings(value: unknown, scope: PostureScope): PostureFinding[] {
  if (!isRecord(value)) return [];
  const out: PostureFinding[] = [];
  const yours = scope !== 'project';

  if (own(value, 'disableAllHooks') === true) out.push(finding('claude-hooks-off', scope));
  // Claude Code's settings reference says current versions ignore bypassPermissions from a project or
  // local file; versions before 2.1.257 honored it. So it is high in your own file and a lower
  // finding, with that caveat, anywhere else.
  if (at(value, 'permissions', 'defaultMode') === 'bypassPermissions')
    out.push(
      finding(scope === 'user' ? 'claude-bypass-permissions' : 'claude-bypass-ignored', scope),
    );
  if (yours && own(value, 'skipDangerousModePermissionPrompt') === true)
    out.push(finding('claude-bypass-accepted', scope));

  const allow = rulesOf(at(value, 'permissions', 'allow'));
  const shell = allow.filter((rule) => rule.tool === 'Bash');
  out.push(...counted('claude-allow-any-shell', scope, shell.filter(anyOf).length));
  out.push(
    ...counted(
      'claude-allow-interpreter',
      scope,
      shell.filter(
        (rule) => !anyOf(rule) && rule.inner !== null && opensEverything(rule.inner, false),
      ).length,
    ),
  );
  out.push(
    ...counted(
      'claude-allow-any-web',
      scope,
      allow.filter(
        (rule) =>
          rule.tool === 'WebFetch' &&
          (rule.inner === null ||
            matchesAnything(rule.inner) ||
            /^domain:[*\s]*$/.test(rule.inner)),
      ).length,
    ),
  );

  if (own(value, 'enableAllProjectMcpServers') === true)
    out.push(finding('claude-all-project-mcp', scope));
  if (scope !== 'user' && CLAUDE_HELPERS.some((key) => nonEmptyString(own(value, key))))
    out.push(finding('claude-repo-helper', scope));
  if (scope !== 'user' && CLAUDE_REDIRECTS.some((key) => nonEmptyString(at(value, 'env', key))))
    out.push(finding('claude-repo-redirect', scope));
  // Said once, about your own file. The caller drops it when another file turns the sandbox on.
  if (scope === 'user' && at(value, 'sandbox', 'enabled') !== true)
    out.push(finding('claude-sandbox-off', scope));
  return out;
}

/** What this Claude Code file says about its sandbox: true, false, or undefined when it says nothing. */
export const claudeSandboxSetting = (value: unknown): boolean | undefined => {
  const enabled = at(value, 'sandbox', 'enabled');
  return typeof enabled === 'boolean' ? enabled : undefined;
};

// ---------------------------------------------------------------------------------------------------
// Codex: ~/.codex/config.toml, .codex/config.toml

export interface CodexContext {
  /** The person's home folder, to tell whether a trusted folder contains it. */
  readonly userHome: string;
}

/** A path with one kind of separator, no `.` or `..` parts and no trailing separator; null for an empty one. */
const slashed = (path: string): string | null => {
  const flat = path
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/');
  if (flat === '') return null;
  const normal = posix.normalize(flat);
  return normal.length > 1 ? normal.replace(/\/+$/, '') || '/' : normal;
};

/** True for a trusted folder that is the home folder or one of its parents, up to the root. */
function coversHome(trusted: string, home: string): boolean {
  const folder = slashed(trusted === '~' ? home : trusted);
  const target = slashed(home);
  if (folder === null || target === null) return false;
  // A drive-letter path is not case sensitive.
  const windows = /^[A-Za-z]:/.test(folder) || /^[A-Za-z]:/.test(target);
  const f = windows ? folder.toLowerCase() : folder;
  const t = windows ? target.toLowerCase() : target;
  if (f === '/') return true;
  return t === f || t.startsWith(`${f}/`);
}

export function analyzeCodexConfig(
  value: unknown,
  scope: PostureScope,
  context: CodexContext,
): PostureFinding[] {
  if (!isRecord(value)) return [];
  const out: PostureFinding[] = [];

  if (at(value, 'features', 'hooks') === false) out.push(finding('codex-hooks-off', scope));

  const approval = own(value, 'approval_policy');
  const noSandbox =
    own(value, 'sandbox_mode') === 'danger-full-access' ||
    own(value, 'default_permissions') === ':danger-full-access';
  if (approval === 'never' && noSandbox) out.push(finding('codex-no-approvals-no-sandbox', scope));
  else if (approval === 'never') out.push(finding('codex-approval-never', scope));
  else if (noSandbox) out.push(finding('codex-sandbox-full-access', scope));
  if (approval === 'untrusted') out.push(finding('codex-approval-retired', scope));
  if (at(value, 'sandbox_workspace_write', 'network_access') === true)
    out.push(finding('codex-network-access', scope));

  // Trust is read only from your own file: a repository cannot trust itself.
  const projects = own(value, 'projects');
  if (scope === 'user' && isRecord(projects)) {
    let seen = 0;
    for (const path of Object.keys(projects)) {
      if (++seen > MAX_RULES) break;
      if (own(projects[path], 'trust_level') === 'trusted' && coversHome(path, context.userHome)) {
        out.push(finding('codex-home-trusted', scope));
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Cursor: cli-config.json / cli.json, sandbox.json, permissions.json

export function analyzeCursorCli(value: unknown, scope: PostureScope): PostureFinding[] {
  if (!isRecord(value)) return [];
  const out: PostureFinding[] = [];
  if (scope === 'user' && own(value, 'approvalMode') === 'unrestricted')
    out.push(finding('cursor-unrestricted', scope));
  const allow = rulesOf(at(value, 'permissions', 'allow'));
  out.push(
    ...counted(
      'cursor-allow-any-shell',
      scope,
      allow.filter(
        (rule) =>
          rule.tool === 'Shell' &&
          (anyOf(rule) || (rule.inner !== null && opensEverything(rule.inner, true))),
      ).length,
    ),
  );
  out.push(
    ...counted(
      'cursor-allow-any-web',
      scope,
      allow.filter((rule) => rule.tool === 'WebFetch' && anyOf(rule)).length,
    ),
  );
  out.push(
    ...counted(
      'cursor-allow-any-mcp',
      scope,
      allow.filter(
        (rule) => rule.tool === 'Mcp' && rule.inner !== null && /^\*(?::\*)?$/.test(rule.inner),
      ).length,
    ),
  );
  return out;
}

export function analyzeCursorSandbox(value: unknown, scope: PostureScope): PostureFinding[] {
  if (!isRecord(value)) return [];
  const out: PostureFinding[] = [];
  if (own(value, 'type') === 'insecure_none') out.push(finding('cursor-sandbox-off', scope));
  if (at(value, 'networkPolicy', 'default') === 'allow')
    out.push(finding('cursor-sandbox-network-open', scope));
  return out;
}

export function analyzeCursorPermissions(value: unknown, scope: PostureScope): PostureFinding[] {
  if (!isRecord(value)) return [];
  const terminal = strings(own(value, 'terminalAllowlist')).filter(
    (entry) => entry === '*' || matchesAnything(entry) || opensEverything(entry, true),
  );
  const mcp = strings(own(value, 'mcpAllowlist')).filter((entry) => /^\*(?::\*)?$/.test(entry));
  return counted('cursor-allowlist-wide', scope, terminal.length + mcp.length);
}

// ---------------------------------------------------------------------------------------------------
// Windsurf / Devin local agent: ~/.config/devin/config.json, .devin/config.json

export function analyzeDevinConfig(value: unknown, scope: PostureScope): PostureFinding[] {
  if (!isRecord(value)) return [];
  const exec = rulesOf(at(value, 'permissions', 'allow')).filter((rule) => rule.tool === 'Exec');
  return counted(
    'windsurf-allow-any-exec',
    scope,
    exec.filter((rule) => anyOf(rule) || (rule.inner !== null && opensEverything(rule.inner, true)))
      .length,
  );
}

// ---------------------------------------------------------------------------------------------------
// JSON with comments and trailing commas, which Cursor and Claude Code files may hold

/**
 * Turns JSON with comments and trailing commas into plain JSON, keeping comment markers that sit inside
 * strings. It does not validate: broken JSON stays broken and `JSON.parse` says so.
 */
export function stripJsonComments(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, Math.min(j + 1, text.length)));
      i = j + 1;
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out.push(' ');
      i = end === -1 ? text.length : end + 2;
    } else {
      out.push(char);
      i += 1;
    }
  }
  return dropTrailingCommas(out.join(''));
}

function dropTrailingCommas(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, Math.min(j + 1, text.length)));
      i = j + 1;
    } else if (char === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      if (text[j] !== '}' && text[j] !== ']') out.push(char);
      i += 1;
    } else {
      out.push(char);
      i += 1;
    }
  }
  return out.join('');
}
