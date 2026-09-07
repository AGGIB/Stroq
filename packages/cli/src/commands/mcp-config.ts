import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, readJsonObject } from './config-file.js';

/**
 * Rewriting an MCP client's config so its stdio servers start through `stroq mcp`.
 * Every client in this list keeps the same shape —
 * `{ "mcpServers": { "<name>": { command, args?, env?, cwd? } } }` — which is why one
 * rewriter covers all four. HTTP entries (`url`/`serverUrl`) are left alone: there is
 * no subprocess to wrap. VS Code (`servers`) and Codex (TOML) use other shapes and
 * are out of scope for v1.
 */

export type McpClient = 'claude-desktop' | 'windsurf' | 'cursor' | 'claude-code';
export const MCP_CLIENTS: readonly McpClient[] = [
  'claude-desktop',
  'windsurf',
  'cursor',
  'claude-code',
];
export const isMcpClient = (value: string): value is McpClient =>
  (MCP_CLIENTS as readonly string[]).includes(value);

export type McpConfigJson = { readonly mcpServers?: unknown } & Record<string, unknown>;

/**
 * `plat`/`env`/`home` default to the real process so every existing caller keeps
 * working unchanged; a test overrides them to exercise one platform branch without
 * touching `process.platform`, the real environment, or the real home directory.
 */
export function claudeDesktopPath(
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (plat === 'darwin')
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (plat === 'win32')
    return join(
      env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Current Windsurf IDE builds write `~/.codeium/windsurf/mcp_config.json` and two
 * third-party installers target it; the documentation names `~/.codeium/mcp_config.json`.
 * Prefer whichever EXISTS, and fall back to the documented one, so a machine with
 * neither gets an error naming a path the docs mention.
 */
function windsurfMcpPath(home: string): string {
  const ide = join(home, '.codeium', 'windsurf', 'mcp_config.json');
  return existsSync(ide) ? ide : join(home, '.codeium', 'mcp_config.json');
}

/**
 * `scope` matters for Cursor alone. Claude Desktop and Windsurf keep one user-level
 * file each, and Claude Code's `.mcp.json` is a project file; passing `--user` for
 * any of those three is accepted and ignored rather than being an error.
 */
export function mcpConfigPath(
  client: McpClient,
  scope: 'project' | 'user',
  cwd: string = process.cwd(),
): string {
  const home = homedir();
  if (client === 'claude-desktop') return claudeDesktopPath(process.platform, process.env, home);
  if (client === 'windsurf') return windsurfMcpPath(home);
  if (client === 'cursor')
    return scope === 'user' ? join(home, '.cursor', 'mcp.json') : join(cwd, '.cursor', 'mcp.json');
  return join(cwd, '.mcp.json');
}

export const readMcpConfig = (file: string): McpConfigJson => readJsonObject<McpConfigJson>(file);

/**
 * True when `mcpServers` is either absent (nothing to rewrite yet, which is fine) or
 * already a plain object — the only shapes `wrapMcpConfig`/`unwrapMcpConfig` know how
 * to rewrite. A PRESENT-but-wrong-shaped value (an array from a hand edit, say) is
 * neither: it is real user data this module must never silently replace with `{}`.
 */
export const hasValidMcpServers = (config: McpConfigJson): boolean =>
  config.mcpServers === undefined || isPlainObject(config.mcpServers);

/**
 * The entry file Stroq is ever launched from: `dist/index.js` in a published install,
 * `src/index.ts` under tsx, and the `stroq` bin shim a global install puts on PATH.
 * The wrapper test needs it: a foreign server whose own argv happened to contain
 * `mcp --server` would otherwise read as already wrapped and never be protected.
 */
const STROQ_ENTRY = /(^|[\\/])(index\.(?:js|ts|mjs|cjs)|stroq(?:\.js|\.cmd)?)$/;

/**
 * The index of the `mcp` token of Stroq's own wrapper in `args`, or null when this
 * entry is not wrapped. Three things have to hold at once: an entry-shaped path right
 * before `mcp`, `--server` right after it, and `--client` right after THAT — `init`
 * always writes `--server <name> --client <client>` in that order, so a foreign
 * server whose own argv happens to contain `mcp --server` (even behind an
 * `index.js`-shaped path) is not mistaken for Stroq's own wrapper unless it also has
 * `--client` in exactly that position.
 */
export function wrapperIndex(args: readonly unknown[]): number | null {
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] !== 'mcp' || args[i + 1] !== '--server' || args[i + 3] !== '--client') continue;
    const entry = args[i - 1];
    if (typeof entry !== 'string' || !STROQ_ENTRY.test(entry)) continue;
    if (args.indexOf('--', i) === -1) continue;
    return i;
  }
  return null;
}

export interface OriginalCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Every element as the string `child_process.spawn` would actually pass it: args is
 * not required to be all-string JSON (a port number, say), and coercing — never
 * dropping — an element is what keeps a wrap/unwrap round trip from shortening the
 * server's real argv.
 */
const coerceArgs = (args: readonly unknown[]): readonly string[] => args.map((arg) => String(arg));

/** The command a wrapped entry wraps, read back from after the wrapper's own `--`. */
export function unwrapArgs(args: readonly unknown[]): OriginalCommand | null {
  const at = wrapperIndex(args);
  if (at === null) return null;
  const [command, ...tail] = args.slice(args.indexOf('--', at) + 1);
  if (typeof command !== 'string' || command === '') return null;
  return { command, args: coerceArgs(tail) };
}

export type McpEntryAction =
  | 'wrapped'
  | 'already wrapped'
  | 'unwrapped'
  | 'not wrapped'
  | 'skipped (http)'
  | 'skipped (no command)'
  | 'skipped (not an object)'
  | 'skipped (args is not an array)';

export interface McpEntryOutcome {
  readonly name: string;
  readonly action: McpEntryAction;
}

export interface McpRewrite {
  readonly config: McpConfigJson;
  readonly outcomes: readonly McpEntryOutcome[];
}

export interface WrapOptions {
  /** The node binary, i.e. `hookArgv(node, entry)[0]`. */
  readonly node: string;
  /** Everything between it and the wrapper's first argument: `--import tsx` in development, then the entry path. */
  readonly entryArgv: readonly string[];
  /** What `--client` records: a client name, or the config file's basename for `--config`. */
  readonly client: string;
  /** The project directory, recorded because Claude Desktop launches servers from `/`. */
  readonly cwd: string;
}

const serversOf = (config: McpConfigJson): Record<string, unknown> =>
  isPlainObject(config.mcpServers) ? config.mcpServers : {};

const isHttpEntry = (entry: Record<string, unknown>): boolean =>
  typeof entry['url'] === 'string' || typeof entry['serverUrl'] === 'string';

/** Present but not an array (a string, say) — not ours to reinterpret as empty. */
const hasInvalidArgs = (entry: Record<string, unknown>): boolean =>
  entry['args'] !== undefined && !Array.isArray(entry['args']);

const argsOf = (entry: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(entry['args']) ? entry['args'] : [];

interface EntryRewrite {
  readonly entry: unknown;
  readonly action: McpEntryAction;
}

function wrapEntry(name: string, entry: Record<string, unknown>, opts: WrapOptions): EntryRewrite {
  if (isHttpEntry(entry)) return { entry, action: 'skipped (http)' };
  if (hasInvalidArgs(entry)) return { entry, action: 'skipped (args is not an array)' };
  const original = unwrapArgs(argsOf(entry));
  const command =
    original?.command ?? (typeof entry['command'] === 'string' ? entry['command'] : '');
  if (command === '') return { entry, action: 'skipped (no command)' };
  const args = original?.args ?? coerceArgs(argsOf(entry));
  return {
    action: original === null ? 'wrapped' : 'already wrapped',
    entry: {
      ...entry,
      command: opts.node,
      args: [
        ...opts.entryArgv,
        'mcp',
        '--server',
        name,
        '--client',
        opts.client,
        '--cwd',
        opts.cwd,
        '--',
        command,
        ...args,
      ],
    },
  };
}

function unwrapEntry(entry: Record<string, unknown>): EntryRewrite {
  if (isHttpEntry(entry)) return { entry, action: 'skipped (http)' };
  if (hasInvalidArgs(entry)) return { entry, action: 'skipped (args is not an array)' };
  const original = unwrapArgs(argsOf(entry));
  if (original === null) return { entry, action: 'not wrapped' };
  // Always an array, empty when the original took no arguments: an empty `args` is
  // equivalent to the key's absence for every client, and it keeps this free of a delete.
  return {
    action: 'unwrapped',
    entry: { ...entry, command: original.command, args: [...original.args] },
  };
}

/** Applies one per-entry rewrite across the file, preserving key order and every other key. */
function rewrite(
  config: McpConfigJson,
  each: (name: string, entry: Record<string, unknown>) => EntryRewrite,
): McpRewrite {
  // A PRESENT-but-invalid `mcpServers` is not this function's to fix. The caller
  // decides whether that is an error worth reporting; this is the belt under that
  // suspender — never turn a hand-edited array (or any other shape) into `{}`.
  if (!hasValidMcpServers(config)) return { config, outcomes: [] };
  const outcomes: McpEntryOutcome[] = [];
  const servers = Object.fromEntries(
    Object.entries(serversOf(config)).map(([name, entry]) => {
      if (!isPlainObject(entry)) {
        outcomes.push({ name, action: 'skipped (not an object)' });
        return [name, entry];
      }
      const result = each(name, entry);
      outcomes.push({ name, action: result.action });
      return [name, result.entry];
    }),
  );
  return { config: { ...config, mcpServers: servers }, outcomes };
}

export const wrapMcpConfig = (config: McpConfigJson, opts: WrapOptions): McpRewrite =>
  rewrite(config, (name, entry) => wrapEntry(name, entry, opts));

export const unwrapMcpConfig = (config: McpConfigJson): McpRewrite =>
  rewrite(config, (_name, entry) => unwrapEntry(entry));

export interface McpProxyCount {
  readonly wrapped: number;
  readonly stdio: number;
  /**
   * Wrapped, but the entry file its args record no longer exists — an upgrade or
   * uninstall that removed the old path without re-running `init`. Not counted in
   * `wrapped`: the client would fail to start this server.
   */
  readonly stale: number;
}

/** The Stroq entry path a wrapped entry's `args` records — the token right before `mcp`. */
function wrappedEntryPath(args: readonly unknown[]): string | null {
  const at = wrapperIndex(args);
  if (at === null) return null;
  const entry = args[at - 1];
  return typeof entry === 'string' ? entry : null;
}

/**
 * How many of a config's stdio servers go through the proxy; HTTP entries are not
 * counted. A wrapper counts as `wrapped` only when its recorded entry file still
 * exists — one pointing at a path that is gone would fail at startup, so it is
 * reported as `stale` instead of as protected.
 */
export function countWrapped(config: McpConfigJson): McpProxyCount {
  const stdio = Object.values(serversOf(config))
    .filter(isPlainObject)
    .filter((entry) => !isHttpEntry(entry) && typeof entry['command'] === 'string');
  let wrapped = 0;
  let stale = 0;
  for (const entry of stdio) {
    const entryPath = wrappedEntryPath(argsOf(entry));
    if (entryPath === null) continue;
    if (existsSync(entryPath)) wrapped += 1;
    else stale += 1;
  }
  return { wrapped, stdio: stdio.length, stale };
}
