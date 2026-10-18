// Which client config a server is written to, and where that file may be written: from the flags of `add`, or from
// the record of a server that is already installed.
import { homedir } from 'node:os';
import { basename, dirname, posix, resolve } from 'node:path';
import { isMcpClient, mcpConfigPath, wrapperIndex } from '../commands/mcp-config.js';
import type { McpClient } from '../commands/mcp-config.js';
import type { McpInstallOptions, McpPendingRecord, McpRecord } from './mcp-record.js';

export interface McpTarget {
  readonly file: string;
  readonly label: string;
  readonly root: string | null;
}

function clientRoot(
  client: McpClient,
  options: Pick<McpInstallOptions, 'project' | 'user'>,
): string {
  if (client === 'claude-code' || (client === 'cursor' && options.user !== true))
    return resolve(options.project);
  // Windows may deliberately redirect the user's roaming application data outside their home.
  if (client === 'claude-desktop' && process.platform === 'win32')
    return resolve(process.env['APPDATA'] ?? homedir());
  return resolve(homedir());
}

export function target(options: McpInstallOptions): McpTarget {
  if ((options.client === undefined) === (options.config === undefined))
    throw new Error('give exactly one of --client <name> or --config <path>');
  if (options.config !== undefined) {
    const file = resolve(options.config);
    return { file, label: posix.basename(file.replaceAll('\\', '/')), root: null };
  }
  const client = options.client!;
  if (!isMcpClient(client)) throw new Error('unknown MCP client');
  return {
    file: resolve(
      mcpConfigPath(client, options.user === true ? 'user' : 'project', options.project),
    ),
    label: client,
    root: clientRoot(client, options),
  };
}

export function recordedTarget(record: McpRecord | McpPendingRecord): McpTarget {
  const file = resolve(record.config);
  let root = record.configRoot;
  // Older records have only the selected client and its conventional config path.
  if (root === undefined) {
    root = null;
    if (record.client === 'claude-code' && basename(file) === '.mcp.json') root = dirname(file);
    else if (
      record.client === 'cursor' &&
      basename(file) === 'mcp.json' &&
      basename(dirname(file)) === '.cursor'
    )
      root = dirname(dirname(file));
    else if (record.client === 'windsurf' && basename(file) === 'mcp_config.json') {
      const parent = dirname(file);
      // Windsurf discovery can switch paths after installation; both layouts retain the same home.
      if (basename(parent) === '.codeium') root = dirname(parent);
      else if (basename(parent) === 'windsurf' && basename(dirname(parent)) === '.codeium')
        root = dirname(dirname(parent));
    } else if (isMcpClient(record.client) && file === resolve(mcpConfigPath(record.client, 'user')))
      root = clientRoot(record.client, { project: process.cwd(), user: true });
  }
  return { file, label: record.client, root };
}

export function targetRules(target: McpTarget): { root?: string; initRule: false } {
  return { ...(target.root === null ? {} : { root: target.root }), initRule: false };
}

export function recordedCwd(record: McpRecord): string {
  if (record.cwd !== undefined) return resolve(record.cwd);
  const args = record.written['args'];
  const at = Array.isArray(args) ? wrapperIndex(args) : null;
  if (Array.isArray(args) && at !== null) {
    const end = args.indexOf('--', at);
    const flag = args.indexOf('--cwd', at);
    if (flag !== -1 && flag + 1 < end && typeof args[flag + 1] === 'string')
      return resolve(args[flag + 1]);
  }
  throw new Error('the installed MCP wrapper has no recorded working directory');
}
