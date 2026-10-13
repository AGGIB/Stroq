// The agents there is a driver for. Kept apart from the drivers, so that code that only needs the list
// (`stroq doctor` says `proof:` for these and for no other) does not load a driver to read it.

/** The ids of the agents a live check can be run against today. */
export const DRIVEN_AGENTS: readonly string[] = ['claude-code'];
