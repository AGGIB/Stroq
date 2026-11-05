// What a command line RUNS, as against what it merely contains.
//
// The card counts a command as told by text only when it really does the thing the text said. A
// heredoc that writes a test file holding `curl … | sh`, an `echo "curl … | sh" > f`, and a quoted
// argument are all text that mention a pipe to a shell and run none. `lex` (the reader the classifier
// uses) cuts a command into pipelines and stages as a shell does, and keeps here-document bodies and
// quoted words apart from the stages, so what is read here is the stages. The text is not a shell
// either: a stage it cannot be sure of is not read as a run (`lex` says so with `uncertain`), because the
// card prefers to miss one than to name a command that never ran.
import { lex, type LexedStage } from '@stroq/core';

/** One stage of a pipeline: a command with its words, as a shell would split them. */
export interface StageView {
  readonly text: string;
  readonly words: readonly string[];
  /** Where the command word is in `words`, past assignments and `sudo`-like prefixes; -1 when none. */
  readonly cmd: number;
  /** A pipe joins this stage to the one before it. */
  readonly piped: boolean;
  /** The texts of the substitutions inside this stage (`$(…)`, backticks), outermost only. */
  readonly nested: readonly string[];
}

/** The most commands read out of nested `-c` strings and here-documents: a bound on what a hostile command costs. */
const MAX_DEPTH = 3;
const MAX_STAGES = 400;

/** The shells whose `-c` string, here-document and standard input are a program. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/** The words that run another command and are not it: skipped to find the command that runs. */
const PREFIXES: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'doas',
]);
/** The options of those whose next word is their value, not the command. */
const PREFIX_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '-g', '-n', '-C', '-h', '-p']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** The last path segment of a word: `/bin/bash` is `bash`. */
export const baseOf = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/**
 * The words of a stage with its quotes taken off, split at blanks. No expansion is done: a word with
 * a `$` in it is still that text, which no package or fixed name equals. One pass.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      current += text.slice(i + 1, end === -1 ? text.length : end);
      started = true;
      if (end === -1) break;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') {
        const escaped = text.charAt(j) === '\\' && '"\\$`'.includes(text.charAt(j + 1));
        current += escaped ? text.charAt(j + 1) : text.charAt(j);
        j += escaped ? 2 : 1;
      }
      started = true;
      i = j;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text.charAt(i + 1);
      started = true;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** Where the command word is, past `FOO=bar`, `sudo -u x`, `env -i`, `nohup` and the like; -1 when there is none. */
export function commandIndex(words: readonly string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (ASSIGNMENT.test(word)) {
      i += 1;
    } else if (PREFIXES.has(baseOf(word))) {
      i += 1;
      while (i < words.length) {
        const flag = words[i] ?? '';
        if (!flag.startsWith('-') && !ASSIGNMENT.test(flag)) break;
        i += PREFIX_VALUE_FLAGS.has(flag) ? 2 : 1;
      }
    } else {
      return i;
    }
  }
  return -1;
}

/** Whether a word names a shell. */
export const isShellWord = (word: string | undefined): boolean =>
  word !== undefined && SHELLS.has(baseOf(word));

function viewOf(stage: LexedStage, command: string, nestedRanges: readonly Range[]): StageView {
  const words = splitWords(stage.text);
  const end = stage.at + stage.text.length;
  const nested = nestedRanges
    .filter((r) => r.from >= stage.at && r.to <= end)
    .map((r) => command.slice(r.from, r.to));
  return { text: stage.text, words, cmd: commandIndex(words), piped: stage.piped, nested };
}

interface Range {
  readonly from: number;
  readonly to: number;
}

/**
 * Every pipeline the command runs, in order: its own, and those of a program a shell is handed (a
 * `-c` string, a here-document it reads). An unclear command (`lex` is unsure, or the command is
 * huge) gives none.
 */
export function pipelinesOf(command: string, depth = 0): StageView[][] {
  const lexed = lex(command);
  if (lexed.uncertain) return [];
  const out: StageView[][] = [];
  let stages = 0;
  for (const pipeline of lexed.pipelines) {
    const views = pipeline.map((stage) => viewOf(stage, command, lexed.nested));
    stages += views.length;
    if (stages > MAX_STAGES) return [];
    out.push(views);
    if (depth >= MAX_DEPTH) continue;
    for (const [index, view] of views.entries()) {
      if (!isShellWord(view.words[view.cmd])) continue;
      const flag = view.words.findIndex((w, k) => k > view.cmd && SHELL_C_FLAG.test(w));
      const program = flag === -1 ? undefined : view.words[flag + 1];
      if (program !== undefined) out.push(...pipelinesOf(program, depth + 1));
      const heredoc = pipeline[index]?.heredoc;
      if (heredoc !== null && heredoc !== undefined)
        out.push(...pipelinesOf(heredoc.body, depth + 1));
    }
  }
  return out;
}
