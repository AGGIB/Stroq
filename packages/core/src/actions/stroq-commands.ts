/**
 * The tables behind `stroq-state.ts`: which words run Stroq, which of its subcommands change
 * what it enforces, and which of them start another program. Tables only, so that the file
 * that reads a command line is the logic and not the lists it reads by.
 */

// -------------------------------------------------------------------------------------------
// Which words run Stroq
// -------------------------------------------------------------------------------------------

export const RUNNERS: ReadonlySet<string> = new Set([
  'npx',
  'pnpx',
  'pnpm',
  'bunx',
  'bun',
  'yarn',
  'npm',
  'node',
]);
/** Words a runner takes before the program it runs. */
export const RUNNER_VERBS: ReadonlySet<string> = new Set([
  'exec',
  'dlx',
  'x',
  'run',
  'recursive',
  'multi',
  'm',
  '--',
]);
/**
 * The options of `npx`, `npm exec`, `pnpm` and `yarn` that are known to take a value: a package, a directory, a
 * cache, a registry. An option that is not here may take one as well, and the word after it is read for that.
 */
export const RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p',
  '--package',
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cache',
  '--cache-folder',
  '--userconfig',
  '--globalconfig',
  '--registry',
  '--cwd',
  '--workspace',
  '--config',
  '--loglevel',
]);
/** A word's program name: no directory, no Windows launcher extension, lower case. */
export const baseName = (word: string): string =>
  word
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:cmd|exe|ps1|bat)$/i, '')
    .toLowerCase();
export const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
]);
export const STROQ_PACKAGE = /^@stroq\/cli(?:@\S*)?$/;
/** The published entry, and the one in a checkout of this repository. */
export const STROQ_ENTRY =
  /(?:[\\/]@stroq[\\/]cli[\\/]dist[\\/]index\.js|(?:^|[\\/])packages[\\/]cli[\\/]dist[\\/]index\.js)$/;

// -------------------------------------------------------------------------------------------
// Which subcommands change state
// -------------------------------------------------------------------------------------------

/** Subcommands that change state whatever follows them. */
export const STATE_COMMANDS: ReadonlySet<string> = new Set([
  'untaint',
  'init',
  'uninstall',
  'prove',
  'add',
  'remove',
  'task',
]);

/**
 * Subcommands that change state only with one of these words after them: `harden status` reads and
 * `harden apply` writes, `permit list` and `permit show` read and `permit extend` and `permit revoke` do
 * not. Any word after the subcommand counts and not only the first, so that an option with a value in front
 * of the verb (`harden --scope user apply`) cannot hide it.
 */
export const STATE_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['harden', new Set(['apply', 'undo', 'forget'])],
  ['permit', new Set(['extend', 'revoke'])],
]);

/** `vet` reads a directory; `vet --online` also goes to the network, and is the form that is denied. */
const isOnlineFlag = (word: string): boolean => word === '--online' || word.startsWith('--online=');

/** Whether the subcommand `sub`, with the words of the command (`args`, `sub` among them), changes state. */
export function subcommandChangesState(sub: string, args: readonly string[]): boolean {
  if (STATE_COMMANDS.has(sub)) return true;
  const after = args.slice(args.indexOf(sub) + 1);
  const verbs = STATE_VERBS.get(sub);
  if (verbs !== undefined) return after.some((word) => verbs.has(word));
  if (sub === 'vet') return args.some(isOnlineFlag);
  if (sub !== 'trust') return false;
  return after.includes('--remove') || after.some((word) => !word.startsWith('-'));
}

// -------------------------------------------------------------------------------------------
// Which subcommands start another program
// -------------------------------------------------------------------------------------------

/**
 * Subcommands that start the program written after their `--`: `stroq run -- claude` starts
 * an agent, and `stroq mcp --server NAME -- npx some-server` starts an MCP server. Whatever
 * stands there runs, so a command of Stroq's own that changes state is one behind them as well
 * (`stroq run -- stroq prove`), and is read as it would be alone.
 */
export const LAUNCHERS: ReadonlySet<string> = new Set(['run', 'mcp']);

/**
 * Subcommands whose words after a `--` belong to another program: the two launchers above, and
 * `task`, whose words are the prompt it starts a run with. A flag there is the program's or
 * the prompt's and not the command's own, which is how the CLI reads them (`ownArgs` in
 * `help.ts`): `stroq task -- "fix --help"` starts a task.
 */
export const PASS_THROUGH: ReadonlySet<string> = new Set([...LAUNCHERS, 'task']);

/** The flags that keep a command open: asking how it works, and a run that changes nothing. */
export const isExemptionFlag = (word: string): boolean =>
  word === '--dry-run' || word === '--help' || word === '-h';
