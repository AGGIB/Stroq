import { parseShellArgs, type ShellArgs, type StdinSource } from './shell-args.js';
import { expandHeredoc } from './shell-escapes.js';
import {
  SHELL_WORDS,
  lex,
  lostPipe,
  newLexState,
  skipSubstitution,
  type Stage,
} from './shell-lex.js';
import {
  ASSIGNED_SHELL,
  CLOSERS,
  OVERRIDES_PRINTERS,
  PLACEHOLDER_PROGRAM,
  SHELL_VARIABLE,
  bodyMayRunShell,
  fedByArguments,
  globNamesShell,
  lastShellWordAt,
  lastShellWordIn,
  mayHandInputToShell,
  mayHandShell,
  mentionsShell,
  shellOf,
  sourcesProgram,
} from './shell-names.js';
import {
  NO_NAMES,
  functionBodies,
  hooksRun,
  mergeNames,
  namesIn,
  namesMentioned,
  namesOfText,
  withoutFunction,
  type Names,
} from './program-names.js';
import { isInitSubstitution } from './init-tools.js';
import { givenText, printed, reader } from './shell-print.js';
import { splitCommand, type SplitCommand } from './shell-segments.js';
import {
  PLAIN_WRAPPERS,
  baseOf,
  groupMarks,
  resolve,
  type Resolved,
  type Word,
} from './shell-words.js';

/**
 * What a shell is handed to run, when it is not handed a script by name.
 *
 * A shell given no script and no `-c` string reads its program from standard input, and the
 * command line then shows only a pipe and a shell: `echo 'rm -rf ~' | bash`, `cat x.sh | bash`,
 * `bash <<< '…'`, `bash < x.sh`, `bash <(cat x.sh)`. The program is somewhere else, and the
 * classifier has to go and look. Three outcomes, and the third is the one that keeps the others
 * honest:
 *
 *  - the source is text printed literally (`echo`, `printf`): `texts`, read as commands;
 *  - the source is a file (`cat x.sh`, `< x.sh`): `files`, read as scripts;
 *  - the source is anything else, or a program whose command word depends on a variable, a
 *    substitution, a glob or a brace expansion, or anything this reading is not sure it read:
 *    `opaque`. A shell running a program nobody can read is asked about, so an evasion that
 *    defeats the decoding ends in a question and not in a silent allow.
 *
 * The hook has one thread and a host that times it out treats that as an allow, so everything
 * here is a single pass over its input, builds nothing it has not first bounded, and shares one
 * budget across every level of nesting.
 */
export interface ShellInput {
  readonly texts: readonly string[];
  /** Where each text runs, as the `cd`s before it left the command: null is the directory it began in. */
  readonly directories: readonly (string | null)[];
  /** Whether each text runs on another machine: it is the program of a shell `ssh` started. */
  readonly remote: readonly boolean[];
  readonly files: readonly string[];
  readonly opaque: boolean;
}

const NOTHING: readonly never[] = Object.freeze([]);
export const NO_INPUT: ShellInput = Object.freeze({
  texts: NOTHING,
  directories: NOTHING,
  remote: NOTHING,
  files: NOTHING,
  opaque: false,
});
const OPAQUE: ShellInput = Object.freeze({
  texts: NOTHING,
  directories: NOTHING,
  remote: NOTHING,
  files: NOTHING,
  opaque: true,
});

/** How much decoded text one command may add up to, all levels together, as a multiple of itself. */
const TEXT_BUDGET_FACTOR = 2;
const TEXT_BUDGET_FLOOR = 65_536;
const TEXT_BUDGET_CEILING = 4 * 1024 * 1024;
/** How deep programs handed to shells are read in turn: `echo 'echo "…" | bash' | bash`. */
const MAX_PROGRAM_DEPTH = 3;
/** The most texts one level of one command is analysed in. */
const MAX_TEXTS = 256;

/** A meter of the decoded text a command may add up to: shared by every level that reads it. */
export interface Budget {
  room: number;
}

export function newBudget(length: number): Budget {
  return { room: Math.min(TEXT_BUDGET_FACTOR * length + TEXT_BUDGET_FLOOR, TEXT_BUDGET_CEILING) };
}

// -------------------------------------------------------------------------------------------
// Where the program comes from
// -------------------------------------------------------------------------------------------

/** What one analysis carries from stage to stage. */
interface Context {
  readonly budget: Budget;
  /** What this text and the ones it was found in give names to. */
  readonly names: Names;
  readonly text: string;
  /** Where the body of each compound command begins and ends in the text. */
  readonly bodies: Bodies;
  /** How much text may still be searched for a shell in the bodies of compound commands. */
  readonly scanRoom: { left: number };
}

/** Where the stages of a pipeline stand, and what each runs. */
interface Pipeline {
  readonly stages: readonly Stage[];
  readonly commands: readonly (Resolved | null)[];
}

/**
 * What the commands before a stage have done to where it reads and what it inherits. One
 * object, updated stage by stage: a stack of directories to come back to cannot be copied at
 * each of a hundred thousand parentheses.
 */
interface Walk {
  /** Where `cd` has left the stages after it, or null while that is the directory it began in. */
  directory: string | null;
  /** The input a shell inherits from `exec < file` or `exec <<< text` before it. */
  exec: StdinSource | null;
  /** The directories to return to when a subshell ends: `(cd sub)` leaves the command where it was. */
  readonly saved: (string | null)[];
  /**
   * The directories the command was in before a `cd`: it may not have happened (`cd nope; …`,
   * `false && cd sub`, a `cd` that is a function), so what is named is looked for there too.
   */
  readonly previous: (string | null)[];
}

const merge = (parts: readonly ShellInput[]): ShellInput => {
  const texts = parts.flatMap((p) => p.texts);
  const directories = parts.flatMap((p) => p.directories);
  const remote = parts.flatMap((p) => p.remote);
  const files = parts.flatMap((p) => p.files);
  const opaque = parts.some((p) => p.opaque);
  return texts.length === 0 && files.length === 0 && !opaque
    ? NO_INPUT
    : { texts, directories, remote, files, opaque };
};

/**
 * Whether a program given as text runs something an expansion names: `"$cmd"`, `$(find-tool) x`.
 * An expansion among the arguments (`sh -c "tail -f $FIFO"`, `echo "rm -rf $dir"`) is not asked
 * about: the text says what runs, and a value that adds a command to it is a variable the command
 * itself would have had to set.
 */
function runsExpansion(text: string): boolean {
  return lex(text).pipelines.some((stages) =>
    stages.some((stage) => {
      const command = resolve(stage.text);
      return command !== null && (command.name === '$' || command.deep);
    }),
  );
}

/**
 * A program given as text: spent from the budget, and unread if it is not what the text says.
 * `dynamic` says the text depends on a variable, a substitution, a glob or a brace; that makes
 * the program unreadable when it is the command that depends on it. `unknown` says the text is not
 * what the command line prints, and that cannot be told.
 */
function program(
  ctx: Context,
  text: string,
  dynamic: boolean,
  walk: Walk,
  unknown = false,
): ShellInput {
  const unread =
    ctx.names.overridden || unknown || (dynamic && (text === '' || runsExpansion(text)));
  if (text === '') return unread ? OPAQUE : NO_INPUT;
  if (text.length > ctx.budget.room) return OPAQUE;
  ctx.budget.room -= text.length;
  return {
    texts: [text],
    directories: [walk.directory],
    remote: [false],
    files: NOTHING,
    opaque: unread,
  };
}

const filesOf = (walk: Walk, names: readonly string[]): ShellInput => ({
  texts: NOTHING,
  directories: NOTHING,
  remote: NOTHING,
  files: names
    .filter((n) => n !== '/dev/null')
    .flatMap((n) =>
      [...new Set([walk.directory, ...walk.previous])].map((where) => withDirectory(where, n)),
    ),
  opaque: false,
});

const withDirectory = (directory: string | null, file: string): string =>
  directory === null || /^[/~$]/.test(file) || /^[A-Za-z]:/.test(file)
    ? file
    : `${directory}/${file}`;

/** The most earlier directories kept: a long chain of `cd` goes on, and keeps the first ones. */
const MAX_PREVIOUS = 3;

/** No real path is this long; a chain of `pushd a` would otherwise grow it with every step. */
const MAX_DIRECTORY_CHARS = 4096;

/** `cd sub`, `cd /tmp`, `cd`: where the stages after it look for the files they name. */
function nextDirectory(directory: string | null, command: Resolved): string | null {
  if (command.name !== 'cd' && command.name !== 'pushd') return directory;
  const target = command.args.find((w) => w.value === '-' || !w.value.startsWith('-'));
  if (target === undefined) return '~';
  if (target.value === '-') return directory;
  if (target.expands || /^[A-Za-z]:/.test(target.value)) return null;
  if (/^[/~]/.test(target.value)) return target.value;
  const next = directory === null ? target.value : `${directory}/${target.value}`;
  return next.length > MAX_DIRECTORY_CHARS ? directory : next;
}

/** A stage opens subshells: the command comes back to where it is when they end. */
function enter(walk: Walk, stage: Stage): void {
  for (let n = groupMarks(stage.text).opens; n > 0; n -= 1) walk.saved.push(walk.directory);
}

/**
 * The effect of one stage's own command on the walk: its `cd`, and its `exec`. A `cd` that is one
 * stage of a pipeline, or runs in the background, happens in a subshell and changes nothing here.
 */
function advance(walk: Walk, command: Resolved, line: Pipeline, stage: Stage): void {
  if (line.stages.length === 1 && !stage.background) {
    const next = nextDirectory(walk.directory, command);
    if (next !== walk.directory && walk.previous.length < MAX_PREVIOUS)
      walk.previous.push(walk.directory);
    walk.directory = next;
  }
  walk.exec = nextExec(walk.exec, command);
}

/** A subshell ends: the command is back where it was before it began. */
function leave(walk: Walk, stage: Stage): void {
  for (let n = groupMarks(stage.text).closes; n > 0 && walk.saved.length > 0; n -= 1) {
    // The directory it began in can be null (the command's own): that is a value, not a gap.
    walk.directory = walk.saved.pop() as string | null;
  }
}

/** `exec <<< 'x'` and `exec < file`, with no command: the shells after it inherit that input. */
function nextExec(exec: StdinSource | null, command: Resolved): StdinSource | null {
  if (command.name !== 'exec') return exec;
  return parseShellArgs(command.args).stdin ?? exec;
}

/** The text of a `$( … )` that is the whole of a word, or null. */
function wholeSubstitution(value: string): string | null {
  if (!value.startsWith('$(')) return null;
  const state = newLexState();
  const end = skipSubstitution(value, 2, state);
  return end === value.length && !state.uncertain && value.endsWith(')')
    ? value.slice(2, -1)
    : null;
}

/** A file's name that expands: the file it names is not the one the text says. */
const EXPANDING_NAME = /[$`*?[{~]/;

/** What a command prints or passes on, as the program a shell is handed: the text, or the files. */
function sourceOutput(
  ctx: Context,
  stage: Stage,
  command: Resolved,
  first: boolean,
  walk: Walk,
): ShellInput {
  const given = givenText(stage, command);
  if (given !== null) return program(ctx, given.text, given.dynamic, walk, given.unknown);
  const print = printed(command);
  if (print !== null) return program(ctx, print.text, print.dynamic, walk, print.unknown);
  const read = reader(command, stage);
  if (read === null) return OPAQUE;
  // `cat | bash` reads the tool's own input: there is nothing before it to read.
  if (read.fromPipe) return first ? NO_INPUT : OPAQUE;
  if (command.wrappers.some((w) => !PLAIN_WRAPPERS.has(w)) || read.dynamic) return OPAQUE;
  return filesOf(walk, read.files);
}

/** The program a single command prints, from its own text: `<( … )` and `"$( … )"`. */
function commandOutput(ctx: Context, inner: string, walk: Walk): ShellInput {
  const body = inner.trim();
  if (body.startsWith('<')) {
    const name = body.slice(1).trim();
    return EXPANDING_NAME.test(name) ? OPAQUE : filesOf(walk, [name]);
  }
  const lexed = lex(body);
  const stages = lexed.pipelines.length === 1 ? (lexed.pipelines[0] as readonly Stage[]) : [];
  const only = stages.length === 1 ? (stages[0] as Stage) : null;
  const command = only === null ? null : resolve(only.text);
  if (only === null || command === null || lexed.uncertain) return OPAQUE;
  return sourceOutput(ctx, only, command, true, walk);
}

/** The text of a here-string: what it says, or what the one `echo` or `cat` inside it makes. */
function hereString(ctx: Context, source: StdinSource, walk: Walk): ShellInput {
  if (!source.dynamic) return program(ctx, source.value, false, walk);
  const inner = wholeSubstitution(source.value);
  // A text with an expansion in it is read as written; it is unread only if one names the command.
  return inner === null ? program(ctx, source.value, true, walk) : commandOutput(ctx, inner, walk);
}

/** Whether the stage hands the stage before it a pipe's worth of input through unchanged. */
function passesThrough(line: Pipeline, j: number): boolean {
  const stage = line.stages[j];
  const command = line.commands[j];
  if (stage === undefined || command === null || command === undefined || !stage.piped)
    return false;
  return reader(command, stage)?.fromPipe === true;
}

/** The program the pipe into stage `k` carries: what the stage that makes it prints, or reads. */
function fromPipe(ctx: Context, line: Pipeline, k: number, walk: Walk): ShellInput {
  let j = k - 1;
  while (j > 0 && passesThrough(line, j)) j -= 1;
  const source = line.stages[j];
  const command = line.commands[j];
  if (source === undefined || command === null || command === undefined) return OPAQUE;
  return sourceOutput(ctx, source, command, j === 0, walk);
}

/** The program a shell reads from standard input: its here-document, its redirect, its pipe. */
function stdinProgram(
  ctx: Context,
  line: Pipeline,
  k: number,
  redirect: StdinSource | null,
  walk: Walk,
): ShellInput {
  const stage = line.stages[k] as Stage;
  const parts: ShellInput[] = [];
  if (stage.heredoc !== null) {
    const { body, quoted } = stage.heredoc;
    parts.push(program(ctx, quoted ? body : expandHeredoc(body), !quoted, walk));
  }
  const source = redirect ?? (stage.piped ? null : walk.exec);
  if (source?.kind === 'file') parts.push(source.dynamic ? OPAQUE : filesOf(walk, [source.value]));
  else if (source?.kind === 'here') parts.push(hereString(ctx, source, walk));
  else if (source?.kind === 'unknown') parts.push(OPAQUE);
  else if (stage.heredoc === null && stage.piped) parts.push(fromPipe(ctx, line, k, walk));
  return merge(parts);
}

/** What one shell in a stage is handed to run. */
function readShell(
  ctx: Context,
  line: Pipeline,
  k: number,
  command: Resolved,
  args: readonly Word[],
  walk: Walk,
): ShellInput {
  if ((command.name === 'source' || command.name === '.') && !sourcesProgram(args)) return NO_INPUT;
  const parsed = parseShellArgs(args);
  if (parsed.inline) return readString(ctx, line, k, command, args, parsed, walk);
  // `xargs bash`: the words it is given are arguments, not a program.
  if (fedByArguments(command)) return NO_INPUT;
  // The script a shell names is read by the reader of scripts, from where the segment stands;
  // what is read here is what arrives on standard input.
  const parts: ShellInput[] = [];
  for (const inner of parsed.commands) parts.push(commandOutput(ctx, inner, walk));
  if (parsed.unknown) parts.push(OPAQUE);
  if (parsed.readsStdin) parts.push(stdinProgram(ctx, line, k, parsed.stdin, walk));
  return merge(parts);
}

/**
 * A shell given a string to run: the string is the program. Anything inside it that is a shell
 * reads what the outer one was given, so the input is read as a program too when the string has
 * a shell in it, wherever it stands (`bash -c 'true; bash'`, `sh -c 'cat | sh'`).
 */
function readString(
  ctx: Context,
  line: Pipeline,
  k: number,
  command: Resolved,
  args: readonly Word[],
  parsed: ShellArgs,
  walk: Walk,
): ShellInput {
  const string = parsed.inlineAt === null ? undefined : args[parsed.inlineAt];
  if (string === undefined) return NO_INPUT; // `-n`, or `-c` with nothing after it
  // `xargs -I{} sh -c {}` runs, as a program, whatever text arrives, which is not one this could
  // read; a `-c` string that is written out is the program the shell is given.
  if (fedByArguments(command))
    return PLACEHOLDER_PROGRAM.test(string.value)
      ? OPAQUE
      : program(ctx, string.value, string.expands, walk);
  const parts = [program(ctx, string.value, string.expands, walk)];
  // What an interactive shell runs as it starts is read before the string: `-ic 'x' --rcfile <(cmd)`.
  for (const inner of parsed.commands) parts.push(commandOutput(ctx, inner, walk));
  if (mayHandInputToShell(string.value) || namesMentioned(string.value, ctx.names))
    parts.push(stdinProgram(ctx, line, k, parsed.stdin, walk));
  return merge(parts);
}

/**
 * Whether a stage hands the input it is given to commands inside it: a closing brace, `fi`, `done`
 * or `esac` with a redirect (`{ bash; } <<< 'x'`), a stage of only redirects after one, and a call
 * of a function the text defines.
 */
const passesInputInside = (ctx: Context, command: Resolved, stage: Stage): boolean =>
  command.name === '' ||
  CLOSERS.has(command.name) ||
  ctx.names.functions.has(command.name) ||
  closesGroupGivenInput(command, stage);

/**
 * A stage that is the last command of a subshell or a zsh brace group, with the group's input
 * after it: `( bash; true ) < x.sh`, `{ bash; break } < x.sh`. The redirect is the group's.
 */
function closesGroupGivenInput(command: Resolved, stage: Stage): boolean {
  const closes = groupMarks(stage.text).closes > 0 || /(?:^|\s)\}(?=\s|$)/.test(stage.text);
  if (!closes) return false;
  const parsed = parseShellArgs(command.args);
  return stage.heredoc !== null || parsed.stdin !== null || parsed.commands.length > 0;
}

/** The words that open a compound command, once those that may stand before it are off. */
const BEFORE_OPENER = /^(?:(?:do|then|else|elif|time|!)\s+)+/;
const OPENS_BODY = /^(?:(?:while|until|for|foreach|select|if|case)(?![\w./-])|\{(?=\s|$))/;
const CLOSES_BODY = /^(?:(?:done|fi|esac|end)(?![\w./-])|\}(?=[\s;)&|<>]|$))/;

/** Where the bodies of the compound commands in a text are: for a closing stage, where its body begins; for an opening one, where its body ends. */
interface Bodies {
  readonly starts: ReadonlyMap<Stage, number>;
  readonly ends: ReadonlyMap<Stage, number>;
}

/**
 * Where each closing `done`, `fi`, `esac` and `}` has its body begin, and each opening word where
 * its body ends: the opener nearest before a closer that is not closed yet. A word that opens a
 * body this does not read leaves the closers after it paired with an opener further out, so a
 * body is only ever larger than it is, or not known.
 */
function compoundBodies(lines: readonly Pipeline[]): Bodies {
  const open: Stage[] = [];
  const starts = new Map<Stage, number>();
  const ends = new Map<Stage, number>();
  for (const line of lines)
    for (const stage of line.stages) {
      const rest = stage.text.trimStart().replace(BEFORE_OPENER, '');
      if (OPENS_BODY.test(rest)) open.push(stage);
      else if (CLOSES_BODY.test(rest)) {
        const opener = open.pop();
        if (opener === undefined) continue;
        starts.set(stage, opener.at);
        ends.set(opener, stage.at);
      }
    }
  return { starts, ends };
}

/** How much text bodies are searched in, as a multiple of the command: past it, a body holds a shell. */
const SCAN_FACTOR = 4;

/**
 * Whether the commands of a body could include a shell: one by name, a variable that names one, a
 * function the text defines, a copy of a shell. Bodies are searched within one meter, so that a
 * command made of many of them costs a few times its own size and no more.
 */
function bodyHoldsShell(ctx: Context, body: string): boolean {
  if (body.length > ctx.scanRoom.left) return true;
  ctx.scanRoom.left -= body.length;
  return (
    bodyMayRunShell(body) ||
    ctx.names.implicit ||
    namesMentioned(body, ctx.names, (name) => namedFunctionHoldsShell(ctx, name, new Set()))
  );
}

/** Whether a function that a text defines could run a shell: a body that is not read could, and so could one that calls a function that does. */
function namedFunctionHoldsShell(ctx: Context, name: string, seen: Set<string>): boolean {
  // A function that is on the way here is looked at once: a cycle of calls adds nothing to what they hold.
  if (seen.has(name)) return false;
  seen.add(name);
  const bodies = ctx.names.bodies.get(name);
  return (
    bodies === undefined ||
    bodies.some((body) => body === null || functionHoldsShell(ctx, body, name, seen))
  );
}

/** Whether the body of a function could run a shell, within the meter that bodies are searched in. */
function functionHoldsShell(ctx: Context, body: string, name: string, seen: Set<string>): boolean {
  if (body.length > ctx.scanRoom.left) return true;
  ctx.scanRoom.left -= body.length;
  return (
    bodyMayRunShell(body) ||
    ctx.names.implicit ||
    namesMentioned(body, withoutFunction(ctx.names, name), (other) =>
      namedFunctionHoldsShell(ctx, other, seen),
    )
  );
}

/**
 * Whether what a stage hands its input to could be a shell. A loop or a group given a file that
 * holds nothing that reads a program gives it to nothing, wherever else in the text a shell
 * stands; where the body is not known, it holds one.
 */
function insideMayHandShell(ctx: Context, stage: Stage, command: Resolved): boolean {
  // A call of a function that the text defines hands its input to what the function holds, which is read:
  // a body that has no shell in it, and calls no other function, runs none.
  const bodies = ctx.names.functions.has(command.name)
    ? ctx.names.bodies.get(command.name)
    : undefined;
  if (bodies !== undefined) return namedFunctionHoldsShell(ctx, command.name, new Set());
  const from = ctx.bodies.starts.get(stage);
  if (!CLOSERS.has(command.name) || from === undefined) return true;
  return bodyHoldsShell(ctx, ctx.text.slice(from, stage.at));
}

/**
 * Whether a compound command that is handed a pipe could give it to a shell inside it. Where the
 * end of its body is not known, the rest of the text is its body.
 */
function pipedMayHandShell(ctx: Context, stage: Stage): boolean {
  return bodyHoldsShell(ctx, ctx.text.slice(stage.at, ctx.bodies.ends.get(stage)));
}

/** What such a stage is given as a program: its redirect, its here-document, its pipe. */
function insideInput(
  ctx: Context,
  line: Pipeline,
  k: number,
  command: Resolved,
  walk: Walk,
): ShellInput {
  const parsed = parseShellArgs(command.args);
  const parts = parsed.commands.map((inner) => commandOutput(ctx, inner, walk));
  parts.push(stdinProgram(ctx, line, k, parsed.stdin, walk));
  return merge(parts);
}

/** What a shell `ssh` started is handed runs on the other machine. */
const onAnotherMachine = (found: ShellInput): ShellInput =>
  found.texts.length === 0 ? found : { ...found, remote: found.texts.map(() => true) };

/** What one stage of a pipeline hands to its shell, if it is one. */
function readStage(ctx: Context, line: Pipeline, k: number, walk: Walk): ShellInput {
  const stage = line.stages[k] as Stage;
  const command = line.commands[k] as Resolved;
  const programs: ShellInput[] = [];
  // What `eval` and `trap` are given is a command line, run in turn.
  if (command.evalProgram !== null && !isInitSubstitution(command.evalProgram.text))
    programs.push(program(ctx, command.evalProgram.text, command.evalProgram.dynamic, walk));
  if (command.name === 'trap') programs.push(trapProgram(ctx, command, walk));
  if (command.name === '$' || command.deep) {
    // A command word that is an expansion or a glob could be a shell: `echo X | $SHELL`,
    // `$0 <<< X`, `/bin/ba*`. One that names a shell, one that holds a shell word
    // (`$(which bash)`) and one in a command that gives a variable a shell to run are asked
    // about; `| $PAGER` and `"$PY" - <<EOF` are not.
    const fed = stage.piped || stage.heredoc !== null || stage.text.includes('<');
    const names =
      command.deep ||
      SHELL_VARIABLE.test(command.word) ||
      lastShellWordAt(command.word) !== -1 ||
      globNamesShell(command.word);
    if (names) {
      // A shell by any name is given a string to run as well as a program on its input.
      const parsed = parseShellArgs(command.args);
      if (parsed.inline)
        programs.push(readString(ctx, line, k, command, command.args, parsed, walk));
    }
    programs.push(fed && (names || ctx.names.assignsShell) ? OPAQUE : NO_INPUT);
  } else {
    const args = shellOf(command, ctx.names.aliases);
    if (args !== null) {
      const found = readShell(ctx, line, k, command, args, walk);
      programs.push(command.name === 'ssh' ? onAnotherMachine(found) : found);
    } else if (passesInputInside(ctx, command, stage) && insideMayHandShell(ctx, stage, command))
      programs.push(insideInput(ctx, line, k, command, walk));
  }
  return merge(programs);
}

/** `trap 'commands' EXIT`: the commands are a program the shell runs when the signal comes. */
function trapProgram(ctx: Context, command: Resolved, walk: Walk): ShellInput {
  const operands = command.args.filter((w) => !w.redirect && !w.value.startsWith('-'));
  const body = operands[0];
  return body === undefined || operands.length < 2
    ? NO_INPUT
    : program(ctx, body.value, body.expands, walk);
}

/** What the shells in `text` are handed to run: see `ShellInput`. */
export function shellInput(
  text: string,
  budget: Budget = newBudget(text.length),
  directory: string | null = null,
  inherited: Names = NO_NAMES,
): ShellInput {
  const lastShellWord = lastShellWordIn(text);
  if (!mentionsShell(text, lastShellWord) && !namesMentioned(text, inherited)) return NO_INPUT;
  const lexed = lex(text);
  const lines: Pipeline[] = lexed.pipelines.map((stages) => ({
    stages,
    commands: stages.map((s) => resolve(s.text)),
  }));
  const own: Names = {
    overridden: OVERRIDES_PRINTERS.test(text),
    assignsShell: ASSIGNED_SHELL.test(text),
    implicit: hooksRun(text),
    ...namesIn(lines),
    bodies: functionBodies(text),
  };
  const ctx: Context = {
    budget,
    names: mergeNames(inherited, own),
    text,
    bodies: compoundBodies(lines),
    scanRoom: { left: SCAN_FACTOR * text.length + 4096 },
  };
  const texts: string[] = [];
  const directories: (string | null)[] = [];
  const remote: boolean[] = [];
  const files: string[] = [];
  // A pipe into a shell that the first reading lost is a program nobody read: ask.
  let opaque = lexed.uncertain || lostPipe(text, lexed);
  const walk: Walk = { directory, exec: null, saved: [], previous: [] };
  for (const line of lines) {
    for (let k = 0; k < line.stages.length; k += 1) {
      const command = line.commands[k];
      const stage = line.stages[k] as Stage;
      enter(walk, stage);
      // `echo X | { :; bash; }`: a compound command handed a pipe gives it to what is inside,
      // whether or not the stage that opens it is a command (`{ x=bash`).
      if (stage.compound && !opaque && pipedMayHandShell(ctx, stage)) opaque = true;
      if (command !== null && command !== undefined) {
        advance(walk, command, line, stage);
        const found = readStage(ctx, line, k, walk);
        for (const t of found.texts) texts.push(t);
        for (const d of found.directories) directories.push(d);
        for (const r of found.remote) remote.push(r);
        for (const f of found.files) files.push(f);
        opaque ||= found.opaque;
      }
      leave(walk, stage);
    }
  }
  return texts.length === 0 && files.length === 0 && !opaque
    ? NO_INPUT
    : { texts, directories, remote, files, opaque };
}

/** A text and where it runs. */
interface Located {
  readonly text: string;
  readonly directory: string | null;
  readonly remote: boolean;
}

/**
 * The text and each text nested in it (`sh -c` bodies, substitutions, `eval` arguments), as far
 * as they run commands: what a quoted-delimiter here-document holds is text, and `bash <<'EOF'`
 * is read as the program it is by `shellInput`, not as a command nested in the text.
 */
const textsOf = (text: string, directory: string | null, remote: boolean): readonly Located[] =>
  splitCommand(text, null).texts.map((nested) => ({ text: nested, directory, remote }));

/**
 * Every program handed to a shell on standard input in a command, at every level of nesting: the
 * command and each text nested in it (`bash -c "echo x | bash"`), then each program decoded from
 * them, a few levels deep, within one budget. A level that is still going when the depth runs out
 * is not read, which is said.
 */
export function decodePrograms(
  command: string,
  budget: Budget = newBudget(command.length),
  split: SplitCommand = splitCommand(command),
): ShellInput {
  const texts: string[] = [];
  const directories: (string | null)[] = [];
  const remote: boolean[] = [];
  const files = new Set<string>();
  let opaque = false;
  // What the command gives names to is in effect in every text nested in it and decoded from it.
  let shared = split.texts.reduce(
    (all, text) => mergeNames(all, namesOfText(text, budget)),
    NO_NAMES,
  );
  let level: readonly Located[] = split.texts.map((text) => ({
    text,
    directory: null,
    remote: false,
  }));
  for (let depth = 0; depth < MAX_PROGRAM_DEPTH && level.length > 0; depth += 1) {
    const next: Located[] = [];
    // Only a text that could hand a shell its program is read; the cap is on those.
    const readable = level.filter(
      (item) => mayHandShell(item.text) || namesMentioned(item.text, shared),
    );
    if (readable.length > MAX_TEXTS) opaque = true;
    for (const item of readable.slice(0, MAX_TEXTS)) {
      const found = shellInput(item.text, budget, item.directory, shared);
      for (const file of found.files) files.add(file);
      opaque ||= found.opaque;
      found.texts.forEach((decoded, n) => {
        const directory = found.directories[n] ?? item.directory;
        const elsewhere = item.remote || found.remote[n] === true;
        texts.push(decoded);
        directories.push(directory);
        remote.push(elsewhere);
        shared = mergeNames(shared, namesOfText(decoded, budget));
        for (const nested of textsOf(decoded, directory, elsewhere)) next.push(nested);
      });
    }
    level = next;
  }
  // What the last level decoded is not read for pipes of its own: if it could hold one, say so.
  if (level.some((item) => mayHandShell(item.text) || namesMentioned(item.text, shared)))
    opaque = true;
  return texts.length === 0 && files.size === 0 && !opaque
    ? NO_INPUT
    : { texts, directories, remote, files: [...files], opaque };
}
