import { spawn } from 'node:child_process';
import { readMcpConfig, unwrapArgs, wrapperPinArgs } from '../commands/mcp-config.js';
import { childEnv } from '../mcp/child-env.js';
import { runMcpHandshake } from '../mcp/handshake.js';
import type { Finding } from './findings.js';
import type { McpSurface } from './mcp-surface.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** The version this probe claims in `initialize`; servers negotiate down from it. */
const PROTOCOL_VERSION = '2025-06-18';

export interface ProbeResult {
  readonly server: string;
  readonly tools: number;
  /** Names of tools whose description tripped a rule. */
  readonly flagged: readonly string[];
  readonly error: string | null;
}

interface ServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
}

function specsFrom(file: string): readonly ServerSpec[] {
  let servers: unknown;
  try {
    servers = readMcpConfig(file).mcpServers;
  } catch {
    return [];
  }
  if (typeof servers !== 'object' || servers === null) return [];
  const specs: ServerSpec[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    // HTTP entries name a URL rather than a command: there is no process to start.
    if (typeof entry['command'] !== 'string') continue;
    const args = Array.isArray(entry['args']) ? entry['args'] : [];
    // A pin must run through its verifying proxy even during a probe. Unwrapping
    // it here would start unchecked store bytes before exposure reports drift.
    const unwrapped = wrapperPinArgs(args).length === 0 ? unwrapArgs(args) : null;
    specs.push({
      name,
      command: unwrapped ? unwrapped.command : entry['command'],
      args: unwrapped ? unwrapped.args : args.filter((a): a is string => typeof a === 'string'),
      env:
        typeof entry['env'] === 'object' && entry['env'] !== null
          ? (entry['env'] as Record<string, string>)
          : {},
      cwd: typeof entry['cwd'] === 'string' ? entry['cwd'] : undefined,
    });
  }
  return specs;
}

/**
 * Runs the real MCP handshake — `initialize`, `notifications/initialized`, then exactly
 * one `tools/list` — and reads the descriptions that come back. A tool is never called:
 * the probe reads descriptions, which is where tool poisoning lives, and nothing else.
 * The child is always killed, including on timeout — and on Windows so is everything
 * it started, which `child.kill` alone would not reach; see `killChildTree`.
 *
 * Replies must match the initialize and tools/list request ids. Unsolicited
 * capability data is not treated as a successful discovery.
 */
async function probeOne(spec: ServerSpec, timeoutMs: number): Promise<ProbeResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.command, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      // Not the whole environment: the command comes from a `.mcp.json` that may have
      // arrived with a repository the user has only just cloned, and it would get
      // every credential in their shell. The infrastructure variables a server needs
      // to start, plus what its own config declares, which is what a real client
      // passes it and what `stroq mcp` does too.
      env: { ...childEnv([]), ...spec.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    return { server: spec.name, tools: 0, flagged: [], error: (err as Error).message };
  }

  const result = await runMcpHandshake(child, { timeoutMs, singlePage: true });
  return {
    server: spec.name,
    tools: result.tools.length,
    flagged: result.flagged,
    error: result.error ?? result.incompleteReason,
  };
}

export async function probeServers(
  surfaces: readonly McpSurface[],
  opts: { readonly timeoutMs?: number } = {},
): Promise<readonly ProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const results: ProbeResult[] = [];
  const seen = new Set<string>();
  for (const surface of surfaces)
    for (const spec of specsFrom(surface.file)) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      results.push(await probeOne(spec, timeoutMs));
    }
  return results;
}

export function probeFindings(results: readonly ProbeResult[]): readonly Finding[] {
  return results
    .filter((r) => r.flagged.length > 0)
    .map((r) => ({
      class: 'mcp-tool-description-flagged' as const,
      severity: 'critical' as const,
      detail: `MCP server "${r.server}" describes ${r.flagged.length} tool(s) with text that trips an injection rule: ${r.flagged.join(', ')} — the agent reads these descriptions every session`,
      fix: 'stroq init --agent mcp --client <your client>',
    }));
}
