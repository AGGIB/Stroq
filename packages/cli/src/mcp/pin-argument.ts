import { commandLine } from '../shell-quote.js';

/** Kept separate from filesystem verification so unpinned hooks do not load Safe Install. */
export const MCP_PIN = /^sha256:[0-9a-f]{64}$/;

/**
 * What a pinned server is refused with when the folder for its verified copy cannot be written: fixed phrases.
 * Inside `stroq run --sandbox` the folder is denied on purpose (see `protectedState`), so a pinned server cannot
 * start there; the first phrase says so, the second is for a folder that cannot be written for another reason.
 */
export const PIN_SANDBOX_PHRASES = [
  'a pinned server cannot be prepared inside the sandbox; start the client outside `stroq run --sandbox` (run it without --sandbox)',
  'a pinned server cannot be prepared: the folder for its verified copy under the Stroq home cannot be written',
] as const;

/** What a wrapper that is not the one `add` confirmed is refused with: fixed phrases, safe to print. */
export const BIND = {
  passEnv: 'the --pass-env of the wrapper is not the one confirmed',
  startFile: 'the start file of the wrapper is not the one confirmed',
  commandLine: 'the command line of the wrapper is not the one confirmed',
  entry: 'the client config entry is not the one confirmed (env, cwd, command or another key)',
  incomparable: 'the command line of the wrapper cannot be compared with the one confirmed',
} as const;
export const BIND_PHRASES: readonly string[] = Object.values(BIND);

/**
 * The one command that confirms a changed wrapper again, with the real name of the server: what `init`, the proxy
 * and `doctor` tell a person to run. The name comes from a lock or a config, so it is quoted by `commandLine` and
 * never becomes a second command.
 */
export const reconfirmCommand = (
  name: string,
  options: { readonly strict?: boolean } = {},
): string =>
  commandLine([
    'stroq',
    'add',
    { positional: name, what: 'name' },
    '--kind',
    'mcp',
    ...(options.strict === true ? ['--strict'] : []),
    '--force',
  ]);
