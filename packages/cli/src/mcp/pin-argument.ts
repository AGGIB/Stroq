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
export const BIND_PHRASES = [
  'the --pass-env of the wrapper is not the one confirmed',
  'the start file of the wrapper is not the one confirmed',
  'the command line of the wrapper is not the one confirmed',
  'the client config entry is not the one confirmed (env, cwd, command or another key)',
  'the command line of the wrapper cannot be compared with the one confirmed',
] as const;
