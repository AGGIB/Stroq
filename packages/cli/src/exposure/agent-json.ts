import { mcpServerRunsCode } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import { boundedJson, digestOf, hit, type AgentHit } from './agent-kinds.js';
import { lineOf } from './jsonc.js';

/**
 * Readers for the JSON configs an agent loads from a repository: hooks in every agent's
 * shape, Claude Code's settings and MCP server lists. Each one takes the parsed file and
 * returns what in it runs by itself. Everything here is written by whoever wrote the
 * repository: keys are read with `Object.hasOwn` only, every value is checked for its type
 * before it is used, and nothing in the file decides how much is read.
 */

export type Obj = Record<string, unknown>;

/** One parsed file: its path, its text with the comments blanked out, and its top object. */
export interface JsonFile {
  readonly path: string;
  readonly text: string;
  readonly value: Obj;
}

export const own = (o: Obj, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
export const ownObject = (o: Obj, key: string): Obj | undefined => {
  const value = own(o, key);
  return isPlainObject(value) ? value : undefined;
};
export const ownString = (o: Obj, key: string): string | undefined => {
  const value = own(o, key);
  return typeof value === 'string' ? value : undefined;
};
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
/** A key or a value as it is spelled in the file, to find its line by. */
export const quoted = (s: string): string => JSON.stringify(s);
const isIndex = (key: string): boolean => /^\d+$/.test(key);

// ---------------------------------------------------------------------------------------------
// Hooks, in every agent's shape.

/** The keys a hook handler names its command or its address by, across the agents. */
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  'command',
  'bash',
  'powershell',
  'commandWindows',
  'url',
]);
/** The most nodes of one hooks value that are walked, and the most hooks that are reported. */
const MAX_HOOK_NODES = 20_000;
export const MAX_HOOKS = 200;
/**
 * The most entries of one list in one file that are reported: servers, tasks, plugins. Each one
 * looks for its line in the file, so 40,000 of them in a megabyte took seconds. Real files have
 * a handful.
 */
export const MAX_ENTRIES = 200;

/**
 * A failing entry for a list cut at its cap. Its value ends with a digest of everything in the
 * list, so an entry added past the cap is still a change.
 */
export const tooMany = (path: string, what: string, max: number, all: unknown): AgentHit =>
  hit(
    'unreadable-config',
    path,
    1,
    `too many ${what}`,
    `more than ${max}, ${digestOf(boundedJson(all))}`,
  );

/** The first `MAX_ENTRIES` of `items`, and the failing entry for the cut when there were more. */
export function firstEntries<T>(
  path: string,
  what: string,
  items: readonly T[],
): { readonly items: readonly T[]; readonly cut: readonly AgentHit[] } {
  if (items.length <= MAX_ENTRIES) return { items, cut: [] };
  return {
    items: items.slice(0, MAX_ENTRIES),
    cut: [tooMany(path, what, MAX_ENTRIES, items)],
  };
}

export interface HookEntry {
  /** The path of keys to the handler, without the array indices. */
  readonly path: readonly string[];
  readonly event: string;
  readonly command: string;
}

/** A command as a string, or a program and its arguments as an array of strings. */
export const commandText = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
      ? value.join(' ')
      : undefined;

/**
 * Every hook command under `value`, in the order of the file, whatever the agent's shape:
 * Claude Code's and Codex's event, group and handler, Cursor's and Windsurf's event and
 * handler, Copilot's `bash` and `powershell`, Antigravity's hook name above the event. The
 * event is the path of keys to the handler with the indices and the word `hooks` left out.
 * Walked with a stack of its own, so a deep file is only slow; `cut` says the caps were hit.
 */
interface Pending {
  readonly node: unknown;
  readonly path: readonly string[];
}

export function hookEntries(value: unknown): { entries: HookEntry[]; cut: boolean } {
  const entries: HookEntry[] = [];
  const stack: Pending[] = [{ node: value, path: [] }];
  let visited = 0;
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    visited += 1;
    if (visited > MAX_HOOK_NODES || entries.length > MAX_HOOKS) return { entries, cut: true };
    const { node, path } = next;
    if (typeof node !== 'object' || node === null) continue;
    const children: Pending[] = [];
    for (const [key, child] of Object.entries(node)) {
      const command = COMMAND_KEYS.has(key) ? commandText(child) : undefined;
      if (command !== undefined) {
        const keys = path.filter((k) => !isIndex(k));
        const event = keys.filter((k) => k.toLowerCase() !== 'hooks').join('.');
        entries.push({ path: keys, event: event === '' ? 'hooks' : event, command });
      } else if (typeof child === 'object' && child !== null) {
        children.push({ node: child, path: [...path, key] });
      }
    }
    // Pushed last to first, so the file's first entry is the next one taken.
    stack.push(...children.reverse());
  }
  return { entries, cut: false };
}

/**
 * The hooks under `value` as hits of `kind`. `prefix` is where `value` sits in the file, as the
 * quoted keys to find its line by: `['"hooks"']` for the `hooks` key of a settings file.
 */
export function hookHits(
  f: { readonly path: string; readonly text: string },
  value: unknown,
  prefix: readonly string[],
  kind: 'agent-hook' | 'agent-definition-hook' = 'agent-hook',
): AgentHit[] {
  if (value === undefined) return [];
  const { entries, cut } = hookEntries(value);
  const hits = entries.slice(0, MAX_HOOKS).map((e) => {
    const needles = [...prefix, ...e.path.map(quoted), quoted(e.command)];
    return hit(kind, f.path, lineOf(f.text, needles), e.event, e.command);
  });
  return cut ? [...hits, tooMany(f.path, 'hooks', MAX_HOOKS, value)] : hits;
}

// ---------------------------------------------------------------------------------------------
// Claude Code's settings (and Copilot's, which take the same keys).

const HELPER_KEYS = [
  'apiKeyHelper',
  'otelHeadersHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
] as const;
const API_BASE_URL = /^ANTHROPIC(?:_[A-Z]+)?_BASE_URL$/;
/**
 * Variables of `env` that make the programs a session starts load code, or connect through
 * someone else, or trust their certificate: `env` is set for every session and every hook, so
 * `NODE_OPTIONS=--require ./x.js` runs x.js the next time anything starts node. Claude Code's
 * own `CLAUDE_CODE_SHELL_PREFIX` wraps every shell command, and `CLAUDE_ENV_FILE` is sourced
 * before each one.
 */
const ENV_LOADS_CODE =
  /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PATH|SHELL|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]{1,40}|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_PAGER|EDITOR|VISUAL|PAGER|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|CLAUDE_CODE_SHELL_PREFIX|CLAUDE_ENV_FILE)$/;
/** An allow rule for the whole shell: `Bash`, or `Bash(...)` whose pattern is only a wildcard. */
const WHOLE_SHELL = /^Bash(?:\((?:\*|:\*|\*\*| \*)\))?$/;

function helperCommands(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  const status = ownObject(f.value, 'statusLine');
  const statusCommand = status === undefined ? undefined : ownString(status, 'command');
  if (statusCommand !== undefined)
    hits.push(
      hit(
        'agent-helper-command',
        f.path,
        lineOf(f.text, ['"statusLine"', '"command"']),
        'statusLine.command',
        statusCommand,
      ),
    );
  for (const key of HELPER_KEYS) {
    const command = ownString(f.value, key);
    if (command !== undefined)
      hits.push(hit('agent-helper-command', f.path, lineOf(f.text, [quoted(key)]), key, command));
  }
  return hits;
}

function envHits(f: JsonFile): AgentHit[] {
  const named = Object.entries(ownObject(f.value, 'env') ?? {}).filter(
    (pair): pair is [string, string] =>
      typeof pair[1] === 'string' && (API_BASE_URL.test(pair[0]) || ENV_LOADS_CODE.test(pair[0])),
  );
  const list = firstEntries(f.path, 'env variables', named);
  return [
    ...list.cut,
    ...list.items.map(([key, value]) =>
      hit(
        API_BASE_URL.test(key) ? 'agent-api-redirect' : 'agent-env',
        f.path,
        lineOf(f.text, ['"env"', quoted(key)]),
        key,
        value,
      ),
    ),
  ];
}

/** Allow rules that hand the agent the whole shell, each spelling listed once. */
function broadAllows(f: JsonFile, permissions: Obj | undefined): AgentHit[] {
  const allow = permissions === undefined ? [] : strings(own(permissions, 'allow'));
  const rules = new Set(allow.map((rule) => rule.trim()).filter((rule) => WHOLE_SHELL.test(rule)));
  return [...rules].map((rule) =>
    hit(
      'agent-broad-allow',
      f.path,
      lineOf(f.text, ['"permissions"', '"allow"', quoted(rule)]),
      'permissions.allow',
      rule,
    ),
  );
}

function settingsSwitches(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [...envHits(f)];
  const permissions = ownObject(f.value, 'permissions');
  hits.push(...broadAllows(f, permissions));
  if (permissions !== undefined && own(permissions, 'defaultMode') === 'bypassPermissions')
    hits.push(
      hit(
        'agent-permission-bypass',
        f.path,
        lineOf(f.text, ['"permissions"', '"defaultMode"']),
        'permissions.defaultMode',
        'bypassPermissions',
      ),
    );
  if (own(f.value, 'enableAllProjectMcpServers') === true)
    hits.push(
      hit(
        'mcp-auto-approve',
        f.path,
        lineOf(f.text, ['"enableAllProjectMcpServers"']),
        'enableAllProjectMcpServers',
        'true',
      ),
    );
  return hits;
}

function pluginHits(f: JsonFile): AgentHit[] {
  const enabled = own(f.value, 'enabledPlugins');
  const on = firstEntries(
    f.path,
    'plugins',
    isPlainObject(enabled)
      ? Object.entries(enabled)
          .filter(([, value]) => value !== false && value !== null)
          .map(([id]) => id)
      : strings(enabled),
  );
  const sources = firstEntries(
    f.path,
    'plugin sources',
    Object.entries(ownObject(f.value, 'extraKnownMarketplaces') ?? {}),
  );
  const hits: AgentHit[] = [...on.cut, ...sources.cut];
  for (const id of on.items)
    hits.push(
      hit(
        'agent-plugin',
        f.path,
        lineOf(f.text, ['"enabledPlugins"', quoted(id)]),
        `enabledPlugins.${id}`,
        id,
      ),
    );
  for (const [name, entry] of sources.items) {
    const source = isPlainObject(entry) && Object.hasOwn(entry, 'source') ? entry['source'] : entry;
    hits.push(
      hit(
        'agent-plugin',
        f.path,
        lineOf(f.text, ['"extraKnownMarketplaces"', quoted(name)]),
        `extraKnownMarketplaces.${name}`,
        boundedJson(source),
      ),
    );
  }
  return hits;
}

export const claudeSettings = (f: JsonFile): AgentHit[] => [
  ...hookHits(f, own(f.value, 'hooks'), ['"hooks"']),
  ...helperCommands(f),
  ...settingsSwitches(f),
  ...pluginHits(f),
];

export const CLAUDE_SETTINGS_KEYS = [
  'hooks',
  'statusLine',
  ...HELPER_KEYS,
  '_BASE_URL',
  '"env"',
  'bypassPermissions',
  'enableAllProjectMcpServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
] as const;

/** A file that is nothing but hooks: Cursor, Codex, Copilot, Antigravity, Windsurf, Devin. */
export const hookFile = (f: JsonFile): AgentHit[] => hookHits(f, f.value, []);

// ---------------------------------------------------------------------------------------------
// MCP servers.

/** The servers under `key` of `container`, which sits at `prefix` in the file. */
export function mcpServerHits(
  f: JsonFile,
  container: Obj | undefined,
  key: string,
  prefix: readonly string[] = [],
): AgentHit[] {
  const servers = container === undefined ? undefined : ownObject(container, key);
  const list = firstEntries(f.path, 'servers', Object.entries(servers ?? {}));
  const hits: AgentHit[] = [...list.cut];
  for (const [name, entry] of list.items) {
    if (!isPlainObject(entry)) continue;
    const line = lineOf(f.text, [...prefix, quoted(key), quoted(name)]);
    const command = ownString(entry, 'command');
    const url = ownString(entry, 'url') ?? ownString(entry, 'httpUrl');
    if (command !== undefined) {
      const args = strings(own(entry, 'args'));
      const kind = mcpServerRunsCode(command, args) ? 'mcp-server-runs-code' : 'mcp-server';
      hits.push(hit(kind, f.path, line, name, [command, ...args].join(' ')));
    } else if (url !== undefined) {
      hits.push(hit('mcp-server', f.path, line, name, url));
    }
  }
  return hits;
}

export const mcpFile = (f: JsonFile): AgentHit[] => [
  ...mcpServerHits(f, f.value, 'mcpServers'),
  ...mcpServerHits(f, f.value, 'servers'),
];

export const geminiSettings = (f: JsonFile): AgentHit[] => [
  ...mcpServerHits(f, f.value, 'mcpServers'),
  ...hookHits(f, own(f.value, 'hooks'), ['"hooks"']),
];
