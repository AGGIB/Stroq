/**
 * What environment the wrapped MCP server is started with.
 *
 * `stroq mcp` is spawned BY the MCP client, so its own environment is whatever the
 * client had — for every client but Claude Desktop, the user's entire shell: cloud
 * credentials, API keys, session tokens. Handing all of that to a third-party server
 * process is the leak this module exists to close.
 *
 * The pass-list cannot be worked out here. A client config entry may declare its own
 * `env` block, and by the time the proxy runs the client has already merged those
 * variables into `process.env`, where they are indistinguishable from whatever the
 * user's shell exported. Only the config file knows which ones the server was
 * actually configured with, so `init` reads the NAMES out of it and records them in
 * the wrapper's `--pass-env`; that is what arrives here as `passEnv`.
 */

/**
 * The variables every wrapped server gets whatever its config declares. Each family
 * is here because leaving it out breaks servers rather than protecting anything —
 * none of them is a credential:
 *
 * - **Finding and starting the program.** `PATH`, plus, on Windows, `PATHEXT` (which
 *   suffixes count as executable, so an `npx.cmd` shim resolves at all), `COMSPEC`
 *   (the interpreter Windows runs a `.cmd`/`.bat` shim through) and
 *   `SystemRoot`/`SystemDrive`/`windir`, which the Win32 loader itself reads: without
 *   them most Windows processes, `node` included, do not start.
 * - **Where per-user configuration and caches live.** `HOME` and its Windows
 *   equivalents, `APPDATA`/`LOCALAPPDATA`/`PROGRAMDATA`, the `XDG_*` directories.
 *   `npx` and `uvx` — how most MCP servers are launched — download into these on
 *   first run and re-resolve the package without them.
 * - **Where installed programs are, on Windows.** The `PROGRAMFILES` family.
 * - **Scratch space.** `TMPDIR`/`TMP`/`TEMP`.
 * - **Locale, encoding and time zone.** `LANG`, `LANGUAGE`, the `LC_*` family and
 *   `TZ`: without them output comes back in the wrong encoding and timestamps in the
 *   wrong zone.
 * - **Who and where the process is.** `USER`/`LOGNAME`/`USERNAME`, `COMPUTERNAME`,
 *   `PWD`, `SHELL`, `TERM`, and the processor/`OS` variables runtimes size their
 *   thread pools from.
 * - **Reaching the network at all.** The proxy and CA-bundle variables, in both
 *   cases POSIX tools disagree about. A server that cannot get out through a
 *   corporate proxy, or cannot validate a corporate TLS interception certificate, is
 *   a server that does not work. `HTTPS_PROXY` is the one entry here that can embed
 *   a password; it stays because the alternative is breaking every user behind such
 *   a proxy, and a server has to reach that proxy to do anything at all.
 *
 * Deliberately absent: anything that IS an identity (`SSH_AUTH_SOCK`, `AWS_*`,
 * `GITHUB_TOKEN`, `*_API_KEY`) — a server that needs one declares it in the client
 * config, which is what `passEnv` carries — and anything that redirects what the
 * child loads (`NODE_OPTIONS`, `PYTHONPATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`),
 * so the proxy's own environment cannot become a way to inject code into the very
 * server Stroq is standing in front of.
 */
export const INFRASTRUCTURE_ENV: readonly string[] = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'NUMBER_OF_PROCESSORS',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'USER',
  'LOGNAME',
  'USERNAME',
  'COMPUTERNAME',
  'PWD',
  'SHELL',
  'TERM',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

/**
 * `LC_ALL`, `LC_CTYPE`, `LC_NUMERIC`, `LC_TIME` and the rest: one family, with more
 * members than are worth naming and no credential among them.
 */
const INFRASTRUCTURE_PREFIXES: readonly string[] = ['LC_'];

/**
 * Windows environment variable names are case-insensitive — `Path` and `PATH` are
 * one variable, and a config file may spell a name in either. Folding the comparison
 * there, and only there, is what keeps such a config working on Windows without
 * letting a POSIX `path` (a different variable, which an attacker with a writable
 * shell profile could set) pass itself off as `PATH`.
 */
const fold = (plat: NodeJS.Platform, name: string): string =>
  plat === 'win32' ? name.toUpperCase() : name;

/**
 * The environment to spawn a wrapped server with: the infrastructure above plus the
 * names the wrapper recorded, and nothing else. `env`/`plat` default to the real
 * process; a test overrides them to exercise one platform's rules without touching
 * either.
 */
export function childEnv(
  passEnv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = new Set([...INFRASTRUCTURE_ENV, ...passEnv].map((name) => fold(plat, name)));
  const prefixes = INFRASTRUCTURE_PREFIXES.map((prefix) => fold(plat, prefix));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const folded = fold(plat, name);
      return allowed.has(folded) || prefixes.some((prefix) => folded.startsWith(prefix));
    }),
  );
}
