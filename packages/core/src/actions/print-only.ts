import { readsAsData } from './data-consumers.js';
import { inlinePython } from './pipe-consumer.js';
import type { Stage } from './shell-lex.js';
import { argv } from './shell-word-reader.js';
import { resolve, type Word } from './shell-words.js';

/**
 * Whether a command is a Python program that prints, and nothing else.
 *
 * A program that decodes data (`base64.b64decode(token)`) has nowhere to send the result but its output,
 * and where the output goes is the shell's: the next stage of a pipe may run it, a redirect may write it
 * to a file that is run next, `exec >f` earlier on the line, `eval` or `source` of text the reader does
 * not see, `mapfile -C`, `enable -f` and `trap` can all change where it goes. A list of the ways to do
 * that never converges, so this is a list of the one shape that is known not to: the whole command is a
 * single pipeline of
 *
 *     python | python3  [-I | -S | -E | -B | -u]…  -c  <a literal program>
 *       [ | a filter that prints what it is given and writes no file ]…
 *
 * with no other command on the line (not before it, after it, around it or inside it), no word before
 * the interpreter (an assignment, `env`, `command`, `exec`, a path), and no redirect but
 * `2>&1`, `2>/dev/null` and `>/dev/null`. Anything else is not known to print only, and keeps the answer
 * it had.
 */

/** The interpreters: by these names, as they are written, and not through a path or a version. */
const PYTHON = new Set(['python', 'python3']);
/** Options of the interpreter that take no value and change nothing about what `-c` runs. */
const PYTHON_OPTIONS = new Set(['-I', '-S', '-E', '-B', '-u']);

/** Programs that print what they are given and, with the arguments checked below, write no file. */
const FILTERS: ReadonlySet<string> = new Set([
  'head',
  'tail',
  'grep',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'less',
  'cat',
]);

const NO_FUNCTIONS: ReadonlySet<string> = new Set();

/** A word that is what it says: no quote, no expansion, no redirect, no parenthesis. */
const bare = (word: Word | undefined): word is Word =>
  word !== undefined && !word.quoted && !word.expands && !word.redirect && !word.group;

/** A word that the shell passes on as it reads it (quotes allowed, but no expansion). */
const literal = (word: Word): boolean => !word.expands && !word.group && !word.redirect;

/**
 * The words are redirects of output to /dev/null or `2>&1` and nothing else (a redirect is an operator and
 * its target, glued on or the word after).
 */
function onlyNullRedirects(words: readonly Word[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word;
    if (!word.redirect || word.expands || word.group) return false;
    if (word.value === '2>&1' || word.value === '>/dev/null' || word.value === '2>/dev/null') {
      continue;
    }
    const target = words[i + 1];
    if ((word.value !== '>' && word.value !== '2>') || target === undefined) return false;
    if (target.redirect || target.expands || target.value !== '/dev/null') return false;
    i += 1;
  }
  return true;
}

/** The interpreter given a program that is one word of the line, as the shell hands it over. */
function isLiteralProgram(text: string): boolean {
  const words = argv(text);
  let at = 0;
  const name = words[at];
  if (!bare(name) || !PYTHON.has(name.value)) return false;
  at += 1;
  while (bare(words[at]) && PYTHON_OPTIONS.has((words[at] as Word).value)) at += 1;
  const flag = words[at];
  if (!bare(flag) || flag.value !== '-c') return false;
  const program = words[at + 1];
  if (program === undefined || !literal(program)) return false;
  // What the reader of the program was given is the word, and the whole of it.
  if (inlinePython(text)?.text !== program.value) return false;
  return onlyNullRedirects(words.slice(at + 2));
}

/** `sort -o f`, `sort --output=f`, and any start of the long option that getopt reads as it (`--o f`, `--outp f`). */
const SORT_OUTPUT = /^-[A-Za-z]*o|^--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=|$)/;
const COUNT = /^[+-]?\d+$/;

/** The arguments of `head` and `tail`: a count, with or without the option, and the flags that only quiet. */
function countingArguments(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (/^-(?:\d+|[nc]\+?\d+|[qv]+)$/.test(arg)) continue;
    if ((arg === '-n' || arg === '-c') && COUNT.test(args[i + 1] ?? '')) i += 1;
    else return false;
  }
  return true;
}

/**
 * The arguments of a filter that has a way to write a file or to name a program are the ones that do not:
 * `sort` without `-o`, `uniq` with only its flags (a second operand is the file it writes), `cat` and
 * `less` with only flags (no file to read or to log to).
 */
function quietArguments(name: string, args: readonly string[]): boolean {
  switch (name) {
    case 'head':
    case 'tail':
      return countingArguments(args);
    case 'sort':
      return !args.some((arg) => SORT_OUTPUT.test(arg));
    case 'uniq':
      return args.every((arg) => /^-[cdiuz]+$/.test(arg));
    case 'cat':
      return args.every((arg) => /^-[nbsvAETet]+$/.test(arg));
    case 'less':
      return args.every((arg) => /^-[RSFXNrinq]+$/.test(arg));
    default:
      return true;
  }
}

/** A stage that is one of `FILTERS` by that name, with no wrapper, path or variable, and arguments that write nothing. */
function isFilter(text: string): boolean {
  const words = argv(text);
  const name = words[0];
  if (!bare(name) || !FILTERS.has(name.value)) return false;
  const found = resolve(text);
  if (
    found === null ||
    found.deep ||
    found.evalProgram !== null ||
    found.assigned === true ||
    found.searchChanged === true ||
    found.wrappers.length > 0 ||
    found.word !== name.value ||
    !readsAsData(found, NO_FUNCTIONS)
  )
    return false;
  const redirectsFrom = words.findIndex((word, i) => i > 0 && word.redirect);
  const args = words.slice(1, redirectsFrom === -1 ? undefined : redirectsFrom);
  if (!args.every(literal)) return false;
  if (redirectsFrom !== -1 && !onlyNullRedirects(words.slice(redirectsFrom))) return false;
  return quietArguments(
    name.value,
    args.map((word) => word.value),
  );
}

/** A stage that is not a part of a group, a loop or a job, and is fed by a pipe only when it is not the first. */
const plain = (stage: Stage, piped: boolean): boolean =>
  !stage.background && !stage.compound && stage.heredoc === null && stage.piped === piped;

/**
 * Whether the python stage `pipeline[at]` of the command (`stages`: the pipelines of each text of it, the
 * command first) prints and nothing else: it is the whole command, in the shape above.
 */
export function printsOnly(
  stages: readonly (readonly (readonly Stage[])[])[],
  textIndex: number,
  pipeline: readonly Stage[],
  at: number,
): boolean {
  // The command is this pipeline: no other text read from it (a substitution, a body), no other pipeline.
  if (textIndex !== 0 || at !== 0 || stages.length !== 1 || stages[0]?.length !== 1) return false;
  const [python, ...filters] = pipeline;
  if (python === undefined || !plain(python, false) || !isLiteralProgram(python.text)) return false;
  return filters.every((stage) => plain(stage, true) && isFilter(stage.text));
}
