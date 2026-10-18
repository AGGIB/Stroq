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
import { shellWord } from './shell-word.js';

/**
 * Where the commands of a command line are, as a shell reads them: the first word of each simple
 * command (after the words that only prefix it), the words that follow, and where it ends. A
 * runner or installer that stands there is a command that will run. One that stands inside quotes,
 * a here-document, a comment, or among the arguments of another command is a mention of one, and
 * what its words are is no doubt about what will run.
 *
 * It is not a shell. It knows quotes, `$'…'`, substitutions, backticks, comments, here-documents,
 * separators, subshells and the string a shell is given with `-c` or `eval`, and says so when it
 * is not sure it read the text right (`uncertain`), so that the caller can treat every mention as a
 * command, as it did before. One pass over each stretch, each nested stretch once more.
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
}

interface Context {
  readonly text: string;
  readonly wanted: (name: string) => boolean;
  readonly window: number;
  readonly commands: Map<number, LexedCommand>;
  uncertain: boolean;
}

interface OpenCommand {
  readonly start: number;
  readonly words: number[];
  truncated: boolean;
}

/** Nested constructs deeper than this are not read: the answer is that the reading is not sure. */
const MAX_NESTING = 24;
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
const COMMAND_STRING_FLAG = /^-[a-z]*c[a-z]*$/i;
const DURATION = /^\d[\d.]*[smhd]?$/;

/** A word's name for the table of commands: unquoted and lower-cased; empty when it is an expansion. */
export function commandName(raw: string): string {
  const { word } = shellWord(raw);
  return /[$`]/.test(word) ? '' : word.toLowerCase();
}

const isPrefixWord = (name: string): boolean =>
  PREFIX_WORDS.has(name) || Object.hasOwn(LOCAL_WRAPPERS, name);

/** A lexer for one stretch of the text: it ends at `to`, and finds the stretches nested in it as it goes. */
class RangeLexer {
  private i: number;
  private expect = true;
  private prefix: string | null = null;
  private plainWords = 0;
  private skipValue = false;
  private target = false;
  private open: OpenCommand | null = null;
  private runs: 'shell' | 'eval' | null = null;
  private codeNext = false;
  private readonly pending: HeredocOpen[] = [];
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
    else if (char === '(' || char === ')') this.endAfter(1);
    else if (char === '|')
      this.endAfter(text.charAt(this.i + 1) === '|' || text.charAt(this.i + 1) === '&' ? 2 : 1);
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

  private newline(): void {
    this.close(this.i);
    if (this.pending.length === 0) {
      this.i += 1;
      return;
    }
    const { text } = this.ctx;
    const read = readBodies(text, this.i + 1, this.pending);
    if (!read.closed) this.ctx.uncertain = true;
    this.pending.forEach((open, k) => {
      const range = read.ranges[k];
      // The body of a here-document that expands runs the commands in it.
      if (!open.quoted && range !== undefined) scanExpansions(text, range[0], range[1], this.state);
    });
    this.pending.length = 0;
    this.i = read.end;
  }

  private comment(): void {
    this.close(this.i);
    const eol = this.ctx.text.indexOf('\n', this.i);
    this.i = eol === -1 || eol > this.to ? this.to : eol;
  }

  /** A redirection: a here-document is read for its body; any other puts the word after it aside. */
  private redirect(): void {
    const { text } = this.ctx;
    const at = this.i;
    if (text.startsWith('<<<', at)) {
      this.i += 3;
      this.target = true;
    } else if (text.startsWith('<<', at)) {
      const open = readOpener(text, at);
      if (open === null) {
        this.ctx.uncertain = true;
        this.i += 2;
      } else {
        this.pending.push(open);
        this.i = open.end;
      }
    } else if (
      (text.charAt(at) === '<' || text.charAt(at) === '>') &&
      text.charAt(at + 1) === '('
    ) {
      this.word();
    } else {
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
    if (ENV_ASSIGNMENT.test(raw)) return;
    const name = commandName(raw);
    if (this.prefix !== null && this.passesOver(raw)) return;
    if (this.prefix === null && OPENERS.has(name)) return;
    if (isPrefixWord(name)) {
      this.prefix = name;
      this.plainWords = LOCAL_WRAPPERS[name] ?? 0;
      return;
    }
    this.begin(start, end, name);
  }

  /** What stands between a wrapper and its command: its options, the values they take, a duration. */
  private passesOver(raw: string): boolean {
    if (raw.startsWith('-')) {
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
    this.open = this.ctx.wanted(name) ? { start, words: [start, end], truncated: false } : null;
    this.runs = SHELL_WORDS.has(name) ? 'shell' : name === 'eval' ? 'eval' : null;
  }

  private argument(start: number, end: number): void {
    if (this.open !== null) {
      if (start - this.open.start >= this.ctx.window) this.open.truncated = true;
      else this.open.words.push(start, end);
    }
    if (this.runs === null) return;
    const raw = this.ctx.text.slice(start, end);
    if (this.runs === 'shell' && COMMAND_STRING_FLAG.test(raw)) this.codeNext = true;
    else if (this.runs === 'eval' || this.codeNext) {
      this.holdsCommands(start, end);
      this.codeNext = false;
      this.runs = this.runs === 'eval' ? null : this.runs;
    }
  }

  /** A word that is one quoted string handed to a shell: what is inside is a command line of its own. */
  private holdsCommands(start: number, end: number): void {
    const { text } = this.ctx;
    const quote = text.charAt(start);
    if ((quote === "'" || quote === '"') && end - start >= 2 && text.charAt(end - 1) === quote)
      this.strings.push([start + 1, end - 1]);
  }

  private close(at: number): void {
    if (this.open !== null) {
      this.ctx.commands.set(this.open.start, {
        end: at,
        words: this.open.words,
        truncated: this.open.truncated,
      });
    }
    this.open = null;
    this.expect = true;
    this.prefix = null;
    this.plainWords = 0;
    this.skipValue = false;
    this.target = false;
    this.runs = null;
    this.codeNext = false;
  }

  /** The commands that run inside this stretch, read as stretches of their own. */
  private readNested(): void {
    if (this.state.uncertain) this.ctx.uncertain = true;
    const inner: Array<readonly [number, number]> = [
      ...this.state.nested.map((n): readonly [number, number] => [n.from, n.to]),
      ...this.strings,
    ];
    if (inner.length === 0) return;
    if (this.depth >= MAX_NESTING) {
      this.ctx.uncertain = true;
      return;
    }
    for (const [from, to] of inner)
      new RangeLexer(this.ctx, from, Math.min(to, this.to), this.depth + 1).run();
  }
}

/**
 * The commands of `text` whose command word is one `wanted` asks for, and whether the reading is
 * sure. `window` is how far into a command its words are kept.
 */
export function commandMap(
  text: string,
  wanted: (name: string) => boolean,
  window: number,
): CommandMap {
  const ctx: Context = { text, wanted, window, commands: new Map(), uncertain: false };
  new RangeLexer(ctx, 0, text.length, 0).run();
  return { commands: ctx.commands, uncertain: ctx.uncertain };
}
