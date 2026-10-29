import { inlinePython, type PipeConsumer } from './pipe-consumer.js';
import { quote, readPythonProcesses, type PythonProcess } from './python-processes.js';
import type { Lexed, Stage } from './shell-lex.js';
import { argv } from './shell-word-reader.js';

/**
 * The stages of a command that give Python a program with `-c`, each read for the processes it
 * starts (`python-processes.ts`).
 *
 * A command a program writes out is a command of the line it is in, as a `sh -c` body is
 * (`pythonCommandTexts`, read by `shell-segments.ts`): every reader of commands reads it, and a script
 * it runs is read as a typed one is. A pattern used to stand for all of this: a `python -c` whose text
 * held `subprocess` or `os.system` was `inline-interpreter-payload`, however plainly the program spelled
 * out what it ran. That pattern now answers for a program only where the program could not be read in
 * full. A program that starts a process in a way that is not read, writes to one that runs what it is
 * given, hands one the input of a line that has any, holds a string that may be code, or changes what
 * its processes do (`opaque`), is `inline-interpreter-payload` where the old pattern sees it and a
 * question (`shell.unparsed`) where only this reading does. The pattern still reads everything else in
 * the command: it is asked of the command with each program read in full replaced by the commands it
 * starts (`masked`), so that a program answers for itself and for nothing beside it.
 */

/** How deep a program started by a program is read: past it, the pattern alone answers. */
const MAX_PYTHON_DEPTH = 3;
const PAYLOAD = 'inline-interpreter-payload';
const NOT_READ = 'python-process-not-read';
const PROGRAM_NOT_READ = 'python-program-not-read';
/** A line that is more than one simple command: what it is given is not known to reach a reader. */
const MORE_THAN_ONE_COMMAND = /[|;&\n`<>(]|\$\(/;
/**
 * A character other than printable ASCII, a tab and a line break. Python reads a name in a form this
 * reader does not (`ｓｕｂｐｒｏｃｅｓｓ` is `subprocess` to it, after NFKC) and a carriage return as a
 * line break: a program it could not read that holds one is asked about, not let through.
 */
const NOT_READ_CHARACTER = /[^\t\n\x20-\x7e]/;
/** A word of a way to start a process, in a program that could not be read. */
const STARTS_A_PROCESS =
  /(?:subprocess|popen|Popen|system|spawn|exec[lv]|fork|check_output|check_call|getoutput|startfile|pty)/;
/** A redirect that gives a command input: `<`, `<<`, `<<<`, `<&`, `<>`, with or without a descriptor. */
const INPUT_REDIRECT = /^\d*<(?:<<|<-|<|&|>)?/;
/**
 * The words of a stage beside its program that hold nothing to run: a name, a path, an option, an
 * assignment of a plain value, an output redirect. A stage with anything else beside its program
 * (`$(…)`, a quote, an input redirect) is not put out of the way.
 */
const PLAIN_REST = /^[\w./=:,@%+\- >&]*$/;

export interface PythonStages {
  /** `inline-interpreter-payload`, once for each program the old pattern stops that is not read in full. */
  readonly signals: readonly string[];
  /** `shell.unparsed`: a program that is not read in full where only this reading sees it. */
  readonly unparsed: readonly string[];
  /** The command with each program read in full replaced by `true`, or null when there is none. */
  readonly masked: string | null;
  /** The commands those programs start, which the old pattern reads one at a time, each as a line of its own. */
  readonly started: readonly string[];
}

export interface PythonStageContext {
  /** The command and each text read from it (`SplitCommand.texts`), and the stages of each, as the shell cuts them. */
  readonly texts: readonly string[];
  readonly stages: readonly (readonly (readonly Stage[])[])[];
  readonly depth: number;
  /** What a command does with what is written to it (`pipe-consumer.ts`). */
  readonly consumer: (command: string) => PipeConsumer;
  /** Whether a text holds what the old pattern took for a payload (`subprocess`, `os.system`, `base64`, …). */
  readonly payload: (text: string) => boolean;
}

/** The commands the Python programs of a text start, written out: commands of the text as much as a `sh -c` body. */
export function pythonCommandTexts(lexed: Lexed): string[] {
  if (lexed.uncertain) return [];
  const out: string[] = [];
  for (const stage of lexed.pipelines.flat()) {
    const program = inlinePython(stage.text);
    if (program === undefined || program.text === null) continue;
    const processes = readPythonProcesses(program.text)?.processes ?? [];
    for (const process of processes) {
      out.push(process.command);
      // And where the program may have moved to: `cd /x && sh y.sh` reads `/x/y.sh`.
      for (const dir of process.dirs) out.push(`cd ${quote(dir)} && ${process.command}`);
    }
    // And all of them as one script, in the order they are written: one may run what another fetched
    // or wrote, which a reading of each alone would not see.
    if (processes.length > 1) out.push(processes.map((process) => process.command).join('\n'));
  }
  return out;
}

/** Whether a stage is given input: a pipe into it, a here-document, or an input redirect. */
function givenInput(stage: Stage): boolean {
  if (stage.piped || stage.heredoc !== null) return true;
  return argv(stage.text).some((word) => word.redirect && INPUT_REDIRECT.test(word.value));
}

/** A word that ends a compound command, or `exec`: its input is the input of the commands in it, or after it. */
const HANDS_INPUT_ON = /^(?:exec|done|fi|esac|\}|\))(?:\s|$)/;

/**
 * Whether a stage gives other stages of the line their input: `exec < file`, a loop or a group whose
 * input is redirected (`done < file`, `} < file`), or a compound command handed a pipe.
 */
function handsInputOn(stage: Stage): boolean {
  return stage.compound || (HANDS_INPUT_ON.test(stage.text) && givenInput(stage));
}

/** The span of a stage in its text, from where the lexer began it. */
function spanOf(text: string, stage: Stage): readonly [number, number] | null {
  const at = text.indexOf(stage.text, stage.at);
  return at === -1 ? null : [at, at + stage.text.length];
}

export function readPythonStages(context: PythonStageContext): PythonStages {
  const { texts, stages, depth, consumer, payload } = context;
  const signals: string[] = [];
  const unparsed: string[] = [];
  const replaced: Array<readonly [number, number]> = [];
  const started: string[] = [];
  // What a process reads when it is given nothing of its own is what the program reads. A stage of the
  // command is given input by a pipe or a redirect of its own, or by a stage that hands input on; a
  // text read from the command (a `bash -c` body, a program of a shell's input) may be given any input
  // the line has, since which stage runs it is not kept.
  const top = (stages[0] ?? []).flat();
  const lineInput = depth > 0 || top.some(handsInputOn);
  const anyInput = depth > 0 || stages.some((pipelines) => pipelines.flat().some(givenInput));
  const readsOnly = (process: PythonProcess, input: boolean): boolean =>
    process.stdin === 'none' ||
    (process.stdin === 'inherit' && !input) ||
    (!MORE_THAN_ONE_COMMAND.test(process.command) && consumer(process.command) === 'none');
  stages.forEach((pipelines, textIndex) => {
    for (const stage of pipelines.flat()) {
      const program = inlinePython(stage.text);
      if (program === undefined) continue;
      const seen = payload(stage.text);
      const reading =
        program.text === null || depth >= MAX_PYTHON_DEPTH
          ? null
          : readPythonProcesses(program.text);
      if (reading === null) {
        if (seen) signals.push(PAYLOAD);
        else if (
          program.text !== null &&
          depth < MAX_PYTHON_DEPTH &&
          (STARTS_A_PROCESS.test(program.text) || NOT_READ_CHARACTER.test(program.text))
        )
          unparsed.push(PROGRAM_NOT_READ);
        continue;
      }
      const input = textIndex === 0 ? lineInput || givenInput(stage) : anyInput;
      const notRead =
        reading.unread ||
        reading.hiddenPayload ||
        // Where the old pattern sees the program, it answers unless every module it imports is known.
        (seen && reading.unknownModules) ||
        (reading.opaque && (reading.processes.length > 0 || seen)) ||
        !reading.processes.every((process) => readsOnly(process, input));
      if (notRead) {
        if (seen) signals.push(PAYLOAD);
        else unparsed.push(NOT_READ);
        continue;
      }
      const text = texts[textIndex];
      const span = textIndex === 0 && text !== undefined ? spanOf(text, stage) : null;
      const rest = program.raw === undefined ? null : stage.text.replace(program.raw, '');
      if (span !== null && stage.heredoc === null && rest !== null && PLAIN_REST.test(rest)) {
        // Put out of the way by `true`, never by the commands it starts: one of them (`echo x #`, an open
        // quote, `<<EOF`) would change how the rest of the line is cut. Those are read on their own.
        replaced.push(span);
        started.push(...reading.processes.map((p) => p.command));
      }
    }
  });
  let masked: string | null = null;
  if (replaced.length > 0 && texts[0] !== undefined) {
    masked = texts[0];
    for (const [from, to] of [...replaced].sort((a, b) => b[0] - a[0]))
      masked = `${masked.slice(0, from)}true${masked.slice(to)}`;
  }
  return { signals, unparsed, masked, started };
}
