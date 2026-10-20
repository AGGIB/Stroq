import { mcpServerRunsCode } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import { boundedJson, digestOf, hit, otherFields, type AgentHit } from './agent-kinds.js';
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
  /** The key the command was found under: `command`, `bash`, `powershell`... */
  readonly key: string;
  readonly command: string;
  /** The command and the handler's other fields that decide how it runs: the value to compare. */
  readonly runs: string;
}

/**
 * Fields of a handler that change when or how long it runs, or what it is called, and not what
 * it runs. Any other field (`cwd`, `env`, `shell`, `working_directory`, `enabled`) is part of
 * what runs.
 */
const HANDLER_LABELS: ReadonlySet<string> = new Set([
  'type',
  'timeout',
  'timeoutSec',
  'timeout_ms',
  'timeoutMs',
  'name',
  'description',
  'comment',
  'statusMessage',
  'show_output',
  'matcher',
  'async',
  'once',
  'padding',
]);
const isHandlerLabel = (key: string): boolean => COMMAND_KEYS.has(key) || HANDLER_LABELS.has(key);

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
/** A key on the way to a node, and the one before it: the path is spelled out only for a hook. */
interface PathNode {
  readonly key: string;
  readonly up: PathNode | undefined;
}
interface Pending {
  readonly node: unknown;
  readonly at: PathNode | undefined;
}

const keysOf = (at: PathNode | undefined): string[] => {
  const keys: string[] = [];
  for (let n = at; n !== undefined; n = n.up) keys.push(n.key);
  return keys.reverse();
};

export function hookEntries(
  value: unknown,
  commandKeys: ReadonlySet<string> = COMMAND_KEYS,
  findOpaque = false,
): { entries: HookEntry[]; cut: boolean; opaque: unknown[] } {
  const entries: HookEntry[] = [];
  const opaque: unknown[] = [];
  const stack: Pending[] = [{ node: value, at: undefined }];
  let visited = 0;
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    visited += 1;
    if (visited > MAX_HOOK_NODES || entries.length > MAX_HOOKS)
      return { entries, cut: true, opaque };
    const { node, at } = next;
    if (typeof node !== 'object' || node === null) continue;
    const children: Pending[] = [];
    for (const [key, child] of Object.entries(node)) {
      const command = commandKeys.has(key) ? commandText(child) : undefined;
      if (command !== undefined) {
        const keys = keysOf(at).filter((k) => !isIndex(k));
        const event = keys.filter((k) => k.toLowerCase() !== 'hooks').join('.');
        const runs = `${command}${otherFields(node as Obj, isHandlerLabel)}`;
        entries.push({ path: keys, event: event === '' ? 'hooks' : event, key, command, runs });
      } else if (typeof child === 'object' && child !== null) {
        children.push({ node: child, at: { key, up: at } });
      }
    }
    // Pushed last to first, so the file's first entry is the next one taken.
    stack.push(...children.reverse());
  }
  return { entries, cut: false, opaque: findOpaque ? opaqueNodes(value, commandKeys) : opaque };
}

/** Whether an object names a command by one of `keys`: a handler this reads. */
const namesCommand = (node: Obj, keys: ReadonlySet<string>): boolean =>
  Object.entries(node).some(([key, child]) => keys.has(key) && commandText(child) !== undefined);

/**
 * The handlers under a hooks value with no command key this reads. Every object is a handler
 * unless it is a container: the hooks value itself (the event map), a list, a group whose own
 * `hooks` key holds the handlers, or a map whose values are all lists or maps (a hook name above
 * its events). A handler that names a command is read, with all its fields; one that does not
 * fails, whatever fields it has. A hooks value with a `then` (Kiro's one hook to a file) is one
 * handler, read by what its `then` names. Walked with a stack of its own, to a bound.
 */
function opaqueNodes(value: unknown, keys: ReadonlySet<string>): unknown[] {
  const opaque: unknown[] = [];
  if (isPlainObject(value) && Object.hasOwn(value, 'then')) {
    const then = value['then'];
    if (!(isPlainObject(then) && namesCommand(then, keys))) opaque.push(value);
    return opaque;
  }
  const stack: { node: unknown; root: boolean }[] = [{ node: value, root: true }];
  let visited = 0;
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    visited += 1;
    if (visited > MAX_HOOK_NODES) break;
    const { node, root } = next;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, root: false });
      continue;
    }
    if (!isPlainObject(node)) continue;
    const group = Object.hasOwn(node, 'hooks') && typeof node['hooks'] === 'object';
    if (group && !root) {
      stack.push({ node: node['hooks'], root: false });
      continue;
    }
    if (namesCommand(node, keys)) continue;
    const values = Object.values(node);
    const container = root || values.every((v) => typeof v === 'object' && v !== null);
    if (container) for (const child of values) stack.push({ node: child, root: false });
    else opaque.push(node);
  }
  return opaque;
}

/** A failing entry for each handler with no command this reads, with a digest of what it holds. */
export const opaqueHandlers = (
  path: string,
  line: number,
  opaque: readonly unknown[],
): AgentHit[] =>
  opaque.map((node) =>
    hit(
      'unreadable-config',
      path,
      line,
      HOOK_NOT_READ,
      `a hook handler with no command this reads, which may hand text or a tool call to the agent (${digestOf(boundedJson(node, undefined, true))})`,
    ),
  );

/** What a failing entry for such a handler is named. */
export const HOOK_NOT_READ = 'hook not read';

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
  const { entries, cut, opaque } = hookEntries(value, COMMAND_KEYS, true);
  const hits = entries.slice(0, MAX_HOOKS).map((e) => {
    const needles = [...prefix, ...e.path.map(quoted), quoted(e.command)];
    return hit(kind, f.path, lineOf(f.text, needles), e.event, e.runs);
  });
  const unread = opaqueHandlers(f.path, lineOf(f.text, prefix), opaque);
  return cut
    ? [...hits, ...unread, tooMany(f.path, 'hooks', MAX_HOOKS, value)]
    : [...hits, ...unread];
}

// ---------------------------------------------------------------------------------------------
// Claude Code's settings (and Copilot's, which take the same keys).

/** Top-level keys whose string Claude Code runs as a command. */
const HELPER_KEYS = [
  'apiKeyHelper',
  'otelHeadersHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
] as const;
/** A top-level key named as those are, so a helper a later version adds is read as one too. */
const HELPER_NAME = /^[A-Za-z]{0,64}(?:Helper|AuthRefresh|CredentialExport|Command)$/;
/** The keys under which a settings value holds a command; `url` is an address, not one. */
const SETTINGS_COMMAND_KEYS: ReadonlySet<string> = new Set([
  'command',
  'bash',
  'powershell',
  'commandWindows',
]);
/** Top-level keys read on their own below, and so left out of the walk for commands. */
const READ_APART: ReadonlySet<string> = new Set([
  'hooks',
  'env',
  'permissions',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
]);
const API_BASE_URL = /^ANTHROPIC(?:_[A-Z]+)?_BASE_URL$/;
/**
 * Variables of `env` known to make the programs a session starts load code, or connect through
 * someone else, or trust their certificate: `env` is set for every session and every hook, so
 * `NODE_OPTIONS=--require ./x.js` runs x.js the next time anything starts node. Claude Code's
 * own `CLAUDE_CODE_SHELL_PREFIX` wraps every shell command, and `CLAUDE_ENV_FILE` is sourced
 * before each one. Git takes any setting from `GIT_CONFIG_PARAMETERS`, `core.fsmonitor`
 * included, and runs it on the next `git status`. This list only words the report: every name
 * that is not in `BENIGN_ENV` is reported, since a list of the dangerous ones always misses one.
 */
const ENV_LOADS_CODE =
  /^(?:NODE_[A-Z_]{1,40}|BASH_ENV|BASH_FUNC_[^=]{1,256}|ENV|ZDOTDIR|PROMPT_COMMAND|PATH|SHELL|HOME|XDG_[A-Z_]{1,40}|LD_[A-Z_]{1,40}|DYLD_[A-Z_]{1,40}|PYTHON[A-Z_]{1,40}|PERL5[A-Z_]{1,40}|RUBY[A-Z_]{1,40}|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_[A-Z_]{1,40}|SSH_[A-Z_]{1,40}|EDITOR|VISUAL|PAGER|(?:NPM|npm|YARN|yarn|PNPM|pnpm|BUN|bun)_[A-Za-z_]{1,64}|GO[A-Z_]{1,40}|CARGO[A-Z_]{0,40}|RUSTC[A-Z_]{0,40}|RUSTFLAGS|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|OTEL_[A-Z_]{1,64}|AWS_[A-Z_]{1,64}|CLAUDE_[A-Z_]{1,64})$/;
/**
 * The only variables `env` may set without a report, in any letter case: a short, explicit list
 * of common names that change no program a session starts, what it loads, or where it sends
 * anything. Every other name is an error, with a base and without one: a list of the dangerous
 * ones always misses one, and a longer list of harmless ones is a longer claim to prove.
 */
const BENIGN_ENV: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'TZ',
  'LANG',
  'LC_ALL',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
]);
/** Whether a variable is one of the few that `env` may set without a report. */
export const isHarmlessEnv = (name: string): boolean => BENIGN_ENV.has(name.toUpperCase());
/**
 * Whether a variable is one of those known to load code or send traffic elsewhere, in any letter
 * case: Windows reads `node_options` as `NODE_OPTIONS`, and which system opens the repository is
 * not known.
 */
export const envLoadsCode = (name: string): boolean =>
  ENV_LOADS_CODE.test(name) || ENV_LOADS_CODE.test(name.toUpperCase());
/** Where Codex's `config.toml` sets a variable for every command: an env hit's name starts so. */
export const CODEX_ENV_PREFIX = 'shell_environment_policy.set.';
/** The variable an env hit sets: its name, without the keys of the table it is in. */
export const envNameOf = (name: string): string =>
  name.startsWith(CODEX_ENV_PREFIX) ? name.slice(CODEX_ENV_PREFIX.length) : name;
/** The top-level keys named as helpers are, whose string Claude Code runs. */
function helperKeys(f: JsonFile): AgentHit[] {
  const named = Object.entries(f.value).filter(
    (pair): pair is [string, string] =>
      typeof pair[1] === 'string' &&
      ((HELPER_KEYS as readonly string[]).includes(pair[0]) || HELPER_NAME.test(pair[0])),
  );
  const list = firstEntries(f.path, 'helper commands', named);
  return [
    ...list.cut,
    ...list.items.map(([key, command]) =>
      hit('agent-helper-command', f.path, lineOf(f.text, [quoted(key)]), key, command),
    ),
  ];
}

/**
 * Every command anywhere else in the settings: `statusLine`, `fileSuggestion`, and whatever key a
 * later version gives a `{ "type": "command", "command": ... }`. Named by their path of keys.
 */
function helperCommands(f: JsonFile): AgentHit[] {
  const rest = Object.fromEntries(Object.entries(f.value).filter(([key]) => !READ_APART.has(key)));
  const { entries, cut } = hookEntries(rest, SETTINGS_COMMAND_KEYS);
  const walked = entries.slice(0, MAX_HOOKS).map((e) => {
    const needles = [...e.path.map(quoted), quoted(e.key)];
    const name = [...e.path, e.key].join('.');
    return hit('agent-helper-command', f.path, lineOf(f.text, needles), name, e.runs);
  });
  // In the order of the file's keys, for hits that share a line.
  const order = new Map(Object.keys(f.value).map((key, i) => [key, i]));
  const at = (h: AgentHit): number => order.get(h.name.split('.')[0] as string) ?? 0;
  const hits = [...helperKeys(f), ...walked]
    .map((h, i) => [h, i] as const)
    .sort(([a, i], [b, j]) => at(a) - at(b) || i - j)
    .map(([h]) => h);
  return cut ? [...hits, tooMany(f.path, 'helper commands', MAX_HOOKS, rest)] : hits;
}

/** Every variable of `env` but the few known to be harmless, whatever its value's type. */
function envHits(f: JsonFile): AgentHit[] {
  const named = Object.entries(ownObject(f.value, 'env') ?? {}).filter(
    ([key]) => !isHarmlessEnv(key),
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
        typeof value === 'string' ? value : boundedJson(value),
      ),
    ),
  ];
}

/** Each server of `.mcp.json` that `enabledMcpjsonServers` starts without asking. */
function approvedServers(f: JsonFile): AgentHit[] {
  const list = firstEntries(
    f.path,
    'approved servers',
    strings(own(f.value, 'enabledMcpjsonServers')),
  );
  return [
    ...list.cut,
    ...list.items.map((name) =>
      hit(
        'mcp-auto-approve',
        f.path,
        lineOf(f.text, ['"enabledMcpjsonServers"', quoted(name)]),
        'enabledMcpjsonServers',
        name,
      ),
    ),
  ];
}

/**
 * The rules of an allow list as a host may read them: each string, trimmed, and anything else as
 * JSON, since what the host makes of it is not known. A value that is not a list is one rule.
 */
export function ruleList(value: unknown): string[] {
  if (value === undefined) return [];
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  return items.map((item) => (typeof item === 'string' ? item.trim() : boundedJson(item)));
}

/**
 * Every rule of an allow list, each spelling once, at most `MAX_ENTRIES` of them: past that, one
 * failing entry stands for the rest. Which rules are harmless is not worked out: a change that
 * adds or edits any of them fails, and one already there is listed.
 */
export function allowRuleHits(
  f: { readonly path: string; readonly text: string },
  rules: readonly string[],
  name: string,
  line: (rule: string) => number,
): AgentHit[] {
  const list = firstEntries(f.path, 'allow rules', [...new Set(rules)]);
  return [
    ...list.cut,
    ...list.items.map((rule) => hit('agent-broad-allow', f.path, line(rule), name, rule)),
  ];
}

/** Modes that ask at least as often as the default: listed. Any other asks less, or is not known. */
const ASKING_MODES: ReadonlySet<unknown> = new Set(['default', 'plan', 'dontAsk']);

function settingsSwitches(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [...envHits(f)];
  const permissions = ownObject(f.value, 'permissions') ?? {};
  for (const key of ['allow', 'additionalDirectories'])
    hits.push(
      ...allowRuleHits(f, ruleList(own(permissions, key)), `permissions.${key}`, (rule) =>
        lineOf(f.text, ['"permissions"', quoted(key), quoted(rule)]),
      ),
    );
  const mode = own(permissions, 'defaultMode');
  if (mode !== undefined)
    hits.push(
      hit(
        ASKING_MODES.has(mode) ? 'agent-broad-allow' : 'agent-permission-bypass',
        f.path,
        lineOf(f.text, ['"permissions"', '"defaultMode"']),
        'permissions.defaultMode',
        typeof mode === 'string' ? mode : boundedJson(mode),
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
  return [...hits, ...approvedServers(f)];
}

/** One thing a settings file refuses: a deny rule, or a server of `.mcp.json` kept from starting. */
export interface Guard {
  readonly name: 'permissions.deny' | 'disabledMcpjsonServers';
  readonly value: string;
}

/**
 * The entries of one guard list, each as it is written. `strict` (the head of a change) keeps a
 * list only when it is a list of strings, as a host that reads the file strictly would: anything
 * else refuses nothing. Otherwise (the base) every entry counts, one that is not a string as JSON,
 * so that more is found taken away, never less.
 */
function guardList(value: unknown, strict: boolean): string[] {
  if (value === undefined) return [];
  if (strict)
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? (value as string[])
      : [];
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  return items.map((item) => (typeof item === 'string' ? item : boundedJson(item)));
}

/**
 * What a Claude Code settings file refuses: its deny rules and the servers it disables, compared
 * as written, a blank included. A change that takes one away lets the agent do what it was
 * refused, so each is compared with the base; see `guardList` for `strict`.
 */
export function guardsOf(value: Obj, strict: boolean): Guard[] {
  const permissions = ownObject(value, 'permissions') ?? {};
  return [
    ...guardList(own(permissions, 'deny'), strict).map((rule) => ({
      name: 'permissions.deny' as const,
      value: rule,
    })),
    ...guardList(own(value, 'disabledMcpjsonServers'), strict).map((server) => ({
      name: 'disabledMcpjsonServers' as const,
      value: server,
    })),
  ];
}

/** A server list Claude Code reads as the project's: `.mcp.json`, wherever a session starts. */
const isProjectServerList = (file: string): boolean => {
  const lower = file.toLowerCase();
  return lower === '.mcp.json' || lower.endsWith('/.mcp.json');
};

/**
 * Servers of `.mcp.json` that settings start without asking, all of them or by name, made an
 * error: an approved server runs as soon as a session starts, with nobody asked. The approval
 * may be in the change or already at its base, so it is read from the head as it is.
 */
export function escalateApproved<T extends AgentHit>(hits: readonly T[]): T[] {
  const approvals = hits.filter((h) => h.kind === 'mcp-auto-approve');
  if (approvals.length === 0) return [...hits];
  const all = approvals.some((h) => h.name === 'enableAllProjectMcpServers');
  const names = new Set(
    approvals.filter((h) => h.name === 'enabledMcpjsonServers').map((h) => h.value),
  );
  return hits.map((h) =>
    h.kind === 'mcp-server' && isProjectServerList(h.file) && (all || names.has(h.name))
      ? { ...h, severity: 'error' }
      : h,
  );
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
  '"command"',
  'Helper',
  'AuthRefresh',
  'CredentialExport',
  ...HELPER_KEYS,
  '_BASE_URL',
  '"env"',
  'bypassPermissions',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
] as const;

/** A file that is nothing but hooks: Cursor, Codex, Copilot, Antigravity, Windsurf, Devin. */
export const hookFile = (f: JsonFile): AgentHit[] => hookHits(f, f.value, []);

// ---------------------------------------------------------------------------------------------
// MCP servers.

/** Fields of a server entry that name it or say how it talks, and not what it runs. */
const SERVER_LABELS: ReadonlySet<string> = new Set([
  'command',
  'args',
  'url',
  'httpUrl',
  'type',
  'description',
  'timeout',
  'name',
  'title',
]);
/** The keys a server sets its own variables under, across the agents. */
const SERVER_ENV_KEYS = ['env', 'environment'] as const;
/** Keys that name a file of variables the host reads for the server. */
const SERVER_ENV_FILE_KEYS = ['envFile', 'env_file', 'envfile'] as const;
/** Keys that name the folder the server starts in. */
const SERVER_CWD_KEYS = ['cwd', 'workingDirectory', 'working_directory'] as const;
/** A folder that is the one the host starts in anyway, written exactly so: a blank around it is a move. */
const TOP_FOLDER: ReadonlySet<string> = new Set(['', '.', './']);
/** The workspace folder in VS Code's own spelling, which only its `.vscode/mcp.json` expands. */
const WORKSPACE_FOLDER: ReadonlySet<string> = new Set([
  '${workspaceFolder}',
  '${workspaceFolder}/',
  '${workspaceRoot}',
  '${workspaceRoot}/',
]);

const isAbsolutePath = (word: string): boolean =>
  word.startsWith('/') || word.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(word);
/** An option that takes no value written onto it: `-y`, `--stdio`, never `-r./x` or `--opt=./x`. */
const VALUELESS_FLAG = /^(?:-[A-Za-z]|--[A-Za-z][A-Za-z0-9-]*)$/;

const isVscodeServerList = (file: string): boolean => {
  const lower = file.toLowerCase();
  return lower === '.vscode/mcp.json' || lower.endsWith('/.vscode/mcp.json');
};

/**
 * Whether a server's own variables can make the program it starts run other code. Read through
 * the one list `env` in the settings is read by: any name that is not known to be harmless counts
 * (`NODE_OPTIONS=--require ./x.js` runs x.js, `PATH=./bin` finds another `npx`). So does a value
 * that is not a table, which the host may read in a way this does not, and a file of variables.
 */
function envRunsOther(entry: Obj): boolean {
  for (const key of SERVER_ENV_KEYS) {
    if (!Object.hasOwn(entry, key)) continue;
    const env = entry[key];
    if (!isPlainObject(env) || Object.keys(env).some((name) => !isHarmlessEnv(name))) return true;
  }
  return SERVER_ENV_FILE_KEYS.some((key) => Object.hasOwn(entry, key));
}

/**
 * Whether a server starts in a folder other than the top, and its command or any argument could
 * name a file relative to it: the same entry in another folder runs another file. Only a command
 * and arguments that are all absolute paths, or options that take no value, pass: a bare program
 * name counts too, since Windows looks for it in that folder first, and `npx` or `python -m` load
 * from it. The folder is compared as it is written; `${workspaceFolder}` is the top only in VS
 * Code's own server list, the one host known to expand it.
 */
function folderRunsOther(
  command: string,
  args: readonly string[],
  entry: Obj,
  file: string,
): boolean {
  const moved = SERVER_CWD_KEYS.some((key) => {
    if (!Object.hasOwn(entry, key)) return false;
    const cwd = entry[key];
    if (typeof cwd !== 'string') return true;
    return !(TOP_FOLDER.has(cwd) || (isVscodeServerList(file) && WORKSPACE_FOLDER.has(cwd)));
  });
  if (!moved) return false;
  return !(
    isAbsolutePath(command) && args.every((a) => isAbsolutePath(a) || VALUELESS_FLAG.test(a))
  );
}

/**
 * A server that starts a shell or inline code, or whose own variables or folder can make it run
 * other code than its command says.
 */
export function serverKind(
  command: string,
  args: readonly string[],
  entry: Obj,
  file: string,
): 'mcp-server-runs-code' | 'mcp-server' {
  if (mcpServerRunsCode(command, args)) return 'mcp-server-runs-code';
  return envRunsOther(entry) || folderRunsOther(command, args, entry, file)
    ? 'mcp-server-runs-code'
    : 'mcp-server';
}

/** The server's other fields (`env`, `cwd`, `headers`, `disabled`), to follow what it runs. */
export const serverFields = (entry: Obj): string =>
  otherFields(entry, (key) => SERVER_LABELS.has(key));

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
      const value = `${[command, ...args].join(' ')}${serverFields(entry)}`;
      hits.push(hit(serverKind(command, args, entry, f.path), f.path, line, name, value));
    } else if (url !== undefined) {
      hits.push(hit('mcp-server', f.path, line, name, `${url}${serverFields(entry)}`));
    }
  }
  return hits;
}

export const mcpFile = (f: JsonFile): AgentHit[] => [
  ...mcpServerHits(f, f.value, 'mcpServers'),
  ...mcpServerHits(f, f.value, 'servers'),
];
