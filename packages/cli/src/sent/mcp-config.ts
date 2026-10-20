// Whether an MCP server a session called runs on this machine or somewhere else.
//
// A key in the arguments of an MCP call went to that server. A server reached by URL is
// another company's (or at least another machine's); a server started as a local command
// may or may not send what it is given on. The clients' own config files say which, and
// only the transport fields are read from them: `type`, `url` and `command`. Headers, env
// and every other field (`~/.claude.json` holds much more) are never kept.
import { join } from 'node:path';
import { readSmall } from './regular-file.js';

export interface McpServer {
  readonly remote: boolean;
  /** The host of a remote server's URL, when it has one that parses. */
  readonly host: string | null;
}

export interface McpLookup {
  /** The server's name as the tool name spells it, or the connector's name. */
  readonly name: string;
  /** What the config says, or null when no config file names the server. */
  readonly server: McpServer | null;
  /** A claude.ai connector: remote, run by Anthropic for the service it connects. */
  readonly connector: boolean;
}

export interface McpServers {
  /** What is known about the server an `mcp__<server>__<tool>` call went to; null for another tool. */
  lookup(tool: string): McpLookup | null;
  readonly known: ReadonlyMap<string, McpServer>;
}

/** Largest config read: `~/.claude.json` keeps per-project history and grows. */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
const CONNECTOR = 'claude_ai_';

/** A server name as a tool name spells it: runs of other characters become one `_`. */
const normalized = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

/** A config file's text; null for a missing one, a FIFO or a device, or one too large. */
const readText = (path: string): string | null => readSmall(path, MAX_CONFIG_BYTES);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^(?:https?|wss?):$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** One server entry's transport, from `url`, `type` and `command` only. */
function transportOf(entry: unknown): McpServer | null {
  if (!isRecord(entry)) return null;
  const url = entry['url'];
  if (typeof url === 'string' && url !== '') return { remote: true, host: hostOf(url) };
  const type = entry['type'];
  if (typeof entry['command'] === 'string' || type === 'stdio')
    return { remote: false, host: null };
  return null;
}

/** The `mcpServers` object of a JSON config, or of one of its `projects` entries. */
function jsonServers(text: string | null): [string, McpServer][] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const blocks = [parsed['mcpServers']];
  const projects = parsed['projects'];
  if (isRecord(projects))
    for (const project of Object.values(projects))
      if (isRecord(project)) blocks.push(project['mcpServers']);
  return blocks.filter(isRecord).flatMap((block) =>
    Object.entries(block).flatMap(([name, entry]): [string, McpServer][] => {
      const transport = transportOf(entry);
      return transport === null ? [] : [[name, transport]];
    }),
  );
}

/** `[mcp_servers.<name>]` sections of Codex's `config.toml`, by their `url` or `command` line. */
function tomlServers(text: string | null): [string, McpServer][] {
  if (text === null) return [];
  const out: [string, McpServer][] = [];
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const header = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/.exec(line);
      current = header === null ? null : (header[1] ?? header[2] ?? null);
      continue;
    }
    if (current === null) continue;
    const url = /^url\s*=\s*"([^"]*)"/.exec(line);
    if (url !== null) out.push([current, { remote: true, host: hostOf(url[1] ?? '') }]);
    else if (/^command\s*=/.test(line)) out.push([current, { remote: false, host: null }]);
  }
  return out;
}

/** The server part of `mcp__<server>__<tool>`, or null for a tool that is not an MCP call. */
function serverOf(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null;
  const rest = tool.slice('mcp__'.length);
  const end = rest.indexOf('__');
  const server = end < 0 ? rest : rest.slice(0, end);
  return server === '' ? null : server;
}

export function loadMcpServers(where: {
  readonly home: string;
  readonly projectDirs: readonly string[];
}): McpServers {
  const dirs = [...new Set(where.projectDirs)];
  const found = [
    ...jsonServers(readText(join(where.home, '.claude.json'))),
    ...jsonServers(readText(join(where.home, '.cursor', 'mcp.json'))),
    ...dirs.flatMap((dir) => [
      ...jsonServers(readText(join(dir, '.mcp.json'))),
      ...jsonServers(readText(join(dir, '.cursor', 'mcp.json'))),
    ]),
    ...tomlServers(readText(join(where.home, '.codex', 'config.toml'))),
  ];
  const known = new Map<string, McpServer>();
  for (const [name, server] of found) {
    const key = normalized(name);
    // One name, two configs: the more outward one is what a call may have reached.
    if (known.get(key)?.remote !== true) known.set(key, server);
  }
  return {
    known,
    lookup(tool: string): McpLookup | null {
      const server = serverOf(tool);
      if (server === null) return null;
      if (server.startsWith(CONNECTOR) && server.length > CONNECTOR.length)
        return {
          name: server.slice(CONNECTOR.length),
          server: { remote: true, host: null },
          connector: true,
        };
      return { name: server, server: known.get(normalized(server)) ?? null, connector: false };
    },
  };
}
