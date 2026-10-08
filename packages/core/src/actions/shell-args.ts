import { stdinPath } from './shell-escapes.js';
import { REDIRECT, type Word } from './shell-words.js';

/**
 * The arguments of a shell, read the way a shell reads its own: where its program comes from, when
 * it is not named by a script file.
 */

/** Where a shell's standard input comes from when it is redirected: the last redirect wins. */
export interface StdinSource {
  /** `unknown`: another descriptor, `<&3`, or a path that names a stream this cannot read. */
  readonly kind: 'file' | 'here' | 'unknown';
  readonly value: string;
  /** The word expands before the shell sees it, so `value` is not what the shell is given. */
  readonly dynamic: boolean;
}

export interface ShellArgs {
  /**
   * Script files the invocation names: the operand, and with `-s` the operands, which are
   * arguments to a program that arrives on standard input and may well be files it runs.
   */
  readonly files: readonly string[];
  /** The text inside each `<( … )` that is the operand: a command whose output is the program. */
  readonly commands: readonly string[];
  /** The last redirect of standard input, when there is one. */
  readonly stdin: StdinSource | null;
  /** No script operand: the program is whatever arrives on standard input. */
  readonly readsStdin: boolean;
  /** `-c` (a string) or `-n` (a syntax check): no file is the program. */
  readonly inline: boolean;
  /** With `-c`, where the string stands among the words: the program the shell was given. */
  readonly inlineAt: number | null;
  /** The script operand is a stream this cannot name: `/dev/fd/3`, `/proc/1234/fd/0`, `/dev/std?n`. */
  readonly unknown: boolean;
  /** Files an interactive shell runs before it reads anything else: `--rcfile x.sh`, `--init-file x.sh`. */
  readonly startup: readonly string[];
}

/** Options of a shell whose next word is their value, not the script. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
]);
/** Options whose value is a file the shell runs as it starts. */
const STARTUP_OPTIONS: ReadonlySet<string> = new Set(['--rcfile', '--init-file']);
/** Tokens that end a command or are left over from its grouping: not words of the shell's own. */
const IGNORED_TOKENS: ReadonlySet<string> = new Set(['&', ';', '(', ')', '}', '']);

type Operand = { readonly file: string } | { readonly command: string };

/** What the reading of a shell's arguments asks of a word. */
interface Arg {
  readonly value: string;
  readonly expands: boolean;
  /** The word begins with an unquoted redirect operator: a quoted `'>x'` is a file's name. */
  readonly redirect: boolean;
  /** An unquoted expansion may be empty, and then it is no word at all. */
  readonly vanishes: boolean;
}

function toArg(word: string | Word, expands: boolean | undefined): Arg {
  if (typeof word === 'string')
    return {
      value: word,
      expands: expands === true,
      redirect: processSubstitution(word) === null && REDIRECT.test(word),
      vanishes: false,
    };
  return {
    value: word.value,
    expands: word.expands,
    redirect: word.redirect,
    vanishes: word.expands && !word.quoted,
  };
}

/** The text inside `<( … )` and zsh's `=( … )`, when the token is a process substitution that is closed. */
function processSubstitution(token: string): string | null {
  return (token.startsWith('<(') || token.startsWith('=(')) && token.endsWith(')')
    ? token.slice(2, -1)
    : null;
}

/** What an option word before the script says, and how many words after it are its value. */
interface OptionEffect {
  readonly inline: boolean;
  /** `-c`: the first operand is a program, not a file. */
  readonly string: boolean;
  readonly argumentsOnly: boolean;
  readonly skip: number;
}

const PLAIN_OPTION: OptionEffect = { inline: false, string: false, argumentsOnly: false, skip: 0 };

/** The effect of an option, or null when the token is not one. */
function optionEffect(token: string): OptionEffect | null {
  if (token === '--noexec') return { ...PLAIN_OPTION, inline: true };
  // Letters captured, then tested: one regex over a long word of them is quadratic.
  const letters = /^-([A-Za-z]+)$/.exec(token)?.[1];
  if (letters !== undefined)
    return {
      inline: letters.includes('c') || letters.includes('n'),
      string: letters.includes('c'),
      argumentsOnly: letters.includes('s'),
      skip: /[oO]$/.test(letters) ? 1 : 0,
    };
  if (VALUE_OPTIONS.has(token)) return { ...PLAIN_OPTION, skip: 1 };
  return token.startsWith('-') || token.startsWith('+') ? PLAIN_OPTION : null;
}

/** What a redirect of standard input makes the shell's input: a file, a text, or a stream unseen. */
function inputOf(operator: string, value: string, dynamic: boolean): StdinSource | null {
  if (operator === '<<<') return { kind: 'here', value, dynamic };
  if (operator === '<&') {
    // `<&0` leaves the input as it is, `<&-` closes it; any other descriptor is a stream unseen.
    return value === '0' || value === '-' ? null : { kind: 'unknown', value, dynamic };
  }
  if (operator !== '<' && operator !== '<>') return null;
  const path = stdinPath(value);
  if (path === 'stdin') return null;
  return { kind: path === null ? 'file' : 'unknown', value, dynamic };
}

/** A redirect at `i`: where the reading resumes, and the standard input it sets, if it sets one. */
function redirectAt(
  args: readonly Arg[],
  i: number,
): { readonly next: number; readonly stdin: StdinSource | null } | null {
  const arg = args[i] as Arg;
  const redirect = REDIRECT.exec(arg.value);
  if (redirect === null) return null;
  const glued = arg.value.slice(redirect[0].length);
  const following = args[i + 1];
  // `< <(cmd)`: the substitution that follows is read as an operand of its own.
  if (
    glued === '' &&
    redirect[2] === '<' &&
    following !== undefined &&
    !following.redirect &&
    processSubstitution(following.value) !== null
  )
    return { next: i, stdin: null };
  const target = glued === '' ? following : arg;
  const standardInput = redirect[1] === undefined || redirect[1] === '0';
  const stdin = standardInput
    ? inputOf(
        redirect[2] as string,
        glued === '' ? (following?.value ?? '') : glued,
        target?.expands === true,
      )
    : null;
  return { next: glued === '' ? i + 1 : i, stdin };
}

/**
 * The words after a shell, read the way a shell reads its own arguments. Options come first and
 * the script is the first word that is not one: after the script, `-c` and `-n` belong to the
 * script. A redirect is not a word and never the script (`bash 2>/dev/null x.sh`,
 * `bash >out < x.sh`), `&` ends the command, and `-s` makes the operands arguments to a program
 * that arrives on standard input. A shell given a string (`-c`) or only asked to check syntax
 * (`-n`) runs no file. A word that is quoted is a name and not an operator (`bash '>x'` runs the
 * file `>x`); `expands` says, for words given as text, which the shell would expand.
 */
export function parseShellArgs(
  rest: readonly (string | Word)[],
  expands: readonly boolean[] = [],
): ShellArgs {
  const args = rest.map((word, i) => toArg(word, expands[i]));
  const operands: Operand[] = [];
  let stdin: StdinSource | null = null;
  let inline = false;
  let argumentsOnly = false;
  let stdinOperand = false;
  let unknownOperand = false;
  let firstVanishes = false;
  const startup: string[] = [];
  // `--rcfile <(cmd)`: the file the shell runs as it starts is what a command prints.
  const startupCommands: string[] = [];
  let wantsString = false;
  let inlineAt: number | null = null;
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Arg;
    const token = arg.value;
    if (!arg.redirect && IGNORED_TOKENS.has(token)) continue;
    const substituted = arg.redirect ? null : processSubstitution(token);
    const redirect = substituted === null && arg.redirect ? redirectAt(args, i) : null;
    if (substituted !== null) {
      operands.push({ command: substituted });
      options = false;
    } else if (redirect !== null) {
      i = redirect.next;
      stdin = redirect.stdin ?? stdin;
    } else if (options && token === '--') options = false;
    else {
      const effect = options ? optionEffect(token) : null;
      if (effect !== null) {
        const attached = /^--(?:rcfile|init-file)=(.+)$/.exec(token)?.[1];
        if (attached !== undefined) startup.push(attached);
        else if (STARTUP_OPTIONS.has(token) && args[i + 1] !== undefined) {
          const file = args[i + 1] as Arg;
          const made = file.redirect ? null : processSubstitution(file.value);
          if (made === null) startup.push(file.value);
          else startupCommands.push(made);
        }
        inline ||= effect.inline;
        wantsString ||= effect.string;
        argumentsOnly ||= effect.argumentsOnly;
        i += effect.skip;
        continue;
      }
      // Options end at the first operand: after it, `-c` and `-n` are the script's arguments.
      options = false;
      if (wantsString && inlineAt === null) inlineAt = i;
      if (operands.length === 0 && arg.vanishes) firstVanishes = true;
      const path = operands.length === 0 ? stdinPath(token) : null;
      if (path === 'stdin') stdinOperand = true;
      else if (path !== null) unknownOperand = true;
      else operands.push({ file: token });
    }
  }
  return finishArgs(
    operands,
    stdin,
    { inline, argumentsOnly, stdinOperand, unknownOperand, firstVanishes },
    inlineAt,
    startup,
    startupCommands,
  );
}

function finishArgs(
  operands: readonly Operand[],
  stdin: StdinSource | null,
  flags: {
    readonly inline: boolean;
    readonly argumentsOnly: boolean;
    readonly stdinOperand: boolean;
    readonly unknownOperand: boolean;
    /** The script operand is an unquoted expansion: empty, it is gone, and the shell reads input. */
    readonly firstVanishes: boolean;
  },
  inlineAt: number | null,
  startup: readonly string[],
  startupCommands: readonly string[],
): ShellArgs {
  const fileOperands = operands.flatMap((o) => ('file' in o ? [o.file] : []));
  const commandOperands = [
    ...operands.flatMap((o) => ('command' in o ? [o.command] : [])),
    ...startupCommands,
  ];
  const base = { stdin, inline: flags.inline, inlineAt, unknown: flags.unknownOperand, startup };
  if (flags.inline) return { ...base, files: [], commands: startupCommands, readsStdin: false };
  // With `-s`, `bash -s < <(cmd)` and `bash -s <(cmd)`: a process substitution is the program
  // on standard input or an argument it runs; either way, its output is read as a program.
  if (flags.argumentsOnly || flags.stdinOperand)
    return {
      ...base,
      files: flags.argumentsOnly ? fileOperands : [],
      commands: commandOperands,
      readsStdin: true,
    };
  const first = operands[0];
  if (first === undefined)
    return { ...base, files: [], commands: startupCommands, readsStdin: true };
  return {
    ...base,
    files: 'file' in first ? [first.file] : [],
    commands: ['command' in first ? first.command : null, ...startupCommands].filter(
      (c): c is string => c !== null,
    ),
    readsStdin: flags.firstVanishes,
  };
}
