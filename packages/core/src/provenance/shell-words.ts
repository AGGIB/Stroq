import { shellWord, type ShellWord } from './shell-word.js';
import { PNPM_VALUE_FLAGS } from './pnpm-options.js';
import { readPackageWord, type PackageWord } from './word-name.js';

/**
 * Reading the words after a runner or an installer as the shell reads them, under one rule. A word
 * in the place of a package is READ when, once the shell has unquoted it, the NAME in it can be
 * told from what follows (see `word-name.ts`); the name is then an atom, whatever the word wraps
 * around it. A word whose name cannot be told (a variable, a command, a brace, a glob inside it)
 * is a DOUBT: what it stands for cannot be read from the command, and the caller counts the
 * command as unread. It is never a package that was quietly not there.
 */

const values = (...flags: string[]): ReadonlySet<string> => new Set(flags);

/** The options that take the word after them as a value, in the tools whose arguments are packages, by tool. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: values(
    '--registry',
    '--prefix',
    '--tag',
    '-w',
    '--workspace',
    '--cache',
    '--otp',
    '--userconfig',
  ),
  npx: values('-c', '--call', '--registry', '--prefix', '--cache', '--userconfig', '--shell'),
  pnpm: PNPM_VALUE_FLAGS,
  // `pnpx` is `pnpm dlx`: the options of pnpm stand before the package, and `dlx` has its own.
  pnpx: PNPM_VALUE_FLAGS,
  yarn: values('--registry', '--cwd', '--cache-folder', '--modules-folder'),
  bun: values('--registry', '--cwd', '-c', '--config', '--cache-dir', '--tag'),
  bunx: values('--registry', '--cwd', '-c', '--config', '--cache-dir'),
  pip: values(
    '-r',
    '--requirement',
    '-c',
    '--constraint',
    '-i',
    '--index-url',
    '--extra-index-url',
    '-t',
    '--target',
    '-e',
    '--editable',
    '--prefix',
    '--root',
    '-f',
    '--find-links',
    '--src',
    '--python',
    '--no-binary',
    '--only-binary',
    '--platform',
    '--python-version',
  ),
  uv: values(
    '-r',
    '--requirement',
    '-c',
    '--constraint',
    '-i',
    '--index-url',
    '--extra-index-url',
    '--index',
    '-e',
    '--editable',
    '-f',
    '--find-links',
    '-p',
    '--python',
    '--git',
    '--branch',
    '--rev',
    '--tag',
    '--path',
    '--with',
    '--with-requirements',
    '--with-editable',
    '--group',
    '--extra',
    '--package',
  ),
  cargo: values(
    '--path',
    '--root',
    '--git',
    '--branch',
    '--rev',
    '--tag',
    '--bin',
    '--features',
    '-F',
    '--version',
    '--registry',
    '--index',
    '--target',
    '--profile',
    '--target-dir',
    '--example',
    '--manifest-path',
    '-j',
    '--jobs',
  ),
  poetry: values('--group', '-G', '--source', '-e', '--python', '--extras', '-E', '--platform'),
  pdm: values('-G', '--group', '-p', '--project', '-r', '--requirement'),
  conda: values('-n', '--name', '-p', '--prefix', '-c', '--channel', '--file', '-f'),
  pipx: values('--python', '--pip-args', '--suffix', '-i', '--index-url'),
  gem: values('-v', '--version', '-s', '--source', '-i', '--install-dir', '-n', '--bindir'),
  bundle: values('--version', '--source', '--git', '--branch', '--path', '--group', '--require'),
  deno: values('--config', '-c', '--import-map', '--lock'),
  go: values('-C', '-o'),
  brew: values(),
};

/** What an unlisted tool takes: the options the first version of this reading skipped. */
const DEFAULT_VALUE_FLAGS = values(
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-t',
  '--target',
  '--registry',
  '--prefix',
);

/** The options of `tool` (its name in the table) that take a value; each tool has its own. */
const valueFlagsOf = (tool: string): ReadonlySet<string> =>
  VALUE_FLAGS[tool] ?? DEFAULT_VALUE_FLAGS;

/** The flags that name a package, by the kind of runner. A flag may carry its value as `--flag=value`. */
const PACKAGE_FLAGS: Readonly<Record<RunnerFamily, ReadonlySet<string>>> = {
  node: new Set(['-p', '--package']),
  python: new Set(['--from', '--with', '--spec', '-w']),
};
/** Flags of a Python runner that take a value that is not a package. */
const PYTHON_VALUE_FLAGS = new Set([
  '-p',
  '--python',
  '--with-requirements',
  '--with-editable',
  '--index',
  '--index-url',
  '--extra-index-url',
]);

export type RunnerFamily = 'node' | 'python';

/** `npx`, `pnpm dlx`, `yarn dlx`, `bunx` and `npm exec` read `-p`; `uvx`, `pipx run` and `uv tool run` read `--from` and `--with`. */
export const runnerFamily = (match: string): RunnerFamily =>
  /^(?:uvx|pipx|uv)\b/i.test(match) ? 'python' : 'node';

/** A short flag with something stuck to it (`-xvalue`), which names a value no one has read. */
const SHORT_FLAG_WITH_VALUE = /^-[A-Za-z][^-]/;
/** A redirection (`>`, `2>&1`, `&>`), which is neither a flag nor a package. */
const REDIRECTION = /^(?:[0-9]*[<>]|&>)/;
const ONLY_AN_OPERATOR = /^(?:[0-9]*[<>]{1,2}|&>>?)$/;

/** A word that is only the mark of a continuation, and is neither a flag nor a package. */
const isContinuationMark = (word: string): boolean => word === '\\';

/** The value a package flag carries: the word after it, or what follows `=` or the short flag. */
function packageFlagValue(
  flag: string,
  next: string | undefined,
  flags: ReadonlySet<string>,
): { raw: string | undefined; skip: boolean } | null {
  if (flags.has(flag)) return { raw: next, skip: true };
  const equals = flag.indexOf('=');
  if (equals > 0 && flags.has(flag.slice(0, equals)))
    return { raw: flag.slice(equals + 1), skip: false };
  if (SHORT_FLAG_WITH_VALUE.test(flag) && flags.has(flag.slice(0, 2))) {
    const value = flag.slice(2);
    return { raw: value.startsWith('=') ? value.slice(1) : value, skip: false };
  }
  return null;
}

/**
 * The packages in the value of a package flag, which may name several, separated by commas
 * (`--with a,b`), and whether the value is a doubt: it is empty, or one of them cannot be read.
 */
/** The packages a word names: the one in it, and the one an alias in it stands for. */
const namesOf = (word: PackageWord): string[] =>
  [word.name, word.target].filter((name): name is string => name !== undefined);

function flagPackages(value: ShellWord, command: boolean): { packages: string[]; doubt: boolean } {
  const packages: string[] = [];
  let doubt = command && value.word === '';
  let from = 0;
  for (const piece of value.word.split(',')) {
    const literal = value.literal.slice(from, from + piece.length);
    from += piece.length + 1;
    if (piece === '') continue;
    const word = readPackageWord({ word: piece, open: value.open, literal });
    packages.push(...namesOf(word));
    doubt = doubt || (command && word.doubt);
  }
  return { packages, doubt };
}

/** What a runner's words say about its packages. */
export interface RunnerReading {
  /** The value of every package flag, and the first word that is not a flag. */
  readonly packages: string[];
  /**
   * The first word that is not a flag was reached, which settles the packages: nothing after it
   * can add one. False when the words ran out first, and a later package flag may still name one.
   */
  readonly sure: boolean;
  /** A word that should have named a package is a doubt (see `readPackageWord`). */
  readonly doubt: boolean;
}

/**
 * What is known about the line the words of a command were taken from. A command read by its
 * words (`lexed`) has had its quotes, separators and redirections taken out already. A line that
 * was only split at blanks has not, and once a word in it opens a quote that never closes in that
 * word, the quote state of every word after it is unknown: a closer or a redirection in a later word
 * ends and skips nothing, and the words are read on as one quoted run would be.
 */
class LineState {
  quoteOpen = false;

  constructor(private readonly lexed: boolean) {}

  /** Whether the closers and redirections of the words can be taken for what they look like. */
  get syntaxIsKnown(): boolean {
    return !this.lexed && !this.quoteOpen;
  }

  /** Whether the word is the end of the command (`&`) or a redirection to step over, and how many words it takes. */
  stepOver(token: string): number {
    if (this.lexed) return 0;
    if (token.startsWith('#') && !this.quoteOpen) return -1;
    if (!this.syntaxIsKnown) return 0;
    if (token === '&') return -1;
    if (!REDIRECTION.test(token)) return 0;
    return ONLY_AN_OPERATOR.test(token) ? 2 : 1;
  }

  /** Takes in what a package word showed about the line, and says whether it ended the command. */
  after(word: PackageWord): boolean {
    const ended = word.ends && this.syntaxIsKnown;
    if (word.opensQuote) this.quoteOpen = true;
    return ended;
  }
}

/**
 * The packages a runner resolves: the value of every package flag of its kind (see
 * `PACKAGE_FLAGS`; `-p`, `--package`, `--package=x`, `-p=x`, `-px` for `npx`; `--from`, `--with`,
 * `-w` for `uvx`), split at commas, and the first word that is not a flag, whether or not a flag
 * named one. A package flag with no value, or with a value that cannot be read, is a doubt.
 */
export function readRunner(
  tokens: readonly string[],
  family: RunnerFamily,
  doubts: boolean,
  lexed = false,
  takesPositional = true,
  tool = '',
): RunnerReading {
  const fromFlags: string[] = [];
  const packageFlags = PACKAGE_FLAGS[family];
  const valueFlags = valueFlagsOf(tool);
  const line = new LineState(lexed);
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const step = line.stepOver(token);
    if (step === -1) break;
    if (step > 0) {
      i += step - 1;
      continue;
    }
    const read = shellWord(token);
    if (isContinuationMark(read.word)) continue;
    const flag = packageFlagValue(read.word, tokens[i + 1], packageFlags);
    if (flag !== null) {
      const value = flagPackages(shellWord(flag.raw ?? ''), doubts);
      fromFlags.push(...value.packages);
      doubt = doubt || (flag.raw !== undefined && value.doubt);
      if (flag.skip) i += 1;
      continue;
    }
    if (valueFlags.has(read.word) || (family === 'python' && PYTHON_VALUE_FLAGS.has(read.word))) {
      i += 1;
      continue;
    }
    if (read.word.startsWith('-')) {
      // A short flag with a value stuck to it that is not one of the runner's own names a value
      // nobody has read (a Python runner's `-p3.12` is its interpreter).
      const isInterpreter = family === 'python' && read.word.startsWith('-p');
      doubt = doubt || (doubts && SHORT_FLAG_WITH_VALUE.test(read.word) && !isInterpreter);
      continue;
    }
    const word = readPackageWord(read);
    return {
      packages: takesPositional ? [...fromFlags, ...namesOf(word)] : fromFlags,
      sure: true,
      doubt: doubt || (doubts && word.doubt),
    };
  }
  return { packages: fromFlags, sure: false, doubt };
}

/** Every package an installer's words name, and whether a word that should have named one is a doubt. */
export function readInstaller(
  tokens: readonly string[],
  doubts: boolean,
  lexed = false,
  tool = '',
): { packages: string[]; doubt: boolean } {
  const packages: string[] = [];
  const valueFlags = valueFlagsOf(tool);
  const line = new LineState(lexed);
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const step = line.stepOver(token);
    if (step === -1) break;
    if (step > 0) {
      i += step - 1;
      continue;
    }
    const read = shellWord(token);
    if (isContinuationMark(read.word)) continue;
    if (valueFlags.has(read.word)) {
      i += 1;
      continue;
    }
    const word = readPackageWord(read);
    packages.push(...namesOf(word));
    doubt = doubt || (doubts && word.doubt);
    if (line.after(word)) break;
    if (word.skipsNext && line.syntaxIsKnown) i += 1;
  }
  return { packages, doubt };
}
