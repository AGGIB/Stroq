/**
 * What is known about commands by name, for the reading of a command line (`command-map.ts`).
 *
 * The set of commands whose arguments are PROVEN to be only text is closed and tiny on purpose: a
 * launcher named in what a command is given is no doubt about what will run only when nothing can
 * run it, and every command that has ever been added to such a list has had an option, a pipe or
 * an alias that does. Everything outside the set keeps the doubt.
 */

/** Commands that print what they are given. */
export const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);

/** The options of git that take a value before the subcommand: `git -C app commit`. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '--git-dir', '--work-tree']);

/** The options of git that make a command line a program: a setting can name a command to run. */
export const isGitConfigOption = (word: string): boolean =>
  word === '-c' || word === '--config-env' || word.startsWith('--config-env=');

/** The first word of `args` that is not an option of git, skipping the values of those that take one. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
    else if (!arg.startsWith('-')) return arg.toLowerCase();
  }
  return undefined;
}

/** Whether the words so far are those of a git command that takes a message: `commit`, `tag`, `notes add`. */
export function isGitMessageCommand(args: readonly string[]): boolean {
  const subcommand = gitSubcommand(args);
  return (
    subcommand === 'commit' ||
    subcommand === 'tag' ||
    (subcommand === 'notes' && args.some((arg) => arg.toLowerCase() === 'add'))
  );
}

/** A flag that gives git a message: `-m`, `-am`, `--message`. */
export const isMessageFlag = (word: string): boolean =>
  word === '--message' || /^-[A-Za-z]*m$/.test(word);

/** Commands that run a string they are given, or other commands: nothing on a line that holds one is proven inert. */
export const STRING_RUNNERS: ReadonlySet<string> = new Set(['eval', 'source', '.', 'xargs']);

/** Words that make a command line a program: conditions, loops, groups and function bodies. */
export const COMPOUND_WORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'for',
  'select',
  'case',
  'esac',
  'function',
  '{',
  '}',
]);

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
