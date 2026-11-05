// Commands that were taken out of the CLI, and what to do instead. Someone who types one (from an
// old README, a script, a search result, or an older `npx @stroq/cli`) gets one line that says it
// is gone and where to go, not "unknown command".
//
// The state gate in `core/src/actions/stroq-commands.ts` still knows every name here, on purpose:
// an older `npx @stroq/cli@<version>` still has these commands, and an agent must not be able to run
// them through a shell any more than it could before.

/** The release that removed them. */
const REMOVED_IN = '0.30';

const VET_INSTEAD =
  "check a skill or MCP server with `stroq vet`, install it with your agent's own command";
const RUN_INSTEAD = 'run your agent as usual; `stroq init` guards it';
const DEV_INSTEAD = 'developer tools, in the repository: `pnpm dev:bench`, `pnpm dev:coverage`';

/** Each removed command, and the words that follow "was removed in 0.30: ". */
const REMOVED: ReadonlyMap<string, string> = new Map([
  ['add', VET_INSTEAD],
  ['remove', VET_INSTEAD],
  ['run', RUN_INSTEAD],
  ['task', RUN_INSTEAD],
  ['permit', RUN_INSTEAD],
  ['harden', "`stroq init` guards your agent; your agent's own deny settings can close key files"],
  ['prove', '`stroq doctor` shows whether the hook is called'],
  ['bench', DEV_INSTEAD],
  ['coverage', DEV_INSTEAD],
]);

/** The names of the commands that were removed. */
export const removedNames = (): readonly string[] => [...REMOVED.keys()];

/**
 * The one line for a removed command, or null for any other word. A Map and not an object, so that
 * `constructor` and `__proto__` are words with no notice and not properties.
 */
export function removedNotice(typed: string): string | null {
  const instead = REMOVED.get(typed);
  return instead === undefined ? null : `stroq ${typed} was removed in ${REMOVED_IN}: ${instead}.`;
}
