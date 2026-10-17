// Reading a client config and building the entry that goes into it.
import { readConfigText, parseConfigJson, isPlainObject } from '../commands/config-file.js';
import { hasValidMcpServers } from '../commands/mcp-config.js';
import type { McpConfigJson } from '../commands/mcp-config.js';
import type { McpInstallOptions, McpRecord } from './mcp-record.js';
import { storePath } from './store.js';

export function loadConfig(file: string): { config: McpConfigJson; text: string | null } {
  const text = readConfigText(file, { strict: true });
  const config: McpConfigJson =
    text === null || text.trim().length === 0 ? {} : parseConfigJson(file, text);
  if (!isPlainObject(config) || !hasValidMcpServers(config))
    throw new Error('mcpServers in the client config is not an object');
  return { config, text };
}

export function serversOf(config: McpConfigJson): Record<string, unknown> {
  return isPlainObject(config.mcpServers) ? config.mcpServers : {};
}

export function withServer(
  config: McpConfigJson,
  name: string,
  entry: Record<string, unknown> | undefined,
): McpConfigJson {
  const servers = { ...serversOf(config) };
  if (entry === undefined) delete servers[name];
  else servers[name] = entry;
  return { ...config, mcpServers: servers };
}

export function currentEntry(config: McpConfigJson, name: string): unknown {
  const servers = serversOf(config);
  return Object.hasOwn(servers, name) ? servers[name] : undefined;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function entryFor(
  name: string,
  record: Pick<McpRecord, 'digest' | 'entrypoint' | 'passEnv'>,
  options: McpInstallOptions,
  label: string,
  cwd: string,
  original: Record<string, unknown> | null,
  strictArgs: readonly string[] = [],
): Record<string, unknown> {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return {
    ...(original ?? {}),
    command: options.node,
    args: [
      ...options.entryArgv,
      'mcp',
      '--server',
      name,
      '--client',
      label,
      '--pin',
      `sha256:${record.digest}`,
      '--cwd',
      cwd,
      '--pass-env',
      record.passEnv.join(','),
      ...strictArgs,
      '--',
      'node',
      `${storePath(options.stroqHome, record.digest)}${sep}tree${sep}${record.entrypoint}`,
    ],
  };
}
