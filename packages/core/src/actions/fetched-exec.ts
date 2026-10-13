// What a fetch or a decode can be run through when there is no pipe to say so.
//
// `curl url | sh` is a pipe, and the pipe detectors read it (`pipe-consumer.ts`). The same text
// reaches something that runs it by other roads, and every one of them is a natural way to write it:
//
//   $(curl url)                      the command is what the fetch printed
//   x=$(curl url); $x                a variable is the command
//   curl url | { read l; $l; }       a line of it is
//   python3 -c "$(curl url)"         the program of an interpreter is
//   awk "$(curl url)"                so is the script of a processor
//   python3 <(curl url)              or a file that is a pipe
//   x=$(curl url); echo "$x" | sh    a program is given it by a command that is not a fetch
//
// Following what a variable holds is a data-flow analysis, and one that a shell can always outwit
// (`printf -v`, `read`, a name that is a name, an array). What is read here is smaller and does not
// follow anything: a command that runs text it did not write (a command word that is an expansion, an
// interpreter's program that is, a program given its input by a command that is not a fetch) in a
// command that also fetches or decodes. Where the text that is run is itself a fetch, it is
// `curl | sh`; where it may be, it is a question.
import { isLineProcessor } from './line-processors.js';
import { isInterpreterName, type PipeConsumer } from './pipe-consumer.js';
import { SHELL_WORDS, lex } from './shell-lex.js';
import { sshRemoteWords } from './shell-names.js';
import { REDIRECT, readWords, resolve, withoutRedirects, type Word } from './shell-words.js';

/** One text of the command: the command itself, or a text that was read from it (a substitution's inside). */
export interface FetchedExecText {
  /** The stages of each pipeline of it, as the shell cuts them. */
  readonly pipelines: readonly (readonly string[])[];
  /** `$(( … ))`: an expression, whose words are not commands. */
  readonly arithmetic: boolean;
}

export interface FetchedExecInput {
  /** The command as it was written, first, and then each text read from it. */
  readonly texts: readonly FetchedExecText[];
  /** Whether the command, anywhere in it (a substitution's inside too), fetches or decodes. */
  readonly lineFetches: boolean;
  /** Whether a text fetches or decodes. */
  readonly fetches: (text: string) => boolean;
}

export interface FetchedExec {
  /** Text that is a fetch is run: `curl | sh` by another road. */
  readonly encoded: string[];
  /** Text that may be one is run: a question. */
  readonly unparsed: string[];
}

/** A parameter that nothing in a command spells: `$1`, `$@`, `$*`. */
const POSITIONAL = /\$(?:[0-9@*]|\{[0-9@*])/;

/** The variables a word reads: `$x`, `${x}`, `${x:-d}`. */
const VARIABLE_USE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/** A word with a command substitution in it: `$(…)`, a backtick pair. */
const SUBSTITUTION_MADE = /\$\(|`/;

/** A word that is nothing but a parameter's value: `$x`, `${x}`, `${!n}`, `${#x}`. The name is the first group. */
const WHOLE_VARIABLE = /^\$(?:\{[!#]?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/** A word that is a variable, or a path under one: `$x`, `${x}`, `$x/bin/run`. The name is the first group. */
const VARIABLE_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?:\/.*)?$/;

/** The options that give an interpreter or a shell its program: `-c`, `-e`, `-pe`, `-r`, `--eval`. */
const PROGRAM_FLAG = /^(?:-[A-Za-z]*[ceEpr]|--eval|--print|--exec)$/;

/** What tells an interpreter or a shell to take its program from its input: `-`, `-s`, the file that is it. */
const STDIN_PROGRAM = /^(?:-|-s|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

/** The operator of a redirect that is input: a here-string, which holds a word the shell makes. */
const HERE_STRING = '<<<';

/** `command -v $t`: a lookup of what a name is, which runs nothing. */
const LOOKS_UP = /^\s*(?:(?:do|then|else|elif|if|while|until|!|\{)\s+)*command\s+-[vV]\b/;

/**
 * A name where it stands as itself: not a plain read of it (`$x`, `${x}`) and not the end of a longer
 * one. `${x:=word}` and `${x:-word}` name it, and the first gives it a value.
 */
const NAME_AS_ITSELF =
  /(?<![A-Za-z0-9_$])(?:(?<!\$\{)[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_])|(?<=\$\{)[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_}]))/g;

/**
 * The parameters that the shell gives a value without a name being spelled: `read` and `select` set
 * `REPLY`, `mapfile` sets `MAPFILE`, `getopts` sets `OPTARG`, and `$_` is the last word of the command
 * before. A command that never mentions them has made them all the same.
 */
const MADE_BY_THE_SHELL: ReadonlySet<string> = new Set(['_', 'REPLY', 'MAPFILE', 'OPTARG']);

/** Builtins that give a variable a value, and that may be told its name by a word the shell makes. */
const NAMES_A_VARIABLE = new Set([
  'printf',
  'read',
  'mapfile',
  'readarray',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'getopts',
  'let',
  'print',
  'vared',
]);

/** What `unmadeNames` knows of the names of a command. */
interface UnmadeNames {
  /** The command did not make the variable out of something it ran. */
  readonly unmade: (name: string) => boolean;
  /** The command gives the variable a value that is written out, once, and no other way. */
  readonly literal: (name: string) => boolean;
}

/**
 * Which variables the command did not make out of something it ran: a name that it never mentions as
 * itself (the environment gave it its value, as `$HOME` or a directory an earlier command set), and a
 * name that it gives a value that is written out, once, and no other way. A name that is also assigned
 * again, read into (`read x`), counted by a `for`, the operand of `printf -v` or defaulted by
 * `${x:=…}` is not one, whatever its first value was, and no name is one in a command that gives a
 * variable a value by a name that a word the shell makes holds (`printf -v "$n"`). It is one pass over
 * the text: the names that stand as themselves are counted.
 */
function unmadeNames(pipelines: readonly (readonly string[])[]): UnmadeNames {
  const assigned = new Map<string, number>();
  const spelled = new Set<string>();
  const mentioned = new Map<string, number>();
  for (const stages of pipelines)
    for (const stage of stages) {
      // `printf -v "$n"`, `read "$n"`, `declare "$n=…"`: a name that no word of the command spells
      // can be given a value, and no name is known to be what it was written to be.
      const found = resolve(stage);
      if (
        found !== null &&
        NAMES_A_VARIABLE.has(found.name) &&
        found.args.some((word) => word.expands && !word.redirect)
      )
        return { unmade: () => false, literal: () => false };
      for (const word of readWords(stage).words) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(word.value);
        if (match === null) continue;
        const name = match[1] as string;
        assigned.set(name, (assigned.get(name) ?? 0) + 1);
        if (!word.expands && !word.value.includes('+=')) spelled.add(name);
      }
      for (const found of stage.matchAll(NAME_AS_ITSELF))
        mentioned.set(found[0], (mentioned.get(found[0]) ?? 0) + 1);
    }
  const literal = (name: string): boolean =>
    spelled.has(name) && assigned.get(name) === 1 && mentioned.get(name) === 1;
  return {
    unmade: (name) =>
      !MADE_BY_THE_SHELL.has(name) && ((mentioned.get(name) ?? 0) === 0 || literal(name)),
    literal,
  };
}

/** The commands that run inside the substitutions of a word, as texts. */
function substitutionBodies(text: string): string[] {
  if (!text.includes('$(') && !text.includes('`') && !text.includes('<(')) return [];
  return lex(text).nested.map((nested) => text.slice(nested.from, nested.to));
}

/** Whether a stage is given its input by a redirect of its own (`< f`, `<<'EOF'`, `<<< x`): not by a pipe. */
function hasOwnInput(args: readonly Word[]): boolean {
  return args.some((word) => word.redirect && /^\d*<(?!&)/.test(word.value));
}

/** Whether a stage takes its input from a file descriptor that something else opened: `<&3`. */
function readsDescriptor(args: readonly Word[]): boolean {
  return args.some((word) => word.redirect && /^\d*<&/.test(word.value));
}

/** The word a here-string is given, if the shell makes it: `<<< "$x"`. */
function dynamicHereString(args: readonly Word[]): Word | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (!word.redirect) continue;
    const match = REDIRECT.exec(word.value);
    if (match === null || match[2] !== HERE_STRING) continue;
    const operand = word.value.length > match[0].length ? word : args[i + 1];
    if (operand?.expands === true) return operand;
  }
  return null;
}

/**
 * Whether a shell or an interpreter, with these arguments, reads its program from its input: it is
 * given no program (`-c`) and no script, or is told to read it (`-`, `-s`).
 */
function readsItsProgram(args: readonly Word[]): boolean {
  const own = withoutRedirects(args);
  if (own.some((word) => STDIN_PROGRAM.test(word.value))) return true;
  return (
    !own.some((word) => PROGRAM_FLAG.test(word.value)) &&
    !own.some((word) => !word.value.startsWith('-'))
  );
}

export function fetchedExecSignals(input: FetchedExecInput): FetchedExec {
  const encoded: string[] = [];
  const unparsed: string[] = [];
  const fetchesSomewhere = input.lineFetches;
  const fetching = (text: string): boolean => substitutionBodies(text).some(input.fetches);
  // What the command makes of its names is read once, and only if a command word asks.
  let facts: UnmadeNames | undefined;
  const known = (): UnmadeNames => (facts ??= unmadeNames(input.texts[0]?.pipelines ?? []));
  const unmade = (name: string): boolean => known().unmade(name);
  /**
   * Whether a word is text that the command makes as it runs: a substitution, a parameter that nothing
   * in the command spells (`$1`, `$@`), or a variable that the command made out of something it ran.
   */
  const madeAtRunTime = (word: string): boolean =>
    SUBSTITUTION_MADE.test(word) ||
    POSITIONAL.test(word) ||
    [...word.matchAll(VARIABLE_USE)].some((found) => !unmade(found[1] as string));

  /**
   * Whether a word that is a PROGRAM is text that nothing in the command shows: made as the command
   * runs (`madeAtRunTime`), or a parameter that is all of it (`$x`), whose value the environment gave
   * and the command never wrote out. A name is a path or a tool wherever it is a command word
   * (`$HOME/bin/x`, `$EDITOR f`), and that is why a command word has an exemption that a program has
   * not: nobody keeps a program in a variable that a reader of the text can see no value of.
   */
  const programMadeAtRunTime = (word: string): boolean => {
    if (madeAtRunTime(word)) return true;
    const name = WHOLE_VARIABLE.exec(word);
    return name !== null && !known().literal((name[1] ?? name[2]) as string);
  };

  /** Whether a `<( … )` has a word in it that is text made as the command runs. */
  const madeInsideProcessSubstitution = (word: string): boolean =>
    substitutionBodies(word).some((body) =>
      lex(body).pipelines.some((stages) =>
        stages.some((stage) =>
          readWords(stage.text).words.some(
            (inner) => inner.expands && programMadeAtRunTime(inner.value),
          ),
        ),
      ),
    );

  // What `eval` is given is read as `eval` is, and is a text of its own that is not read again here.
  const evaluated = new Set<string>();
  for (const { pipelines, arithmetic } of input.texts) {
    if (arithmetic) continue;
    const lone = pipelines.length === 1 && pipelines[0]?.length === 1 ? pipelines[0][0] : undefined;
    if (lone !== undefined && evaluated.has(lone.trim())) continue;
    for (const stages of pipelines) {
      // Where in this pipeline something fetches, found when it is asked for.
      let fetchesAt: number | undefined;
      const sourced = (): number =>
        (fetchesAt ??= stages.findIndex((stage) => input.fetches(stage)));
      stages.forEach((stage, index) => {
        if (LOOKS_UP.test(stage)) return;
        const found = resolve(stage);
        if (found === null) return;
        const name = found.name;
        // What `eval` is given is read as `eval` is: a program it runs, and not a command word here.
        if (found.evalProgram !== null) evaluated.add(found.evalProgram.text.trim());
        if (found.wrappers.includes('eval') || found.evalProgram !== null) return;

        // The command is made by the shell: `$(curl url)`, `$x`.
        if (name === '$' && /^[$`]/.test(found.word)) {
          const variable = VARIABLE_WORD.exec(found.word)?.[1];
          if (fetching(found.word)) encoded.push('fetched-command-name');
          // A command that a substitution makes is one nobody can name (`$(echo … | rev)`, `$(printf
          // '\x74…')`), and so is one that a printer is given to print (`$(echo touch) m`: what it prints
          // is the command), whether or not the command fetches. In 20,011 commands of a real history,
          // none: nothing is exempt, and `$(pwd)/run.sh` is asked about like the rest.
          else if (SUBSTITUTION_MADE.test(found.word)) unparsed.push('command-from-substitution');
          // A variable that the command did not make out of anything it ran is what it was before it.
          // Of 20,005 commands of the same history, 23 name a command by a variable that a command made
          // (`BT=$(ls …); $BT/apksigner`): that is why this one waits for a fetch.
          else if (fetchesSomewhere && (variable === undefined || !unmade(variable)))
            unparsed.push('fetch-with-dynamic-command');
          return;
        }

        // `ssh host $x`: the command that runs on the other machine is made by the shell.
        if (name === 'ssh') {
          const first = sshRemoteWords(found)?.[0];
          if (first?.expands === true && /^[$`]/.test(first.value)) {
            const variable = VARIABLE_WORD.exec(first.value)?.[1];
            if (fetching(first.value)) encoded.push('fetched-command-name');
            else if (SUBSTITUTION_MADE.test(first.value))
              unparsed.push('command-from-substitution');
            else if (fetchesSomewhere && (variable === undefined || !unmade(variable)))
              unparsed.push('fetch-with-dynamic-command');
          }
          return;
        }

        // `mkfifo p; curl url > p & sh < p`: a pipe that is a file, which no `|` says.
        if (fetchesSomewhere && name === 'mkfifo') unparsed.push('fetch-with-named-pipe');

        const program = SHELL_WORDS.has(name) || isInterpreterName(name) || isLineProcessor(name);
        if (!program) return;
        const args = withoutRedirects(found.args);
        args.forEach((word, i) => {
          if (word.value.startsWith('<(')) {
            if (fetching(word.value)) encoded.push('fetched-process-substitution');
            // The script of a shell or an interpreter that the command makes as it runs
            // (`python3 <(echo "$(… | rev)")`), as `echo … | python3` is. A processor is given its data in
            // that way as often as its script, and an operand after the script is data.
            else if (
              !isLineProcessor(name) &&
              args.slice(0, i).every((before) => before.value.startsWith('-')) &&
              madeInsideProcessSubstitution(word.value)
            )
              unparsed.push('program-from-run-time-text');
            return;
          }
          // A program that has a variable in it (`python3 -c "…$x…"`) is a program; one that is made
          // by the shell (`python3 -c "$x"`, `"$(curl url)"`) is whatever it was made of.
          if (!word.expands || !/^[$`]/.test(word.value)) return;
          // An interpreter's program is what a flag names; a processor's is an operand.
          const given = isLineProcessor(name) || PROGRAM_FLAG.test(args[i - 1]?.value ?? '');
          if (!given) return;
          if (fetching(word.value)) encoded.push('fetched-program-text');
          // An operand of a processor is as likely a file as its script: only a fetch is read there.
          else if (!isLineProcessor(name) && programMadeAtRunTime(word.value))
            unparsed.push('program-from-run-time-text');
        });

        // A program given its input by text that is made as the command runs (`echo "$x" | python3`,
        // `python3 <<< "$(…)"`), or, in a command that fetches, by anything that is not a fetch (a
        // fetch before it in this pipeline is for the pipe detectors).
        if (isLineProcessor(name) || !readsItsProgram(found.args)) return;
        const here = dynamicHereString(found.args);
        if (here !== null) {
          if (fetching(here.value)) encoded.push('fetched-program-text');
          else if (programMadeAtRunTime(here.value)) unparsed.push('program-from-run-time-text');
        } else if (fetchesSomewhere && readsDescriptor(found.args))
          // `exec 3< <(curl url); sh <&3`: a pipe that was opened where no `|` is.
          unparsed.push('fetch-with-program-input');
        else if (index > 0 && !hasOwnInput(found.args)) {
          const earlier = stages.slice(0, index);
          if (
            earlier.some((before) =>
              readWords(before).words.some(
                (word) => word.expands && programMadeAtRunTime(word.value),
              ),
            )
          )
            unparsed.push('program-from-run-time-text');
          else if (fetchesSomewhere && (sourced() === -1 || sourced() >= index))
            unparsed.push('fetch-with-program-input');
        }
      });
    }
  }
  return { encoded: [...new Set(encoded)], unparsed: [...new Set(unparsed)] };
}
