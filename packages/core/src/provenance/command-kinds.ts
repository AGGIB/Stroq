/**
 * What is known about commands by name, for the reading of a command line (`command-map.ts`): which
 * ones only show their arguments and so make a launcher in them a mention that does nothing, and
 * which ones run a string they are given, so that nothing in a line that holds one is proven
 * inert.
 */

/** Commands that print, search, copy or list what they are given and run none of it. */
const INERT_COMMANDS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'cat',
  'tee',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'ls',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'touch',
  'test',
  '[',
  '[[',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'date',
  'jq',
]);

/** The subcommands of git that take a message or a pattern and run none of it. */
const INERT_GIT: ReadonlySet<string> = new Set([
  'commit',
  'tag',
  'notes',
  'merge',
  'log',
  'grep',
  'show',
  'diff',
  'add',
  'status',
  'stash',
]);

/** The command groups of gh that take a title or a body and send it to GitHub as text. */
const INERT_GH: ReadonlySet<string> = new Set(['pr', 'issue', 'release', 'gist', 'api']);

/** The options of git that take a value before the subcommand: `git -C app commit`. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree']);

/** The first word of `args` that is not an option of git, skipping the values of those that take one. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
    else if (!arg.startsWith('-')) return arg.toLowerCase();
  }
  return undefined;
}

/**
 * Whether a command is known to run nothing of the words it is given: it is on a short list of
 * commands that print or search them, or it is git or gh doing so with a message. A command that
 * is not known to is not proven to. `args` are its first words, unquoted.
 */
export function isInertCommand(name: string, args: readonly string[]): boolean {
  if (INERT_COMMANDS.has(name)) return true;
  if (name === 'git') return INERT_GIT.has(gitSubcommand(args) ?? '');
  if (name === 'gh')
    return INERT_GH.has((args.find((a) => !a.startsWith('-')) ?? '').toLowerCase());
  return false;
}

/** Commands that run a string given with `-c` or `--command`. */
export const RUNS_A_COMMAND_STRING: ReadonlySet<string> = new Set([
  'su',
  'runuser',
  'busybox',
  'ssh',
]);

/** Wrappers that run what they are given as a command line of their own. */
export const RUNS_ITS_ARGUMENTS: ReadonlySet<string> = new Set(['watch', 'parallel', 'script']);

/** The options of `find` that run a command. */
export const FIND_RUNS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
