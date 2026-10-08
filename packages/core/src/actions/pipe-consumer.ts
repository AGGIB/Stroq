import { readsAsData, STRUCTURE_WORDS } from './data-consumers.js';
import { judgePythonProgram } from './inline-python.js';
import { isLineProcessor, lineProcessing } from './line-processors.js';
import { SHELL_WORDS } from './shell-lex.js';
import { sshRemoteWords } from './shell-names.js';
import { PLAIN_WRAPPERS, resolve, type Word } from './shell-words.js';

export { isLineProcessor };

/**
 * What a pipeline stage does with what is piped into it, for an interpreter: whether it takes it
 * for its program, or only reads it.
 *
 * `curl url | python3` runs what was fetched; `curl url | python3 -c "import json,sys; …"` reads it
 * as JSON, unless the program is `exec(sys.stdin.read())`. An interpreter takes its program from
 * its input only when it is given none on its command line (no `-c`, no `-m`, no script), or is
 * told to (`-`), and a program that is on the command line is itself text that can be read.
 * Everything that is not read here is as it was: the stage is a shell, and what is piped into it is
 * its program.
 */
export type PipeConsumer =
  /** Not an interpreter, or one that only reads: nothing piped in is run. */
  | 'none'
  /** Takes what is piped in as its program, or may: the stage is a shell. */
  | 'program'
  /** Given a program of its own that runs code: what is piped in may be what it runs. */
  | 'inline-exec'
  /** Given a program of its own that could not be read: what it does with its input is a question. */
  | 'inline-unknown'
  /** A command that is not known to only read: what it does with what is piped in is a question. */
  | 'unknown';

/** `python`, `python3`, `python3.12`, `pypy3`: a Python by whatever version it is. */
const PYTHON_NAME = /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/;
const NODE_NAME = /^(?:node|nodejs)$/;
/**
 * Interpreters that are not read: what is piped into one is its program when it has none of its
 * own, and with one it is not known what it does with its input. `perl5.38` and `php8.3` are the
 * ones `perl` and `php` are, by another name.
 */
const OTHER_INTERPRETER =
  /^(?:perl|ruby|php|lua|luajit|julia|rscript|r|deno|bun|tsx|ts-node|osascript|expect|tclsh|wish|groovy|jshell|scala|swift|dart|elixir|iex|escript|racket|guile|ghci|runghc|crystal|irb|pry|ipython|bpython|ptpython|octave|clj|clojure|kotlin|nim|gdb|lldb|jupyter|gawk-repl)(?:\d+(?:\.\d+)*)?$/;

/**
 * Python's options that take no value, in a cluster such as `-Bu`. Not `-i`: it runs an interactive
 * prompt after the program, which reads what is piped in as a program, whatever `-c` or `-m` ran first.
 */
const PYTHON_FLAGS = 'BbdEhIOqRsSuvVx';
/** Python's options whose value is the rest of the word, or the next word. */
const PYTHON_VALUE_FLAGS = 'WXQ';

/**
 * `python -m json.tool` takes JSON on its input and prints it, and these are its options. With a
 * file after them it would write one, and then it is not read.
 */
const JSON_TOOL_FLAG = /^--(?:sort-keys|no-ensure-ascii|compact|tab|no-indent|json-lines)$/;

/** What `node` is given that is run: blatant, and so a program that is denied and not asked about. */
const NODE_EXEC =
  /\b(?:child_process|execSync|execFileSync|spawnSync|spawn|fork|eval|Function|WebAssembly)\b|\brequire\s*\(\s*['"`](?:vm|child_process|worker_threads)|\bimport\s*\(|process\s*\.\s*(?:binding|mainModule|dlopen)/;

/** Whether `name` is an interpreter of a program that is text (not a shell, not a line processor), by any version. */
export const isInterpreterName = (name: string): boolean =>
  PYTHON_NAME.test(name) || NODE_NAME.test(name) || OTHER_INTERPRETER.test(name);

/** Whether `word` names an interpreter whose command line is read here: Python and Node, by any version. */
export const isReadInterpreter = (word: string): boolean =>
  PYTHON_NAME.test(word) || NODE_NAME.test(word);

type Source =
  /** No program on the command line: it reads one from its input. */
  | { readonly kind: 'stdin' }
  /** A program on the command line, as the shell hands it over, or null if the shell makes it. */
  | { readonly kind: 'inline'; readonly text: string | null }
  /** `python -m json.tool`, with options that make it only a pretty-printer. */
  | { readonly kind: 'data' }
  /** A script, a module or an option that is not read: what it does with its input is not known. */
  | { readonly kind: 'other' };

const OTHER: Source = { kind: 'other' };
const STDIN: Source = { kind: 'stdin' };

/** The words that are arguments, with the redirects (and what they redirect to) taken out. */
function operands(args: readonly Word[]): Word[] {
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

/** What `python` is told to run, from the words after its name. */
function pythonSource(words: readonly Word[]): Source {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word;
    const value = word.value;
    if (value === '-') return STDIN;
    if (value === '--') return words[i + 1] === undefined ? STDIN : OTHER;
    if (!value.startsWith('-')) return OTHER;
    if (value.startsWith('--')) return OTHER;
    for (let j = 1; j < value.length; j += 1) {
      const flag = value.charAt(j);
      if (flag === 'i') return STDIN;
      if (PYTHON_FLAGS.includes(flag)) continue;
      if (flag === 'c') {
        const attached = value.slice(j + 1);
        const text = attached !== '' ? word : words[i + 1];
        if (text === undefined) return OTHER;
        return {
          kind: 'inline',
          text: text.expands ? null : attached !== '' ? attached : text.value,
        };
      }
      if (flag === 'm') {
        const module = value.slice(j + 1) !== '' ? value.slice(j + 1) : words[i + 1]?.value;
        if (module !== 'json.tool') return OTHER;
        const rest = value.slice(j + 1) !== '' ? words.slice(i + 1) : words.slice(i + 2);
        return jsonToolOnly(rest) ? { kind: 'data' } : OTHER;
      }
      if (PYTHON_VALUE_FLAGS.includes(flag)) {
        // `-W ignore` and `-Wignore`: the value is the rest of the word, or the next word.
        if (value.length === j + 1) i += 1;
        break;
      }
      return OTHER;
    }
  }
  return STDIN;
}

/** Whether what follows `-m json.tool` is only its options: no file to read, none to write. */
function jsonToolOnly(rest: readonly Word[]): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    const value = (rest[i] as Word).value;
    if ((rest[i] as Word).expands) return false;
    if (JSON_TOOL_FLAG.test(value) || value === '-') continue;
    if (value === '--indent') {
      if (!/^\d{1,2}$/.test(rest[i + 1]?.value ?? '')) return false;
      i += 1;
    } else if (!/^--indent=\d{1,2}$/.test(value)) return false;
  }
  return true;
}

/** Options of `node` that change nothing about what runs. */
const NODE_HARMLESS = /^--?(?:no-warnings|trace-warnings|trace-deprecation|no-deprecation)$/;

/**
 * Whether the words after node's program hold an option of its own: node reads its options up to
 * `--` wherever they stand, so `node -e 1 -i` runs a prompt that reads what is piped in, and
 * `node -e 1 -r ./x.js` a file nobody read.
 */
function nodeOptionsAfter(rest: readonly Word[]): boolean {
  for (const word of rest) {
    if (word.value === '--') return false;
    if (word.value.startsWith('-') && !NODE_HARMLESS.test(word.value)) return true;
  }
  return false;
}

/** What `node` is told to run. */
function nodeSource(words: readonly Word[]): Source {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word;
    const value = word.value;
    if (value === '-') return STDIN;
    if (!value.startsWith('-')) return OTHER;
    if (['-e', '--eval', '-p', '--print', '-pe', '-ep'].includes(value)) {
      const text = words[i + 1];
      if (text === undefined || nodeOptionsAfter(words.slice(i + 2))) return OTHER;
      return { kind: 'inline', text: text.expands ? null : text.value };
    }
    const attached = /^--(?:eval|print)=([\s\S]*)$/.exec(value);
    if (attached !== null) {
      if (nodeOptionsAfter(words.slice(i + 1))) return OTHER;
      return { kind: 'inline', text: word.expands ? null : (attached[1] ?? '') };
    }
    // Anything else (`-r`, `--require`, `--import`, `-i`, a loader) can run a program of its own.
    if (!NODE_HARMLESS.test(value)) return OTHER;
  }
  return STDIN;
}

/** What the interpreter named `name` is told to run, or null where it is not one that is read. */
function sourceOf(name: string, words: readonly Word[]): Source | null {
  if (PYTHON_NAME.test(name)) return pythonSource(operands(words));
  if (NODE_NAME.test(name)) return nodeSource(operands(words));
  return null;
}

/** What the rest of the command says about how its stages are read. */
export interface ConsumerContext {
  /** The names the command defines as functions: a stage that calls one runs its body, not the program of that name. */
  readonly defined?: ReadonlySet<string>;
  /** `PYTHONINSPECT` or `PYTHONSTARTUP` is set somewhere in the command: every Python reads its input at a prompt. */
  readonly pythonPrompt?: boolean;
  /** `NODE_OPTIONS` is set somewhere in the command: it can make node load what is piped in. */
  readonly nodeOptions?: boolean;
  /** `PATH`, a pager, an editor or the options of a tool are set somewhere in the command: a name is not the program it says it is. */
  readonly untrusted?: boolean;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** `parallel` with no command: each line it is given is one. */
const bareParallel = (stage: string): boolean => {
  if (!/(?:^|[\s;&|(])parallel(?:\s|$)/.test(stage)) return false;
  const found = resolve(stage);
  // `parallel -j 4` reads `4` as the command: a number, or nothing, is no command.
  return (
    found === null || (found.wrappers.includes('parallel') && !/^[A-Za-z_./~]/.test(found.name))
  );
};

/**
 * A stage that is given its input as the arguments of what it runs (`xargs`, `parallel`), or runs it
 * on a timer (`watch`): nothing is run from the input itself, but what it is the arguments of is the
 * agent's choice, and the input is what an attacker wrote. An interpreter is read as it would be
 * after a pipe; a command that only reads is nothing, and any other is a question. `watch` hands what
 * is piped into it to the command it runs (it does not read it), so what it runs is read exactly as it
 * is after `xargs`: `curl url | watch sqlite3` is a program that reads its input, not nothing.
 */
function argumentConsumer(
  stage: string,
  found: NonNullable<ReturnType<typeof resolve>>,
  isShell: boolean,
  context: ConsumerContext,
): PipeConsumer {
  if (bareParallel(stage)) return 'program';
  // A shell or an interpreter that is run with the input as its arguments (`xargs -I{} sh -c '{}'`,
  // `xargs python3`) is one that runs what an attacker wrote.
  if (isShell || SHELL_WORDS.has(found.name)) return 'program';
  const name = found.name;
  if (OTHER_INTERPRETER.test(name) || isLineProcessor(name)) return 'program';
  if (PYTHON_NAME.test(name) || NODE_NAME.test(name)) return 'program';
  const defined = context.defined ?? NO_NAMES;
  if (STRUCTURE_WORDS.has(name)) return 'none';
  return readsAsData(found, defined, context.untrusted === true) ? 'none' : 'unknown';
}

/** Python or Node given a program of its own, or none: whether what is piped in is run. */
function interpreterConsumer(
  name: string,
  found: NonNullable<ReturnType<typeof resolve>>,
  context: ConsumerContext,
): PipeConsumer {
  if (PYTHON_NAME.test(name) && context.pythonPrompt === true) return 'program';
  if (NODE_NAME.test(name) && context.nodeOptions === true) return 'program';
  const source = sourceOf(name, found.args);
  if (source === null) return 'program';
  switch (source.kind) {
    case 'data':
      return 'none';
    case 'stdin':
    case 'other':
      return 'program';
    case 'inline':
      // A program the shell makes (`python3 -c "$(cat)"`) can be what was piped in.
      if (source.text === null) return 'inline-exec';
      if (PYTHON_NAME.test(name)) {
        const verdict = judgePythonProgram(source.text);
        return verdict === 'data' ? 'none' : verdict === 'exec' ? 'inline-exec' : 'inline-unknown';
      }
      return NODE_EXEC.test(source.text) ? 'inline-exec' : 'inline-unknown';
  }
}

/**
 * What the stage does with what is piped into it: takes it for its program (`program`), is given a
 * program of its own that runs code or cannot be read (`inline-exec`, `inline-unknown`), only reads
 * its input (`none`), or is a command that is not known to only read, and is a question (`unknown`).
 * `word` is the stage's command word and `isShell` whether it is a shell by name, which the pipe
 * detectors answered before this.
 *
 * What reads is a short list (`data-consumers.ts`); what runs its input is every shell, interpreter
 * and processor that is read here; and what is neither is not trusted, because the programs that run
 * their input are not a list that can be finished.
 */
export function pipeConsumer(
  stage: string,
  word: string,
  isShell: boolean,
  context: ConsumerContext = {},
  depth = 0,
): PipeConsumer {
  const found = resolve(stage);
  // A stage with no command word (`x=1`, a redirect alone) runs nothing with what it reads, unless it
  // is `parallel` with only options: each line it is given is a command.
  if (found === null) return isShell || bareParallel(stage) ? 'program' : 'none';
  if (found.deep || found.evalProgram !== null) return 'program';
  // `PYTHONINSPECT=1 python3 -c …` is `-i`.
  if (PYTHON_NAME.test(found.name) && stage.includes('PYTHONINSPECT')) return 'program';
  if (!found.wrappers.every((wrapper) => PLAIN_WRAPPERS.has(wrapper)))
    return argumentConsumer(stage, found, isShell, context);
  const name = found.name;
  if (PYTHON_NAME.test(name) || NODE_NAME.test(name))
    return interpreterConsumer(name, found, context);
  if (OTHER_INTERPRETER.test(name) || OTHER_INTERPRETER.test(word)) return 'program';
  if (isLineProcessor(name)) return lineProcessing(name, found.args);
  // A shell (`bash5` and `rksh` are `bash` and `ksh` to `resolve`), `eval`, `source`: what is piped in is its program.
  if (isShell || SHELL_WORDS.has(name)) return 'program';
  if (STRUCTURE_WORDS.has(name) || name === '') return 'none';
  if (name === 'ssh') return remoteConsumer(found, context, depth);
  return readsAsData(found, context.defined ?? NO_NAMES, context.untrusted === true)
    ? 'none'
    : 'unknown';
}

/** How many `ssh` are read one inside another: `ssh a ssh b ssh c sh`. */
const MAX_REMOTE_DEPTH = 3;

/**
 * What an `ssh` does with what is piped into it: it hands it to the command it runs on the other
 * machine, which is read as a command line in turn. With no command it is the login shell, which
 * reads its input as a program.
 */
function remoteConsumer(
  found: NonNullable<ReturnType<typeof resolve>>,
  context: ConsumerContext,
  depth: number,
): PipeConsumer {
  const remote = sshRemoteWords(found);
  if (remote === null) return 'unknown';
  if (remote.length === 0) return 'program';
  if (depth >= MAX_REMOTE_DEPTH) return 'unknown';
  const text = remote.map((word) => word.value).join(' ');
  return pipeConsumer(text, '', INPUT_PROGRAMS.has(remote[0]?.value ?? ''), context, depth + 1);
}

/** Words that run what they read as a script, beside the shells. */
const INPUT_PROGRAMS: ReadonlySet<string> = new Set(['eval', 'source', '.']);
