import type { Word } from './shell-words.js';

/**
 * Line and script processors that run what they read as commands in some forms: `awk -f -` and an
 * awk program that calls `system(` or pipes to or from a command, `sed -f -` and a sed program with
 * the GNU `e` command, `make -f -` (a Makefile from the input runs its recipes), `at` and `batch`
 * (the input is the job), `m4` (`syscmd`), `ed` and `ex` (`!cmd`). Each reads data in its other
 * forms: `awk '{print $1}'`, `sed 's/a/b/'`, `make -j4`.
 */
const LINE_PROCESSOR = /^(?:g?awk|mawk|nawk|g?sed|g?make|at|batch|m4|ed|ex)$/;
export const isLineProcessor = (word: string): boolean => LINE_PROCESSOR.test(word);

/** What a line processor does with its input: it runs it, or only reads it. */
export type LineProcessing = 'program' | 'none';

/** The words that are arguments, with the redirects (and what they redirect to) taken out. */
function operandsOf(args: readonly Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (!word.redirect) {
      out.push(word);
      continue;
    }
    // `> out` and `2>&1`: an operator alone takes the next word as its target.
    if (/^(?:\d+|&)?(?:<<<|<<-|<<|<&|<>|<|>>|>&|>\||>)$/.test(word.value)) i += 1;
  }
  return out;
}

/** A file that is the input: `-`, `/dev/stdin`, `/dev/fd/0`. */
const STDIN_FILE = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

/** The words of an option parse: the programs given on the command line, and the files that hold one. */
interface Parsed {
  /** Program text given as the value of an option, or as the first operand when no option gave one. */
  readonly programs: readonly Word[];
  /** A file that holds a program, as written. */
  readonly files: readonly string[];
  /** Every word that is not an option or the value of one: where a program may stand that was not read as one. */
  readonly operands: readonly Word[];
}

interface Kinds {
  /** Short options whose value is a program. */
  readonly program: string;
  /** Short options whose value is a file that holds one. */
  readonly file: string;
  /** Short options that take a value that is neither. */
  readonly valued: string;
  /** Short options that take the rest of the word, and nothing else (`sed -i.bak`). */
  readonly suffixed: string;
  readonly longProgram: RegExp;
  readonly longFile: RegExp;
}

/**
 * Splits the arguments of `awk` or `sed` into the programs on the command line and the files that
 * hold one, as the program reads its options: a short option's value is the rest of its word or the
 * next word, a cluster (`-nf`) is read letter by letter, and `--name=value` has its value attached.
 * The first operand is the program when no option gave one.
 */
function parseProcessor(args: readonly Word[], kinds: Kinds): Parsed {
  const words = operandsOf(args);
  const programs: Word[] = [];
  const files: string[] = [];
  const operands: Word[] = [];
  let given = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word;
    const value = word.value;
    if (value === '--') {
      operands.push(...words.slice(i + 1));
      if (!given && words[i + 1] !== undefined) programs.push(words[i + 1] as Word);
      break;
    }
    if (value.startsWith('--')) {
      const eq = value.indexOf('=');
      const name = eq === -1 ? value : value.slice(0, eq);
      const isProgram = kinds.longProgram.test(name);
      const isFile = kinds.longFile.test(name);
      if (!isProgram && !isFile) continue;
      given = true;
      let operand: Word | undefined;
      if (eq !== -1) operand = { ...word, value: value.slice(eq + 1) };
      else {
        i += 1;
        operand = words[i];
      }
      if (operand === undefined) continue;
      if (isProgram) programs.push(operand);
      else files.push(operand.value);
      continue;
    }
    if (value.startsWith('-') && value.length > 1) {
      for (let j = 1; j < value.length; j += 1) {
        const flag = value.charAt(j);
        const rest = value.slice(j + 1);
        if (kinds.suffixed.includes(flag)) break;
        if (
          !kinds.program.includes(flag) &&
          !kinds.file.includes(flag) &&
          !kinds.valued.includes(flag)
        )
          continue;
        const operand: Word | undefined = rest !== '' ? { ...word, value: rest } : words[i + 1];
        if (rest === '') i += 1;
        if (operand !== undefined) {
          if (kinds.program.includes(flag)) programs.push(operand);
          else if (kinds.file.includes(flag)) files.push(operand.value);
        }
        if (!kinds.valued.includes(flag)) given = true;
        break;
      }
      continue;
    }
    operands.push(word);
    // The first operand is the program, unless an option gave it.
    if (!given) {
      programs.push(word);
      given = true;
    }
  }
  return { programs, files, operands };
}

// -------------------------------------------------------------------------------------------
// awk
// -------------------------------------------------------------------------------------------

/** Words after which a `/` begins a regular expression, not a division. */
const AWK_BEFORE_REGEX = new Set([
  'print',
  'printf',
  'return',
  'in',
  'getline',
  'delete',
  'exit',
  'case',
  'do',
  'else',
]);

/**
 * Whether an awk program runs a command: `system(…)`, and any `|` that is not `||` and not inside a
 * string, a regular expression or a comment, which is an output pipe (`print | cmd`, where `cmd` may
 * be a name or an expression, not only a string) or an input pipe (`cmd | getline`), and `|&`, gawk's
 * coprocess. A program that cannot be read to its end (a string or a regular expression that does
 * not close) is taken to run one.
 */
export function awkRunsCommands(program: string): boolean {
  const n = program.length;
  let i = 0;
  // Whether the token before ends an operand, so that a `/` is a division and not a regular expression.
  let operand = false;
  while (i < n) {
    const ch = program.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
    } else if (ch === '\n') {
      operand = false;
      i += 1;
    } else if (ch === '\\') {
      i += program.charAt(i + 1) === '\n' ? 2 : 1;
    } else if (ch === '#') {
      const eol = program.indexOf('\n', i);
      i = eol === -1 ? n : eol;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < n && program.charAt(j) !== '"') {
        if (program.charAt(j) === '\\') j += 1;
        else if (program.charAt(j) === '\n') return true;
        j += 1;
      }
      if (j >= n) return true;
      i = j + 1;
      operand = true;
    } else if (ch === '/' && !operand) {
      // A regular expression: to the `/` that closes it, outside a bracket expression.
      let j = i + 1;
      let inBracket = false;
      while (j < n) {
        const c = program.charAt(j);
        if (c === '\\') j += 1;
        else if (c === '\n') return true;
        else if (inBracket) inBracket = c !== ']';
        else if (c === '[') inBracket = true;
        else if (c === '/') break;
        j += 1;
      }
      if (j >= n) return true;
      i = j + 1;
      operand = true;
    } else if (ch === '|') {
      if (program.charAt(i + 1) !== '|') return true;
      i += 2;
      operand = false;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(program.charAt(j))) j += 1;
      const word = program.slice(i, j);
      if (word === 'system') return true;
      i = j;
      operand = !AWK_BEFORE_REGEX.has(word);
    } else if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z.]/.test(program.charAt(j))) j += 1;
      i = j;
      operand = true;
    } else if (ch === ')' || ch === ']') {
      i += 1;
      operand = true;
    } else if ((ch === '+' || ch === '-') && program.charAt(i + 1) === ch) {
      // `x++ / 2` divides; `++x` is followed by an operand, never by a `/`.
      i += 2;
    } else {
      i += 1;
      operand = false;
    }
  }
  return false;
}

/** gawk: `-e text` and `--source text` are a program, `-f`, `-E` and `-i` name a file of one. */
const AWK_KINDS: Kinds = {
  program: 'e',
  file: 'fEi',
  valued: 'FvlW',
  suffixed: '',
  longProgram: /^--source$/,
  longFile: /^--(?:file|exec|include)$/,
};

/** What awk does with its input: runs it as a program, or only reads it. */
function awkProcessing(args: readonly Word[]): LineProcessing {
  const { programs, files } = parseProcessor(args, AWK_KINDS);
  if (files.some((file) => STDIN_FILE.test(file))) return 'program';
  return programs.some((word) => word.expands || awkRunsCommands(word.value)) ? 'program' : 'none';
}

// -------------------------------------------------------------------------------------------
// sed
// -------------------------------------------------------------------------------------------

/**
 * A sed script with GNU sed's `e`: the command (`e`, `e cmd`, after an address or a `;`), or the `e`
 * flag of `s` (`s/x/y/e`), under whatever delimiter.
 */
const SED_EXEC_COMMAND = /(?:^|[;{}\n])\s*(?:[0-9$,~+!]|\/(?:\\.|[^/\\])*\/)*\s*e(?:\s|;|}|$)/;
const SED_EXEC_FLAG =
  /(?:^|[;{}\n\s])s([^\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[0-9A-Za-z]*e/;
/** An address with a delimiter of its own (`\,x,`) before the command `e`. */
const SED_EXEC_CUSTOM_ADDRESS =
  /(?:^|[;{}\n])\s*(?:[0-9$,~+!]|\\([^\s\\])(?:\\.|(?!\1)[^\\])*\1|\/(?:\\.|[^/\\])*\/)*[IM]*\s*e(?:\s|;|}|$)/;

const SED_KINDS: Kinds = {
  program: 'e',
  file: 'f',
  valued: 'l',
  suffixed: 'i',
  longProgram: /^--expression$/,
  longFile: /^--file$/,
};

/** What sed does with its input: runs it as a program, or only reads it. */
function sedProcessing(args: readonly Word[]): LineProcessing {
  const { programs, files, operands } = parseProcessor(args, SED_KINDS);
  if (files.some((file) => STDIN_FILE.test(file))) return 'program';
  const runs = (text: string): boolean =>
    SED_EXEC_COMMAND.test(text) || SED_EXEC_FLAG.test(text) || SED_EXEC_CUSTOM_ADDRESS.test(text);
  // BSD sed's `-i ''` takes the next word, so the program may stand where the parse of GNU sed's
  // options did not look: every word that is not an option is read as one too.
  return [...programs, ...operands].some((word) => word.expands || runs(word.value))
    ? 'program'
    : 'none';
}

/** Whether `make` is told to read its Makefile from its input: `-f -`, `-f/dev/stdin`, `--file=-`. */
function makeReadsInput(args: readonly Word[]): boolean {
  const words = operandsOf(args);
  for (let i = 0; i < words.length; i += 1) {
    const value = (words[i] as Word).value;
    const attached = /^(?:-[A-Za-z]*f|--(?:file|makefile)=)([\s\S]*)$/.exec(value);
    if (attached !== null && STDIN_FILE.test(attached[1] ?? '')) return true;
    if (
      /^(?:-[A-Za-z]*f|--file|--makefile)$/.test(value) &&
      STDIN_FILE.test(words[i + 1]?.value ?? '')
    )
      return true;
  }
  return false;
}

/**
 * What the line processor named `name` does with its input. `m4`, `ed` and `ex` take their commands
 * from it; `at` and `batch` take their job from it unless given a file; `awk`, `sed` and `make` are
 * read from their command lines.
 */
export function lineProcessing(name: string, args: readonly Word[]): LineProcessing {
  if (/^(?:g?awk|mawk|nawk)$/.test(name)) return awkProcessing(args);
  if (/^g?sed$/.test(name)) return sedProcessing(args);
  if (/^g?make$/.test(name)) return makeReadsInput(args) ? 'program' : 'none';
  if (name === 'at' || name === 'batch')
    return operandsOf(args).some((word) => /^-[A-Za-z]*f$/.test(word.value)) ? 'none' : 'program';
  return 'program';
}
