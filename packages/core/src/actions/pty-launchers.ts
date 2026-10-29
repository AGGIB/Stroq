/**
 * Programs that run a command inside a pseudo-terminal, and interpreters, read for what they run so that the
 * state gate (`stroq-state.ts`) sees it as it sees the operand of `stroq run --`.
 *
 * Read as a command line: `script` (both the BSD `script [opts] file command…` grammar and the util-linux
 * `-c`/`--command` one), `socat`'s `EXEC:`/`SYSTEM:`/`SHELL:` addresses (each half of a dual address
 * `a!!b`), a plain `spawn` of `expect`, and the `ptyexec`/`pty` helpers. `unbuffer` is read as a wrapper in
 * `shell-wrappers.ts`.
 *
 * Not read, and returned `unread` for the gate to deny where it names Stroq: an interpreter's program that is
 * anything but a file named first (a flag's value, an `eval` subcommand, `-`, a here-string, a file read in);
 * an expect statement that is not a plain `spawn`, and every other word expect is given; a socat address
 * that mentions a run in a way that is not a plain address, or whose command still holds quotes. A program
 * read from the input (a pipe, a document) is not in the segment at all: `readsProgramFromInput` says which
 * segment does that, and the gate looks at the whole command for it.
 *
 * Nothing here looks for the words that start a process (`system`, `spawn`, backticks, `%x`, `qx`,
 * `Open3`…): no list of them is ever whole, so the program is not read for them.
 *
 * Every pattern here runs on attacker text, so each is linear: a bounded prefix, a single class, no nested
 * quantifier over the length of the command. The shapes are held in `classify-redos-gate.test.ts`.
 */

import { clusterValue, gluedValue } from './shell-wrappers.js';
import type { Resolved, Word } from './shell-words.js';

export interface PtyLine {
  /** The command line the launcher runs, read again as a line of its own. */
  readonly line: string;
  /** True when the text could not be read with certainty; the gate denies it if it names Stroq. */
  readonly unread: boolean;
  /** The text is an interpreter's program: it names Stroq where a word of it is Stroq (`stroq-state.ts`). */
  readonly code?: boolean;
}

const read = (line: string): PtyLine => ({ line, unread: false });
const unread = (line: string, code = false): PtyLine => ({ line, unread: true, code });

/** A redirect operator whose target is the next word: `<`, `<<<`, `2>`, `&>>`. */
const BARE_REDIRECT = /^\d*(?:<<<|<<-?|<>|<&|<|>>|>&|>\||>|&>>|&>)$/;
/** A redirect that feeds the command's input. */
const INPUT = /^\d*</;
/** A document (`<<EOF`, `<< 'EOF'`): its lines, folded into the line, are all that follows. */
const DOCUMENT = /^\d*<<(?!<)/;

/** A command's arguments, apart from what its redirects feed its input. */
interface Arguments {
  readonly operands: readonly string[];
  /** What reaches the command's input in the segment: a here-string, a file read in, a document's lines. */
  readonly input: readonly string[];
}
function argumentsOf(args: readonly Word[]): Arguments {
  const operands: string[] = [],
    input: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (!word.redirect) {
      operands.push(word.value);
      continue;
    }
    const into = INPUT.test(word.value);
    if (into) input.push(word.value);
    if (DOCUMENT.test(word.value)) {
      for (const rest of args.slice(i + 1)) input.push(rest.value);
      break;
    }
    if (BARE_REDIRECT.test(word.value) && i + 1 < args.length) {
      i += 1;
      if (into) input.push((args[i] as Word).value);
    }
  }
  return { operands, input };
}

/** Whether a word is the util-linux command flag, bare or at the end of a cluster (`-qc`). */
const isCommandFlag = (word: string): boolean =>
  word === '-c' || word === '--command' || /^-[A-Za-z]*c$/.test(word);

/**
 * `script -c 'cmd'`, `script --command cmd`, `script --command=cmd`, `script -qc 'cmd' file` (util-linux),
 * and `script [options] file command args…` (BSD): the command line the recorder runs. The util-linux
 * command flag is read first, wherever it stands among the options or right after the log file; otherwise
 * the words after the file are the command.
 */
function scriptLine(args: readonly string[]): PtyLine[] {
  let i = 0;
  while (i < args.length) {
    const word = args[i] as string;
    if (!word.startsWith('-') || word === '-') break;
    const inline = /^--command=(.*)$/s.exec(word);
    if (inline) return [read(inline[1] as string)];
    if (isCommandFlag(word)) {
      const next = args[i + 1];
      return next === undefined ? [] : [read(next)];
    }
    const glued = gluedValue('script', word, 'c');
    if (glued !== null) return [read(glued)];
    i += clusterValue('script', word) === 'next' ? 2 : 1;
  }
  const rest = args.slice(i + 1);
  if (rest.length === 0) return [];
  // util-linux allows the command flag after the log file (`script /dev/null -c cmd`).
  const first = rest[0] as string;
  const inline = /^--command=(.*)$/s.exec(first);
  if (inline) return [read(inline[1] as string)];
  if (isCommandFlag(first) && rest[1] !== undefined) return [read(rest[1] as string)];
  return [read(rest.join(' '))];
}

/** `socat … EXEC:cmd,opts`, `SYSTEM:cmd`, `SHELL:cmd`: an address that runs a command. */
const SOCAT_RUNS = /^(?:exec|system|shell)\s*:/i;
/** An address that mentions a run anywhere, read or not. */
const SOCAT_MENTIONS_RUN = /exec|system|shell/i;
/** Quotes or escapes left in the command of an address: socat reads them again, and this does not. */
const SOCAT_REREADS = /['"\\]/;
/**
 * The commands of the addresses that run one, each half of a dual address (`a!!b`) apart. A half that
 * mentions a run but is no plain address, or whose command still holds quotes, is not read.
 */
function socatLines(args: readonly string[]): PtyLine[] {
  const lines: PtyLine[] = [];
  for (const value of args)
    for (const part of value.split('!!')) {
      const match = SOCAT_RUNS.exec(part);
      if (match === null) {
        if (SOCAT_MENTIONS_RUN.test(part)) lines.push(unread(part));
        continue;
      }
      const after = part.slice(match[0].length);
      // The address options follow the command after a comma (`EXEC:cmd,pty,stderr`).
      const comma = after.indexOf(',');
      const line = comma === -1 ? after : after.slice(0, comma);
      if (line !== '') lines.push(SOCAT_REREADS.test(line) ? unread(line) : read(line));
    }
  return lines;
}

/** The options `expect`'s `spawn` takes before the program (`spawn -noecho cmd`, `spawn -ignore SIG cmd`). */
function afterSpawnOptions(words: readonly string[]): string {
  let i = 0;
  while (i < words.length && (words[i] as string).startsWith('-'))
    i += words[i] === '-ignore' ? 2 : 1;
  return words.slice(i).join(' ');
}

/** What Tcl substitutes, quotes or groups: a `spawn` that holds one is not plain words. */
const TCL_SUBSTITUTES = /["'{}[\]$\\]/;

/**
 * `expect -c 'spawn cmd …'` and `expect -c'spawn cmd'`: a `spawn` of plain words runs a command, read as a
 * line. Every other statement, and every other word expect is given (an option, a script file, its
 * arguments, what it reads on its input), is returned `unread`.
 */
function expectLines(args: Arguments): PtyLine[] {
  const scripts: string[] = [],
    other: string[] = [];
  const { operands } = args;
  for (let i = 0; i < operands.length; i += 1) {
    const word = operands[i] as string;
    if (word === '-c' && i + 1 < operands.length) {
      scripts.push(operands[i + 1] as string);
      i += 1;
    } else if (word.startsWith('-c') && word.length > 2) scripts.push(word.slice(2));
    else other.push(word);
  }
  const lines: PtyLine[] = [];
  for (const script of scripts)
    for (const statement of script.split(/[;\n]/)) {
      const spawn = /^\s*spawn\s+(.+)$/s.exec(statement);
      const command =
        spawn === null ? '' : afterSpawnOptions((spawn[1] as string).trim().split(/\s+/));
      if (command !== '' && !TCL_SUBSTITUTES.test(command)) lines.push(read(command));
      else if (statement.trim() !== '') lines.push(unread(statement));
    }
  const rest = [...other, ...args.input];
  if (rest.length > 0) lines.push(unread(rest.join(' ')));
  return lines;
}

/**
 * How an interpreter is given its program, by what its options say: the letters of the options whose value
 * is the program (`-c`, `-e`), whose value is something else (`-W ignore`), and whose value is a file or
 * module that is the program (`-m`, `-f`).
 */
interface Family {
  readonly inline: string;
  readonly value: string;
  readonly file: string;
  readonly longInline: readonly string[];
  readonly longValue: readonly string[];
  /** A subcommand that takes the program as its argument (`deno eval`). */
  readonly subcommand?: string;
}
const FAMILIES: Readonly<Record<string, Family>> = {
  python: { inline: 'c', value: 'WXQ', file: 'm', longInline: [], longValue: [] },
  node: {
    inline: 'ep',
    value: 'rC',
    file: '',
    longInline: ['--eval', '--print'],
    longValue: [
      '--require',
      '--import',
      '--conditions',
      '--loader',
      '--experimental-loader',
      '--input-type',
      '--title',
      '--env-file',
    ],
  },
  bun: {
    inline: 'ep',
    value: 'r',
    file: '',
    longInline: ['--eval', '--print'],
    longValue: ['--require', '--preload', '--cwd', '--config', '--env-file'],
    subcommand: 'eval',
  },
  deno: { inline: '', value: '', file: '', longInline: [], longValue: [], subcommand: 'eval' },
  perl: { inline: 'eE', value: 'IMm', file: '', longInline: [], longValue: [] },
  ruby: { inline: 'e', value: 'IrCEFK', file: '', longInline: [], longValue: [] },
  php: { inline: 'rBRE', value: 'cdz', file: 'fF', longInline: [], longValue: [] },
  lua: { inline: 'e', value: 'l', file: '', longInline: [], longValue: [] },
  tcl: { inline: '', value: '', file: '', longInline: [], longValue: ['-encoding'] },
};
const ALIASES: Readonly<Record<string, string>> = {
  pypy: 'python',
  nodejs: 'node',
  luajit: 'lua',
  tclsh: 'tcl',
  wish: 'tcl',
};
/** Interpreters, with a version in the name (`python3.12`, `ruby3.3`, `node22`, `lua5.4`). */
const INTERPRETER =
  /^(python|pypy|nodejs|node|deno|bun|perl|ruby|php|luajit|lua|tclsh|wish)[\d.]*$/;
function familyOf(name: string): Family | null {
  const match = INTERPRETER.exec(name.toLowerCase());
  if (match === null) return null;
  const base = match[1] as string;
  return FAMILIES[ALIASES[base] ?? base] ?? null;
}

/** Where an interpreter's program comes from, by its options and the first word that is not one. */
function programSource(family: Family, operands: readonly string[]): 'file' | 'inline' | 'input' {
  for (let i = 0; i < operands.length; i += 1) {
    const word = operands[i] as string;
    if (word === '-') return 'input';
    if (word === '--') return i + 1 < operands.length ? 'file' : 'input';
    if (!word.startsWith('-')) return i === 0 && word === family.subcommand ? 'inline' : 'file';
    if (word.startsWith('--')) {
      const equals = word.indexOf('='),
        name = equals === -1 ? word : word.slice(0, equals);
      if (family.longInline.includes(name)) return 'inline';
      if (equals === -1 && family.longValue.includes(name)) i += 1;
      continue;
    }
    if (family.longValue.includes(word)) {
      i += 1;
      continue;
    }
    for (let k = 1; k < word.length; k += 1) {
      const letter = word.charAt(k);
      if (family.inline.includes(letter)) return 'inline';
      if (family.file.includes(letter)) return 'file';
      if (family.value.includes(letter)) {
        if (k === word.length - 1) i += 1;
        break;
      }
    }
  }
  return 'input';
}

/**
 * An interpreter's program is read only where it is a file named first (`python3 build.py`), and then it is
 * not read here at all: a file is not followed. Anything else (a flag's value, `eval`, `-`, a here-string, a
 * file read in, an option before the file) is text the gate does not read: all of it is returned `unread`.
 */
function interpreterLines(name: string, args: Arguments): PtyLine[] {
  const family = familyOf(name);
  if (family === null) return [];
  const first = args.operands[0];
  if (first !== undefined && !first.startsWith('-') && first !== family.subcommand) return [];
  return [unread([...args.operands, ...args.input].join(' '), true)];
}

/**
 * Whether expect reads its commands from its input: `-`, `-f -`, `-i`, or neither a script file nor `-c`
 * commands (expect then takes its input as the script, as it does when that is not a terminal).
 */
function expectReadsInput(operands: readonly string[]): boolean {
  let commands = false;
  for (let i = 0; i < operands.length; i += 1) {
    const word = operands[i] as string;
    if (word === '-' || word === '-i') return true;
    if (word === '-f' || word === '-b')
      return operands[i + 1] === undefined || operands[i + 1] === '-';
    if (word === '-c') {
      commands = true;
      i += 1;
    } else if (word === '-D') i += 1;
    else if (word.startsWith('-c')) commands = true;
    else if (/^-[fb]/.test(word)) return word.slice(2) === '-';
    else if (!word.startsWith('-')) return false;
  }
  return !commands;
}

/**
 * Whether the program of the command is read from its input (`echo … | python3`, `python3 - <<EOF`,
 * `printf 'spawn …' | expect`): the program is then the text of another segment, or of a document's lines.
 */
export function readsProgramFromInput(command: Resolved): boolean {
  const { operands } = argumentsOf(command.args);
  if (command.name === 'expect') return expectReadsInput(operands);
  const family = familyOf(command.name);
  return family !== null && programSource(family, operands) === 'input';
}

/** The command lines a program runs inside a pseudo-terminal, or hands on unread; empty when it runs none. */
export function ptyLaunchedLines(command: Resolved): PtyLine[] {
  const args = argumentsOf(command.args);
  switch (command.name) {
    case 'script':
      return scriptLine(args.operands);
    case 'socat':
      return socatLines(args.operands);
    case 'expect':
      return expectLines(args);
    case 'ptyexec':
    case 'pty':
      return args.operands.length === 0 ? [] : [read(args.operands.join(' '))];
    default:
      return interpreterLines(command.name, args);
  }
}
