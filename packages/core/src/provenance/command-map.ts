import {
  SHELL_WORDS,
  newLexState,
  readBodies,
  readOpener,
  scanExpansions,
  skipBacktick,
  skipDollar,
  skipDouble,
  skipSingle,
  skipSubstitution,
  startsComment,
  type HeredocOpen,
  type LexState,
} from '../actions/shell-skip.js';
import { LOCAL_WRAPPERS, PREFIX_WORDS, optionTakesValue } from '../actions/shell-wrappers.js';
import {
  COMPOUND_WORDS,
  FIND_RUNS,
  PRINTERS,
  RUNS_A_COMMAND_STRING,
  RUNS_ITS_ARGUMENTS,
  STRING_RUNNERS,
  gitSubcommand,
  isGitConfigOption,
  isGitMessageCommand,
  isMessageFlag,
} from './command-kinds.js';
import { shellWord } from './shell-word.js';
import { canonicalCommand } from './tool-phrases.js';

/**
 * Where the commands of a command line are, as a shell reads them: the first word of each simple
 * command (after the words that only prefix it), the words that follow, and where it ends. A
 * runner or installer that stands there is a command that will run. One that stands among the
 * arguments of another command is a mention of one, and is no doubt about what will run only when
 * the line PROVES it inert, by a closed and tiny rule (see `inert` below): the message of `git
 * commit`, `git tag` or `git notes add`, the arguments of `echo` and `printf`, a line that is only a
 * comment, on a command line that has no pipe, redirection, substitution, group, condition or
 * string-running word anywhere.
 *
 * It is not a shell. It knows quotes, `$'…'`, substitutions, backticks, comments, here-documents,
 * separators, subshells and the string a shell is given with `-c`. Whatever it does not model, and
 * whatever hands a string to a shell it cannot read (`eval`, a `-c` that is not one quoted string,
 * a pipe or a here-document into a shell, `su -c`, `watch`, `find -exec`), makes the reading
 * `uncertain`, so that the caller treats every mention as a command, as it did before. One pass
 * over each stretch, each nested stretch once more.
 */

/** One command in command position. */
export interface LexedCommand {
  /** Where it ends: at the separator that follows it, or at the end of the text. */
  readonly end: number;
  /**
   * The start and end of each of its words, the command word first, then its arguments with the
   * redirections left out: `[start0, end0, start1, end1, …]`. Words that begin past the window are not kept.
   */
  readonly words: readonly number[];
  /** Words were left out because they begin past the window. */
  readonly truncated: boolean;
}

export interface CommandMap {
  /** The commands whose command word was asked for, by where the command word begins. */
  readonly commands: ReadonlyMap<number, LexedCommand>;
  /** Something was left open or hard to read: nothing here is known to be a mention. */
  readonly uncertain: boolean;
  /**
   * Of the mentions asked about, the ones the line proves inert. Empty when anything on the line
   * could make an inert-looking command run what it is given: a pipe, a redirection (a here-document
   * to `git commit` aside), a substitution or backtick, a group or condition or function, a word
   * that runs a string (`eval`, `source`, `.`, `xargs`, a shell, `ssh`, `su`, `watch`, ...), or an
   * option of git that can name a command (`-c`, `--config-env`). Meaningful only when the reading is not `uncertain`.
   */
  readonly inert: ReadonlySet<number>;
}

interface Context {
  readonly text: string;
  readonly wanted: (name: string) => boolean;
  readonly window: number;
  /** Where mentions of a launcher are, sorted: the ones to say are inert or not. */
  readonly mentions: readonly number[];
  readonly commands: Map<number, LexedCommand>;
  readonly inert: Set<number>;
  /** Nothing on the line has made an inert-looking command able to run what it is given. */
  inertAllowed: boolean;
  uncertain: boolean;
}

/** The command being read: its name, its first words, and the mentions inside its arguments. */
interface Current {
  readonly name: string;
  readonly args: string[];
  /** Mentions in the arguments that the command is known to only print or carry as a message. */
  readonly hits: number[];
  /** Nothing prefixed it: no assignment, no `sudo`, no `env`. */
  readonly plain: boolean;
  readonly wanted: { readonly start: number; readonly words: number[]; truncated: boolean } | null;
}

/** Nested constructs deeper than this are not read: the answer is that the reading is not sure. */
const MAX_NESTING = 24;
/** How many of the first arguments of a command are kept to tell what it is (`git commit`). */
const MAX_KEPT_ARGS = 8;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Words after which a command begins, which are not commands themselves. */
const OPENERS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
]);
const STOPS_A_WORD = ' \t\r\n;&|<>()';
const REDIRECTION = /&>>?|[<>]{1,2}[&|]?/y;
/** A flag that makes a shell run the next word as a command (`-c`, `-lc`). */
const COMMAND_STRING_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const DURATION = /^\d[\d.]*[smhd]?$/;

/** An option that hands a command line to the command (`-c`, `-lc`, `--command=…`). */
const runsAString = (raw: string): boolean =>
  COMMAND_STRING_FLAG.test(raw) || raw.startsWith('--command');

const isPrefixWord = (name: string): boolean =>
  PREFIX_WORDS.has(name) || Object.hasOwn(LOCAL_WRAPPERS, name);

/** The mentions in `[from, to)`, by binary search of the sorted list. */
function mentionsIn(ctx: Context, from: number, to: number): number[] {
  const { mentions } = ctx;
  let low = 0;
  let high = mentions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((mentions[middle] ?? 0) < from) low = middle + 1;
    else high = middle;
  }
  const found: number[] = [];
  for (let k = low; k < mentions.length && (mentions[k] ?? to) < to; k += 1)
    found.push(mentions[k] ?? 0);
  return found;
}

/** A lexer for one stretch of the text: it ends at `to`, and finds the stretches nested in it as it goes. */
class RangeLexer {
  private i: number;
  private expect = true;
  private prefix: string | null = null;
  private plainWords = 0;
  private skipValue = false;
  private target = false;
  private piped = false;
  private sawPrefix = false;
  private previous = '';
  private cur: Current | null = null;
  private codeNext = false;
  private sawOperand = false;
  private readonly pending: HeredocOpen[] = [];
  private readonly pendingInert: boolean[] = [];
  private readonly state: LexState = newLexState();
  private readonly strings: Array<readonly [number, number]> = [];

  constructor(
    private readonly ctx: Context,
    private readonly from: number,
    private readonly to: number,
    private readonly depth: number,
  ) {
    this.i = from;
  }

  run(): void {
    while (this.i < this.to) this.step();
    this.close(this.to);
    this.readNested();
  }

  private step(): void {
    const { text } = this.ctx;
    const char = text.charAt(this.i);
    if (char === ' ' || char === '\t' || char === '\r') this.i += 1;
    else if (char === '\\' && this.continuationLength() > 0) this.i += this.continuationLength();
    else if (char === '\n') this.newline();
    else if (char === '#' && startsComment(text, this.i, this.from)) this.comment();
    else if (char === ';') this.endAfter(text.charAt(this.i + 1) === ';' ? 2 : 1);
    else if (char === '(' || char === ')') {
      this.ctx.inertAllowed = false;
      this.endAfter(1);
    } else if (char === '|') this.pipe();
    else if (char === '&' && text.charAt(this.i + 1) === '&') this.endAfter(2);
    else if (char === '&' && text.charAt(this.i + 1) !== '>') this.endAfter(1);
    else if (char === '<' || char === '>' || char === '&') this.redirect();
    else this.word();
  }

  /** The length of a backslash and the line break after it, or 0. */
  private continuationLength(): number {
    const { text } = this.ctx;
    if (text.charAt(this.i + 1) === '\n') return 2;
    return text.charAt(this.i + 1) === '\r' && text.charAt(this.i + 2) === '\n' ? 3 : 0;
  }

  private endAfter(length: number): void {
    this.close(this.i);
    this.i += length;
  }

  /** A pipe ends a command, and the next one reads its output: a shell there reads a program it cannot see. */
  private pipe(): void {
    const next = this.ctx.text.charAt(this.i + 1);
    this.endAfter(next === '|' || next === '&' ? 2 : 1);
    this.piped = next !== '|';
    if (this.piped) this.ctx.inertAllowed = false;
  }

  private newline(): void {
    // A line break after a pipe continues the pipeline.
    const piped = this.piped;
    this.close(this.i);
    this.piped = piped;
    if (this.pending.length === 0) {
      this.i += 1;
      return;
    }
    const { text } = this.ctx;
    const read = readBodies(text, this.i + 1, this.pending);
    if (!read.closed) this.ctx.uncertain = true;
    this.pending.forEach((open, k) => {
      const range = read.ranges[k];
      if (range === undefined) return;
      if (this.pendingInert[k] === true) this.markInert(range[0], range[1]);
      // The body of a here-document that expands runs the commands in it.
      if (!open.quoted) scanExpansions(text, range[0], range[1], this.state);
    });
    this.pending.length = 0;
    this.pendingInert.length = 0;
    this.i = read.end;
  }

  private comment(): void {
    this.close(this.i);
    const eol = this.ctx.text.indexOf('\n', this.i);
    const end = eol === -1 || eol > this.to ? this.to : eol;
    if (this.startsItsLine(this.i)) this.markInert(this.i, end);
    this.i = end;
  }

  /** Whether only blanks stand before `at` on its line: the comment is the whole line. */
  private startsItsLine(at: number): boolean {
    const { text } = this.ctx;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    return text.slice(lineStart, at).trim() === '';
  }

  private markInert(from: number, to: number): void {
    for (const mention of mentionsIn(this.ctx, from, to)) this.ctx.inert.add(mention);
  }

  /** Whether the command being read is a git command that takes a message, with nothing prefixed to it. */
  private takesAMessage(): boolean {
    const { cur } = this;
    return cur !== null && cur.plain && cur.name === 'git' && isGitMessageCommand(cur.args);
  }

  /** A here-document or here-string given to a shell is a program the line does not show. */
  private feedsAShell(): void {
    if (this.cur !== null && SHELL_WORDS.has(this.cur.name)) this.ctx.uncertain = true;
  }

  /**
   * A redirection: a here-document is read for its body; any other puts the word after it aside.
   * Only a here-document given to a git command that takes a message leaves a line inert; every
   * other redirection of any kind may carry what a command printed to somewhere it runs.
   */
  private redirect(): void {
    const { text } = this.ctx;
    const at = this.i;
    if (text.startsWith('<<<', at)) {
      this.feedsAShell();
      this.ctx.inertAllowed = false;
      this.i += 3;
      this.target = true;
    } else if (text.startsWith('<<', at)) {
      this.feedsAShell();
      const open = readOpener(text, at);
      if (open === null) {
        this.ctx.uncertain = true;
        this.i += 2;
      } else {
        const inert = this.takesAMessage();
        if (!inert) this.ctx.inertAllowed = false;
        this.pending.push(open);
        this.pendingInert.push(inert);
        this.i = open.end;
      }
    } else if (
      (text.charAt(at) === '<' || text.charAt(at) === '>') &&
      text.charAt(at + 1) === '('
    ) {
      this.ctx.inertAllowed = false;
      this.word();
    } else {
      this.ctx.inertAllowed = false;
      REDIRECTION.lastIndex = at;
      const operator = REDIRECTION.exec(text);
      this.i += operator === null ? 1 : operator[0].length;
      this.target = true;
    }
  }

  private word(): void {
    const start = this.i;
    const end = this.wordEnd(start);
    this.i = end;
    if (this.target) {
      this.target = false;
      return;
    }
    if (this.isDescriptor(start, end)) return;
    if (this.skipValue) {
      this.skipValue = false;
      return;
    }
    if (this.expect) this.leading(start, end);
    else this.argument(start, end);
  }

  /** The end of the word that begins at `start`: quotes and substitutions hold their separators. */
  private wordEnd(start: number): number {
    const { text } = this.ctx;
    let at = start;
    if ((text.charAt(at) === '<' || text.charAt(at) === '>') && text.charAt(at + 1) === '(')
      return Math.min(skipSubstitution(text, at + 2, this.state), this.to);
    while (at < this.to) {
      const char = text.charAt(at);
      if (STOPS_A_WORD.includes(char)) break;
      if (char === '\\') at += 2;
      else if (char === "'") at = skipSingle(text, at, this.state);
      else if (char === '"') at = skipDouble(text, at, this.state);
      else if (char === '`') at = skipBacktick(text, at, this.state);
      else if (char === '$') {
        const end = skipDollar(text, at, this.state, false);
        at = end === -1 ? at + 1 : end;
      } else at += 1;
    }
    return Math.min(Math.max(at, start + 1), this.to);
  }

  /** A number right before a redirection operator names a file descriptor (`2>&1`), not an argument. */
  private isDescriptor(start: number, end: number): boolean {
    const { text } = this.ctx;
    const next = text.charAt(end);
    return (next === '<' || next === '>') && /^\d+$/.test(text.slice(start, end));
  }

  /** A word where a command may begin: an assignment, a keyword or a prefix is passed over; anything else is the command. */
  private leading(start: number, end: number): void {
    const raw = this.ctx.text.slice(start, end);
    if (ENV_ASSIGNMENT.test(raw)) {
      this.sawPrefix = true;
      return;
    }
    const name = canonicalCommand(raw);
    if (this.prefix !== null && this.passesOver(raw)) return;
    if (this.prefix === null && OPENERS.has(name)) {
      this.ctx.inertAllowed = false;
      return;
    }
    if (isPrefixWord(name)) {
      this.sawPrefix = true;
      if (STRING_RUNNERS.has(name)) this.ctx.inertAllowed = false;
      this.prefix = name;
      this.plainWords = LOCAL_WRAPPERS[name] ?? 0;
      if (RUNS_ITS_ARGUMENTS.has(name)) this.ctx.uncertain = true;
      return;
    }
    this.begin(start, end, name);
  }

  /** What stands between a wrapper and its command: its options, the values they take, a duration. */
  private passesOver(raw: string): boolean {
    if (raw.startsWith('-')) {
      // `env -S` splits a string into a command line, and `runuser -c` runs one.
      if (this.prefix === 'env' && (raw.startsWith('-S') || raw === '--split-string'))
        this.ctx.uncertain = true;
      if (RUNS_A_COMMAND_STRING.has(this.prefix ?? '') && runsAString(raw))
        this.ctx.uncertain = true;
      this.skipValue = optionTakesValue(this.prefix ?? '', raw);
      return true;
    }
    if (this.plainWords > 0) {
      this.plainWords -= 1;
      return true;
    }
    return DURATION.test(raw);
  }

  private begin(start: number, end: number, name: string): void {
    this.expect = false;
    this.prefix = null;
    if (this.piped && SHELL_WORDS.has(name)) this.ctx.uncertain = true;
    this.piped = false;
    if (RUNS_ITS_ARGUMENTS.has(name)) this.ctx.uncertain = true;
    if (this.runsAString(name)) this.ctx.inertAllowed = false;
    const wanted = this.ctx.wanted(name) ? { start, words: [start, end], truncated: false } : null;
    this.cur = { name, args: [], hits: [], plain: !this.sawPrefix, wanted };
    this.previous = '';
  }

  /** Whether the command word is one that runs a string, a program or another command, or makes the line one. */
  private runsAString(name: string): boolean {
    return (
      STRING_RUNNERS.has(name) ||
      COMPOUND_WORDS.has(name) ||
      SHELL_WORDS.has(name) ||
      RUNS_A_COMMAND_STRING.has(name) ||
      RUNS_ITS_ARGUMENTS.has(name)
    );
  }

  private argument(start: number, end: number): void {
    const { cur } = this;
    if (cur === null) return;
    if (cur.wanted !== null) {
      if (start - cur.wanted.start >= this.ctx.window) cur.wanted.truncated = true;
      else cur.wanted.words.push(start, end);
    }
    const raw = this.ctx.text.slice(start, end);
    if (this.ctx.mentions.length > 0 && this.isOnlyCarried(cur, start, end))
      cur.hits.push(...mentionsIn(this.ctx, start, end));
    const word = shellWord(raw).word;
    // An option of git that can name a command to run makes the line a program.
    if (cur.name === 'git' && gitSubcommand(cur.args) === undefined && isGitConfigOption(word))
      this.ctx.inertAllowed = false;
    if (cur.args.length < MAX_KEPT_ARGS) cur.args.push(word);
    this.previous = word;
    this.watch(cur.name, raw, start, end);
  }

  /**
   * Whether the word is only printed or carried: any argument of `echo` and `printf`, and the one
   * quoted string that is the message of a git command that takes one (`git commit -m "…"`).
   */
  private isOnlyCarried(cur: Current, start: number, end: number): boolean {
    if (!cur.plain) return false;
    if (PRINTERS.has(cur.name)) return true;
    return (
      cur.name === 'git' &&
      isGitMessageCommand(cur.args) &&
      isMessageFlag(this.previous) &&
      this.isWholeQuotedString(start, end)
    );
  }

  /** What an argument of a command that runs a string does to the reading. */
  private watch(name: string, raw: string, start: number, end: number): void {
    if (name === 'eval') this.ctx.uncertain = true;
    else if (SHELL_WORDS.has(name)) this.shellArgument(raw, start, end);
    else if (RUNS_A_COMMAND_STRING.has(name)) {
      if (runsAString(raw)) this.ctx.uncertain = true;
    } else if (name === 'find' && FIND_RUNS.has(raw)) this.ctx.uncertain = true;
  }

  /**
   * An argument of a shell: the string after `-c` is a command line of its own when it is one
   * quoted string. Anything else there (a variable, several words, a `--`, another flag) is a
   * program the line does not show.
   */
  private shellArgument(raw: string, start: number, end: number): void {
    if (this.codeNext) {
      this.codeNext = false;
      if (this.isWholeQuotedString(start, end)) this.strings.push([start + 1, end - 1]);
      else this.ctx.uncertain = true;
    } else if (!this.sawOperand && COMMAND_STRING_FLAG.test(raw)) this.codeNext = true;
    else if (!raw.startsWith('-')) this.sawOperand = true;
  }

  /** Whether the word is exactly one string in single or double quotes. */
  private isWholeQuotedString(start: number, end: number): boolean {
    const { text } = this.ctx;
    const quote = text.charAt(start);
    if (end - start < 2) return false;
    if (quote === "'") return skipSingle(text, start, newLexState()) === end;
    return quote === '"' && skipDouble(text, start, newLexState()) === end;
  }

  private close(at: number): void {
    const { cur } = this;
    if (cur !== null) {
      if (cur.wanted !== null)
        this.ctx.commands.set(cur.wanted.start, {
          end: at,
          words: cur.wanted.words,
          truncated: cur.wanted.truncated,
        });
      this.settle(cur);
    }
    this.cur = null;
    this.expect = true;
    this.prefix = null;
    this.plainWords = 0;
    this.skipValue = false;
    this.target = false;
    this.piped = false;
    this.codeNext = false;
    this.sawOperand = false;
    this.sawPrefix = false;
    this.previous = '';
  }

  /** Marks the mentions that the command only prints or carries as a message. */
  private settle(cur: Current): void {
    for (const hit of cur.hits) this.ctx.inert.add(hit);
  }

  /** The commands that run inside this stretch, read as stretches of their own. */
  private readNested(): void {
    if (this.state.uncertain) this.ctx.uncertain = true;
    const inner: Array<readonly [number, number]> = [
      ...this.state.nested.map((n): readonly [number, number] => [n.from, n.to]),
      ...this.strings,
    ];
    if (inner.length === 0) return;
    // A command that runs inside another could be given what an inert command printed.
    this.ctx.inertAllowed = false;
    if (this.depth >= MAX_NESTING) {
      this.ctx.uncertain = true;
      return;
    }
    for (const [from, to] of inner)
      new RangeLexer(this.ctx, from, Math.min(to, this.to), this.depth + 1).run();
  }
}

/**
 * The commands of `text` whose command word is one `wanted` asks for, whether the reading is sure,
 * and which of the `mentions` (where a launcher is named, sorted) are proven inert. `window` is
 * how far into a command its words are kept.
 */
export function commandMap(
  text: string,
  wanted: (name: string) => boolean,
  window: number,
  mentions: readonly number[] = [],
): CommandMap {
  const ctx: Context = {
    text,
    wanted,
    window,
    mentions,
    commands: new Map(),
    inert: new Set(),
    inertAllowed: true,
    uncertain: false,
  };
  new RangeLexer(ctx, 0, text.length, 0).run();
  return {
    commands: ctx.commands,
    uncertain: ctx.uncertain,
    inert: ctx.inertAllowed && !ctx.uncertain ? ctx.inert : new Set(),
  };
}
