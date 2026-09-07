import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
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

function claudeDesktopPath(home: string): string {
  if (platform() === 'darwin')
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform() === 'win32')
    return join(
      process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
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
  if (client === 'claude-desktop') return claudeDesktopPath(home);
  if (client === 'windsurf') return windsurfMcpPath(home);
  if (client === 'cursor')
    return scope === 'user' ? join(home, '.cursor', 'mcp.json') : join(cwd, '.cursor', 'mcp.json');
  return join(cwd, '.mcp.json');
}

export const readMcpConfig = (file: string): McpConfigJson => readJsonObject<McpConfigJson>(file);

/**
 * The entry file Stroq is ever launched from: `dist/index.js` in a published install,
 * `src/index.ts` under tsx, and the `stroq` bin shim a global install puts on PATH.
 * The wrapper test needs it: a foreign server whose own argv happened to contain
 * `mcp --server` would otherwise read as already wrapped and never be protected.
 */
const STROQ_ENTRY = /(^|[\\/])(index\.(?:js|ts|mjs|cjs)|stroq(?:\.js|\.cmd)?)$/;

/** The index of the `mcp` token of Stroq's own wrapper in `args`, or null when this entry is not wrapped. */
export function wrapperIndex(args: readonly unknown[]): number | null {
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] !== 'mcp' || args[i + 1] !== '--server') continue;
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

/** The command a wrapped entry wraps, read back from after the wrapper's own `--`. */
export function unwrapArgs(args: readonly unknown[]): OriginalCommand | null {
  const at = wrapperIndex(args);
  if (at === null) return null;
  const [command, ...tail] = args.slice(args.indexOf('--', at) + 1);
  if (typeof command !== 'string' || command === '') return null;
  return { command, args: tail.filter((arg): arg is string => typeof arg === 'string') };
}

export type McpEntryAction =
  | 'wrapped'
  | 'already wrapped'
  | 'unwrapped'
  | 'not wrapped'
  | 'skipped (http)'
  | 'skipped (no command)'
  | 'skipped (not an object)';

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

const argsOf = (entry: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(entry['args']) ? entry['args'] : [];

const stringArgs = (args: readonly unknown[]): readonly string[] =>
  args.filter((arg): arg is string => typeof arg === 'string');

interface EntryRewrite {
  readonly entry: unknown;
  readonly action: McpEntryAction;
}

function wrapEntry(name: string, entry: Record<string, unknown>, opts: WrapOptions): EntryRewrite {
  if (isHttpEntry(entry)) return { entry, action: 'skipped (http)' };
  const original = unwrapArgs(argsOf(entry));
  const command =
    original?.command ?? (typeof entry['command'] === 'string' ? entry['command'] : '');
  if (command === '') return { entry, action: 'skipped (no command)' };
  const args = original?.args ?? stringArgs(argsOf(entry));
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
}

/** How many of a config's stdio servers go through the proxy; HTTP entries are not counted. */
export function countWrapped(config: McpConfigJson): McpProxyCount {
  const stdio = Object.values(serversOf(config))
    .filter(isPlainObject)
    .filter((entry) => !isHttpEntry(entry) && typeof entry['command'] === 'string');
  return {
    wrapped: stdio.filter((entry) => unwrapArgs(argsOf(entry)) !== null).length,
    stdio: stdio.length,
  };
}
