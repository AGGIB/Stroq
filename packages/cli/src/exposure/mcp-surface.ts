import { existsSync } from 'node:fs';
import { MCP_CONFIGS } from '../commands/doctor.js';
import {
  countHttp,
  countWrapped,
  mcpConfigPath,
  readMcpConfig,
  type McpClient,
} from '../commands/mcp-config.js';
import type { Finding } from './findings.js';

export interface McpSurface {
  readonly client: McpClient;
  readonly scope: 'project' | 'user';
  readonly file: string;
  readonly stdio: number;
  readonly wrapped: number;
  /** Entries carrying `url`/`serverUrl`: no subprocess exists, so the proxy cannot reach them. */
  readonly http: number;
}

/**
 * The config table is `doctor`'s, imported rather than copied: two lists of client
 * configs would eventually disagree about which files a machine has, and the whole
 * point of building `exposure` on `doctor`'s primitives is that they cannot.
 */
export function mcpSurface(cwd: string): readonly McpSurface[] {
  const found: McpSurface[] = [];
  const seen = new Set<string>();
  for (const { client, scope } of MCP_CONFIGS) {
    const file = mcpConfigPath(client, scope, cwd);
    // Cursor's two scopes collapse to one file when the project IS the home directory.
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    try {
      const config = readMcpConfig(file);
      const counted = countWrapped(config);
      found.push({
        client,
        scope,
        file,
        stdio: counted.stdio,
        wrapped: counted.wrapped,
        http: countHttp(config),
      });
    } catch {
      // A config we cannot parse tells us nothing about exposure; doctor is the
      // command that reports a broken file, and duplicating that here would put a
      // parse error in a report about attack surface.
      continue;
    }
  }
  return found;
}

export function mcpFindings(surfaces: readonly McpSurface[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const s of surfaces) {
    const unwrapped = s.stdio - s.wrapped;
    if (unwrapped > 0) {
      findings.push({
        class: 'mcp-unwrapped',
        severity: 'high',
        detail: `${unwrapped} of ${s.stdio} stdio MCP servers in ${s.client} (${s.file}) do not go through Stroq — their results reach the agent unchecked`,
        fix: `stroq init --agent mcp --client ${s.client}`,
      });
    }
    if (s.http > 0) {
      findings.push({
        class: 'mcp-http-unreachable',
        severity: 'medium',
        detail: `${s.http} HTTP MCP server(s) in ${s.client} (${s.file}) have no subprocess to wrap, so the stdio proxy cannot see them at all`,
        fix: null,
      });
    }
  }
  return findings;
}
