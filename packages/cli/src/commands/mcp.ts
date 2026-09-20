import { resolve } from 'node:path';
import { createEngine } from '../engine-factory.js';
import { runMcpProxy } from '../mcp/proxy.js';

export const MCP_USAGE =
  'usage: stroq mcp --server <name> [--client <name>] [--cwd <dir>] [--session <id>] [--pass-env <names>] -- <command> [args...]\n';

/** What `--client` becomes when the flag is absent; `init` always writes it. */
export const DEFAULT_MCP_CLIENT = 'unknown';

export interface McpInvocation {
  readonly server: string;
  readonly client: string;
  readonly session: string | null;
  readonly cwd: string | null;
  /**
   * The names from `--pass-env`, or null when the flag is absent. The two are not
   * the same answer: an empty list is a wrapper that knows this server declared no
   * environment of its own, while a missing flag is a wrapper written before the
   * flag existed and knows nothing either way.
   */
  readonly passEnv: readonly string[] | null;
  readonly command: string;
  readonly args: readonly string[];
}

export type McpArgvResult =
  | { readonly ok: true; readonly invocation: McpInvocation }
  | { readonly ok: false; readonly error: string };

const OPTIONS = new Set(['--server', '--client', '--cwd', '--session', '--pass-env']);

/**
 * `--pass-env` is a comma-separated list of variable NAMES. Blank members are
 * dropped rather than passed on as a variable named the empty string: an empty
 * value is how `init` records "this server declared no environment of its own", and
 * a hand edit can easily leave a stray comma or a space behind.
 */
const parsePassEnv = (value: string): readonly string[] =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

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
  let passEnv: readonly string[] | null = null;
  let rest: readonly string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (!OPTIONS.has(token)) return { ok: false, error: `unknown option "${token}"` };
    const value = argv[i + 1];
    // A value starting with `--` (the bare separator included) is always the NEXT
    // flag or the separator, never a real value — a config with a missing value
    // (`--server --client x`) would otherwise silently swallow the next flag as
    // this one's value instead of failing loudly.
    if (value === undefined || value.startsWith('--'))
      return { ok: false, error: `${token} needs a value` };
    if (token === '--server') server = value;
    if (token === '--client') client = value;
    if (token === '--cwd') cwd = value;
    if (token === '--session') session = value;
    if (token === '--pass-env') passEnv = parsePassEnv(value);
    i += 1;
  }
  if (server === '') return { ok: false, error: '--server is required' };
  if (rest === null) return { ok: false, error: 'the server command must follow "--"' };
  const [command, ...args] = rest;
  if (command === undefined || command === '')
    return { ok: false, error: 'the server command must follow "--"' };
  return { ok: true, invocation: { server, client, session, cwd, passEnv, command, args } };
}

/**
 * A `--cwd` value made absolute against the proxy's own `process.cwd()`; the
 * omitted-flag default (`process.cwd()` itself) is already absolute and passes
 * through `resolve` unchanged. Split out from `runMcp` so the resolution — not the
 * whole long-running proxy — is what a test exercises directly.
 */
export function resolveMcpCwd(cwd: string | null): string {
  return resolve(cwd ?? process.cwd());
}

/**
 * Wrappers written before `--pass-env` existed record nothing about what their
 * server was configured with, and the proxy cannot recover it: by the time it runs,
 * the client has already merged the config entry's `env` into `process.env`, where
 * it is indistinguishable from the user's own shell. Filtering on a guess would
 * break those servers with an error naming a missing credential rather than the
 * wrapper that dropped it — so they keep inheriting everything, and this says so
 * once at startup, on the stderr the client logs.
 */
const LEGACY_ENV_WARNING =
  'stroq mcp: this wrapper predates environment filtering, so the server inherits every variable in this process (secrets included). Re-run "stroq init --agent mcp --client <your client>" to record the ones it actually needs.\n';

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
  if (invocation.passEnv === null) process.stderr.write(LEGACY_ENV_WARNING);
  return runMcpProxy({
    engine: createEngine(),
    // One session per CLIENT, not per server: a poisoned result from server A must
    // taint the calls that go to server B.
    sessionId: invocation.session ?? `mcp:${invocation.client}`,
    server: invocation.server,
    // Claude Desktop launches its servers from `/`, so the project directory has to
    // be recorded at install time; nothing on the wire can change it.
    cwd: resolveMcpCwd(invocation.cwd),
    passEnv: invocation.passEnv,
    command: invocation.command,
    args: invocation.args,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
