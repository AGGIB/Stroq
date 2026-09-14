import { spawn } from 'node:child_process';
import { loadBundledRules, scanContent } from '@stroq/core';
import { readMcpConfig, unwrapArgs } from '../commands/mcp-config.js';
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
    // Probe the real server, not a nested `stroq mcp` wrapper around it.
    const unwrapped = unwrapArgs(args);
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

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly error?: { readonly message?: unknown };
  readonly result?: { readonly tools?: readonly { name?: unknown; description?: unknown }[] };
}

const INIT_ID = 1;
const LIST_ID = 2;

const line = (msg: unknown): string => `${JSON.stringify(msg)}\n`;

const INITIALIZE = line({
  jsonrpc: '2.0',
  id: INIT_ID,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'stroq-exposure', version: '1' },
  },
});
const INITIALIZED = line({ jsonrpc: '2.0', method: 'notifications/initialized' });
const TOOLS_LIST = line({ jsonrpc: '2.0', id: LIST_ID, method: 'tools/list', params: {} });

function flaggedTools(
  tools: readonly { name?: unknown; description?: unknown }[],
): readonly string[] {
  const rules = loadBundledRules();
  return tools
    .filter(
      (t) =>
        typeof t.description === 'string' &&
        scanContent(rules, t.description).verdict === 'suspect',
    )
    .map((t) => (typeof t.name === 'string' ? t.name : '(unnamed)'));
}

/**
 * Runs the real MCP handshake — `initialize`, `notifications/initialized`, then exactly
 * one `tools/list` — and reads the descriptions that come back. A tool is never called:
 * the probe reads descriptions, which is where tool poisoning lives, and nothing else.
 * The child is always killed, including on timeout.
 *
 * A response carrying `result.tools` is accepted whatever its id, so a server that
 * answers without the handshake is still read rather than reported as a timeout.
 */
async function probeOne(spec: ServerSpec, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const empty = { server: spec.name, tools: 0, flagged: [] as readonly string[] };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, [...spec.args], {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      resolve({ ...empty, error: (err as Error).message });
      return;
    }

    let buf = '';
    let done = false;
    const finish = (result: ProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ...empty, error: `no tools/list response within ${timeoutMs} ms` }),
      timeoutMs,
    );

    /** A closed pipe is the server having exited; it is reported by `error`/`exit`. */
    const write = (text: string): void => {
      try {
        child.stdin?.write(text);
      } catch {
        /* ignore */
      }
    };

    child.on('error', (err: Error) => finish({ ...empty, error: err.message }));
    child.on('exit', (code) =>
      finish({ ...empty, error: `server exited before answering (code ${code ?? 'null'})` }),
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const text = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (text.trim() === '') continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(text) as JsonRpcMessage;
        } catch {
          // Servers that log to stdout are common; a line we cannot parse is not an error.
          continue;
        }
        const tools = msg.result?.tools;
        if (Array.isArray(tools)) {
          finish({
            server: spec.name,
            tools: tools.length,
            flagged: flaggedTools(tools),
            error: null,
          });
          return;
        }
        if (msg.id === LIST_ID && msg.error) {
          const detail =
            typeof msg.error.message === 'string' ? msg.error.message : 'unknown error';
          finish({ ...empty, error: `tools/list failed: ${detail}` });
          return;
        }
        if (msg.id === INIT_ID) {
          write(INITIALIZED);
          write(TOOLS_LIST);
        }
      }
    });

    write(INITIALIZE);
  });
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
