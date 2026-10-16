/** Kept separate from filesystem verification so unpinned hooks do not load Safe Install. */
export const MCP_PIN = /^sha256:[0-9a-f]{64}$/;

/** What a wrapper that is not the one `add` confirmed is refused with: fixed phrases, safe to print. */
export const BIND_PHRASES = [
  'the --pass-env of the wrapper is not the one confirmed',
  'the start file of the wrapper is not the one confirmed',
  'the command line of the wrapper is not the one confirmed',
  'the client config entry is not the one confirmed (env, cwd, command or another key)',
  'the command line of the wrapper cannot be compared with the one confirmed',
] as const;
