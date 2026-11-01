import { commandLine } from '../shell-quote.js';

/** Kept separate from filesystem verification so unpinned hooks do not load Safe Install. */
export const MCP_PIN = /^sha256:[0-9a-f]{64}$/;

/**
 * What a pinned server is refused with when the folder for its verified copy cannot be written: fixed phrases.
 * Inside a sandbox that protects the Stroq home the folder is denied on purpose (see `protectedState`), so a
 * pinned server cannot start there; the first phrase says so, the second is for a folder that cannot be written
 * for another reason.
 */
export const PIN_SANDBOX_PHRASES = [
  'a pinned server cannot be prepared inside the sandbox; start the client outside the sandbox',
  'a pinned server cannot be prepared: the folder for its verified copy under the Stroq home cannot be written',
] as const;

/** What a wrapper that is not the one that was confirmed is refused with: fixed phrases, safe to print. */
export const BIND = {
  passEnv: 'the --pass-env of the wrapper is not the one confirmed',
  startFile: 'the start file of the wrapper is not the one confirmed',
  commandLine: 'the command line of the wrapper is not the one confirmed',
  entry: 'the client config entry is not the one confirmed (env, cwd, command or another key)',
  incomparable: 'the command line of the wrapper cannot be compared with the one confirmed',
} as const;
export const BIND_PHRASES: readonly string[] = Object.values(BIND);

/**
 * The one command that takes the pin out of a wrapper that no longer matches it: what `init`, the proxy and
 * `doctor` tell a person to run. A pin was written by `stroq add`, which 0.30 removed, so a pinned wrapper
 * cannot be confirmed again; it can be unwrapped (which removes the pin and its check at start) and wrapped
 * afresh by `init`.
 */
export const unpinCommand = (): string =>
  commandLine(['stroq', 'init', '--agent', 'mcp', '--unwrap']);
