import { createEngine } from '../engine-factory.js';
import { runMcpProxy } from '../mcp/proxy.js';

export const MCP_USAGE =
  'usage: stroq mcp --server <name> [--client <name>] [--cwd <dir>] [--session <id>] -- <command> [args...]\n';

/** What `--client` becomes when the flag is absent; `init` always writes it. */
export const DEFAULT_MCP_CLIENT = 'unknown';

export interface McpInvocation {
  readonly server: string;
  readonly client: string;
  readonly session: string | null;
  readonly cwd: string | null;
  readonly command: string;
  readonly args: readonly string[];
}

export type McpArgvResult =
  | { readonly ok: true; readonly invocation: McpInvocation }
  | { readonly ok: false; readonly error: string };

const OPTIONS = new Set(['--server', '--client', '--cwd', '--session']);

/**
 * Parsed by hand rather than with `node:util.parseArgs`: a MISSING `--` has to be
 * distinguishable from an empty command (the first is a usage error, the second is
 * too, but for a different reason), and `parseArgs` folds both into empty
 * positionals. Everything after the first `--` is the server's own command line and
 * is never interpreted, so a server whose own arguments include `--server` is safe.
 */
export function parseMcpArgv(argv: readonly string[]): McpArgvResult {
  let server = '';
  let client = DEFAULT_MCP_CLIENT;
  let session: string | null = null;
  let cwd: string | null = null;
  let rest: readonly string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (!OPTIONS.has(token)) return { ok: false, error: `unknown option "${token}"` };
    const value = argv[i + 1];
    if (value === undefined || value === '--')
      return { ok: false, error: `${token} needs a value` };
    if (token === '--server') server = value;
    if (token === '--client') client = value;
    if (token === '--cwd') cwd = value;
    if (token === '--session') session = value;
    i += 1;
  }
  if (server === '') return { ok: false, error: '--server is required' };
  if (rest === null) return { ok: false, error: 'the server command must follow "--"' };
  const [command, ...args] = rest;
  if (command === undefined || command === '')
    return { ok: false, error: 'the server command must follow "--"' };
  return { ok: true, invocation: { server, client, session, cwd, command, args } };
}

/**
 * The long-running proxy. Unlike every other Stroq command this does not return until
 * the wrapped server exits: the client launched it as its MCP server, and its exit
 * code is the one the client reads.
 */
export async function runMcp(argv: readonly string[]): Promise<number> {
  const parsed = parseMcpArgv(argv);
  if (!parsed.ok) {
    // Exit 2 before anything is spawned, so a mis-written config fails visibly rather
    // than launching an unguarded server.
    process.stderr.write(`stroq mcp: ${parsed.error}\n${MCP_USAGE}`);
    return 2;
  }
  const { invocation } = parsed;
  return runMcpProxy({
    engine: createEngine(),
    // One session per CLIENT, not per server: a poisoned result from server A must
    // taint the calls that go to server B.
    sessionId: invocation.session ?? `mcp:${invocation.client}`,
    server: invocation.server,
    // Claude Desktop launches its servers from `/`, so the project directory has to
    // be recorded at install time; nothing on the wire can change it.
    cwd: invocation.cwd ?? process.cwd(),
    command: invocation.command,
    args: invocation.args,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
