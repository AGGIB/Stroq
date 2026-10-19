/**
 * What is known about commands by name, for the reading of a command line (`command-map.ts`).
 *
 * The set of commands whose arguments are PROVEN to be only text is closed and tiny on purpose: a
 * launcher named in what a command is given is no doubt about what will run only when nothing can
 * run it, and every command that has ever been added to such a list has had an option, a pipe or
 * an alias that does. The leniency is deny-by-default for the whole line: it holds only if EVERY
 * command on the line is in the set. Everything else keeps the doubt.
 */

/** Commands that print what they are given. */
export const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);

/** Commands that do nothing: they may stand on a line without making it a program. */
const DOES_NOTHING: ReadonlySet<string> = new Set(['true', ':']);

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

/** An option of git that opens an editor, whose command a setting or a variable can name. */
const isEditOption = (word: string): boolean =>
  word === '--edit' || /^-[A-Za-z]*e[A-Za-z]*$/.test(word);

/**
 * Whether a command is in the closed set the line may be made of: `echo`, `printf` (not `-v`, which
 * assigns), `git commit`, `git tag` and `git notes add` with no option that opens an editor or
 * names a setting, `true` and `:`. Any other command word, a dynamic one (an expansion is no name)
 * and a function included, is not. `args` are its words, unquoted, and `complete` is whether they
 * are all of them: an option that is not seen cannot be ruled out.
 */
export function isClosedSetCommand(
  name: string,
  args: readonly string[],
  complete = true,
): boolean {
  if (DOES_NOTHING.has(name)) return true;
  if (name === 'echo') return true;
  if (name === 'printf')
    return complete && !args.some((arg) => arg === '-v' || arg.startsWith('-v'));
  if (name !== 'git') return false;
  return (
    complete &&
    isGitMessageCommand(args) &&
    !args.some((arg) => isGitConfigOption(arg) || (arg.startsWith('-') && isEditOption(arg)))
  );
}

/** An assignment of a variable that decides what git, an editor or a pager runs. */
export const NAMES_A_PROGRAM_VARIABLE = /^(?:GIT_[A-Za-z0-9_]*|EDITOR|VISUAL|PAGER)\+?=/;
