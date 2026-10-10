import { expandWrittenBraces } from './brace-expansion.js';
import { checkDeadline } from './deadline.js';
import { decodeOne, escapeLength, hasExpansion } from './shell-escapes.js';
import { isSpace } from './shell-lex.js';
import {
  newLexState,
  skipBacktick,
  skipBraces,
  skipSubstitution,
  type LexState,
} from './shell-skip.js';

/**
 * The words of one stage of a command, read as a shell reads them. `shell-words.ts` reads the command
 * they name, and re-exports all of this.
 *
 * A word keeps what a reader of commands has to ask of it: its value (quotes taken off, escapes
 * decoded), whether any quote or escape made part of it (`'>x'` is text, not a redirect), whether
 * the shell would expand it before the command saw it (so that what the command is given is not
 * what the text says), and whether it begins with a redirect operator.
 */
export interface Word {
  readonly value: string;
  readonly quoted: boolean;
  /** The word begins with an unquoted redirect operator: `>x`, `2>&1`, `<<<'text'`. */
  readonly redirect: boolean;
  /** An unquoted `(` or `)`: a subshell or a function's parentheses, not text. */
  readonly group: boolean;
  /** `$name`, `${…}`, `$(…)`, backticks, a glob or a brace expansion, outside single quotes. */
  readonly expands: boolean;
  /** The word as it is written, quotes and all; none for a word that no text holds. */
  readonly raw?: string;
}

/** `2>`, `&>>`, `{fd}>`, `<<<`, `<`: a redirect operator with its descriptor, possibly with its target glued on. */
export const REDIRECT = /^(\d+|&|\{[A-Za-z_]\w*\})?(<<<|<<-|<<|<&|<>|<|>>|>&|>\||>)/;
/** The word in front of a redirect operator that goes with it: a descriptor, `2>&1`, or the name of one the shell makes, `{fd}>file`. */
const DESCRIPTOR = /^(?:\d+|\{[A-Za-z_]\w*\})$/;

// -------------------------------------------------------------------------------------------
// Words
// -------------------------------------------------------------------------------------------

/**
 * Where a substitution or parameter expansion that begins at `i` ends, or -1 if none begins. A
 * process substitution, `<(…)`, is one only outside double quotes; zsh's `=(…)` only at the
 * start of a word.
 */
function endOfExpansion(
  text: string,
  i: number,
  state: LexState,
  inDouble: boolean,
  wordStart: boolean,
): number {
  const ch = text.charAt(i);
  const next = text.charAt(i + 1);
  if (ch === '$' && next === '(') return skipSubstitution(text, i + 2, state);
  if (ch === '$' && next === '{') return skipBraces(text, i + 1, state, inDouble);
  if (ch === '`') return skipBacktick(text, i, state);
  if (inDouble || next !== '(') return -1;
  return ch === '<' || ch === '>' || (ch === '=' && wordStart)
    ? skipSubstitution(text, i + 2, state)
    : -1;
}

/** The most words the brace expansions in one text may make: past it a word is left as it was written. */
const MAX_BRACE_READ_WORDS = 4096;

/** The characters that begin a redirect operator, and those that may follow its first. */
const OPERATOR_RUN = '<>&|';

/** Reads the words of one stage: the quote it is inside, the word it is building, where it began. */
class WordReader {
  readonly words: Word[] = [];
  private readonly state = newLexState();
  private value = '';
  private from = -1;
  private quoted = false;
  private redirect = false;
  /** The word so far is only the operator of a redirect: a second operator character joins it. */
  private operatorOnly = false;
  private quote: '' | "'" | '"' | '$' = '';

  /** How many words the brace expansions of this text may still make before they are not read. */
  private room = MAX_BRACE_READ_WORDS;
  /** The word just before was a redirect operator alone: this one is its target, which is not expanded. */
  private afterOperator = false;

  /**
   * `literal`: the text is a word a brace expansion made, which no redirect operator or parenthesis
   * in it makes anything of: `{bash,<x}` runs `bash` on a file called `<x`.
   */
  constructor(
    private readonly text: string,
    private readonly literal = false,
  ) {}

  /** The text ended inside a quote. */
  get open(): boolean {
    return this.quote !== '';
  }

  /** Reads the character at `i`; returns the index of the last one it used. */
  read(i: number): number {
    if (this.quote === "'") return this.single(i);
    if (this.quote === '$') return this.ansiC(i);
    if (this.quote === '"') return this.double(i);
    return this.plain(i);
  }

  /** The word that was being built ends before `end`. */
  flush(end: number): void {
    if (this.from !== -1) {
      const raw = this.text.slice(this.from, end);
      const made =
        this.redirect || this.afterOperator || !raw.includes('{') ? null : this.expanded(raw);
      const operator = this.redirect ? REDIRECT.exec(this.value) : null;
      this.afterOperator = operator !== null && operator[0].length === this.value.length;
      if (made === null)
        this.words.push({
          value: this.value,
          quoted: this.quoted,
          redirect: this.redirect,
          group: false,
          expands: hasExpansion(raw),
          raw,
        });
      else
        for (const piece of made)
          for (const word of readWords(piece, true).words) this.words.push(word);
    }
    this.value = '';
    this.from = -1;
    this.quoted = false;
    this.redirect = false;
    this.operatorOnly = false;
  }

  /**
   * The words a brace expansion makes of the word as it is written, or null where it makes none or
   * more than are read: the quotes are taken off after, as the shell does, so a word that holds
   * a quoted string (`{bash,-c,'rm -rf ~'}`) is expanded all the same.
   */
  private expanded(raw: string): string[] | null {
    const made = expandWrittenBraces(raw);
    if (made === null || (made.length === 1 && made[0] === raw) || made.length > this.room)
      return null;
    this.room -= made.length;
    return made;
  }

  private single(i: number): number {
    const ch = this.text.charAt(i);
    if (ch === "'") this.quote = '';
    else this.value += ch;
    return i;
  }

  /** `$'…'`: escapes are decoded, and `\'` does not close it. */
  private ansiC(i: number): number {
    const ch = this.text.charAt(i);
    if (ch === "'") this.quote = '';
    else if (ch === '\\' && i + 1 < this.text.length) {
      const length = escapeLength(this.text, i, 'ansi');
      this.value += decodeOne(this.text, i, length, 'ansi');
      return i + length - 1;
    } else this.value += ch;
    return i;
  }

  private double(i: number): number {
    const ch = this.text.charAt(i);
    if (ch === '"') {
      this.quote = '';
      return i;
    }
    const end = endOfExpansion(this.text, i, this.state, true, false);
    if (end !== -1) {
      this.value += this.text.slice(i, end);
      return end - 1;
    }
    if (ch !== '\\' || i + 1 >= this.text.length) {
      this.value += ch;
      return i;
    }
    const next = this.text.charAt(i + 1);
    if ('"\\$`'.includes(next)) this.value += next;
    else if (next !== '\n') this.value += ch + next;
    return i + 1;
  }

  /** An unquoted parenthesis is a word of its own, unless it opens an extended glob (`@(a|b)`). */
  private parenthesis(i: number): number {
    const { text } = this;
    const ch = text.charAt(i);
    // `f+()` is a function named `f+`: an extended glob has something between its parentheses.
    if (
      ch === '(' &&
      this.value.length > 0 &&
      '@?*+!'.includes(this.value.slice(-1)) &&
      text.charAt(i + 1) !== ')'
    ) {
      const end = skipSubstitution(text, i + 1, this.state);
      this.value += text.slice(i, end);
      return end - 1;
    }
    this.flush(i);
    this.words.push({
      value: ch,
      quoted: false,
      redirect: false,
      group: true,
      expands: false,
      raw: ch,
    });
    return i;
  }

  /**
   * A redirect operator ends the word before it (`bash<<<x` is `bash` and `<<<x`) unless that
   * word is only the descriptor in front of it (`2>&1`), and begins a word of its own.
   */
  private operator(i: number): number {
    const { text } = this;
    const descriptor = !this.quoted && DESCRIPTOR.test(this.value);
    if (this.from !== -1 && !descriptor && !(this.redirect && this.operatorOnly)) this.flush(i);
    if (this.from === -1) this.from = i;
    this.redirect = true;
    this.operatorOnly = true;
    let end = i;
    while (end < text.length && OPERATOR_RUN.includes(text.charAt(end))) end += 1;
    // `<&-` closes a descriptor.
    if (text.charAt(end) === '-' && text.charAt(end - 1) === '&') end += 1;
    this.value += text.slice(i, end);
    return end - 1;
  }

  private plain(i: number): number {
    const { text } = this;
    const ch = text.charAt(i);
    if (ch === '\\' && text.charAt(i + 1) === '\n') return i + 1; // joined lines
    if (isSpace(text.charCodeAt(i))) {
      this.flush(i);
      return i;
    }
    const expansion = endOfExpansion(text, i, this.state, false, this.from === -1);
    if (expansion !== -1) {
      if (this.from === -1) this.from = i;
      this.operatorOnly = false;
      this.value += text.slice(i, expansion);
      return expansion - 1;
    }
    if (!this.literal) {
      if (ch === '(' || ch === ')') return this.parenthesis(i);
      if (ch === '<' || ch === '>' || (ch === '&' && text.charAt(i + 1) === '>'))
        return this.operator(i);
    }
    if (this.from === -1) this.from = i;
    this.operatorOnly = false;
    return this.character(i);
  }

  /** An ordinary character, a quote, or a backslash. */
  private character(i: number): number {
    const { text } = this;
    const ch = text.charAt(i);
    if (ch === '$' && (text.charAt(i + 1) === "'" || text.charAt(i + 1) === '"')) {
      this.quote = text.charAt(i + 1) === "'" ? '$' : '"';
      this.quoted = true;
      return i + 1;
    }
    if (ch === '"' || ch === "'") {
      this.quote = ch;
      this.quoted = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      this.value += text.charAt(i + 1);
      this.quoted = true;
      return i + 1;
    } else this.value += ch;
    return i;
  }
}

/**
 * A stage's words, split at white space and operators outside quotes, with the quotes taken off, and
 * whether the text ended inside a quote: a piece of a quoted string that the plain cut left.
 */
export function readWords(
  text: string,
  literal = false,
): { readonly words: Word[]; readonly open: boolean } {
  checkDeadline();
  const reader = new WordReader(text, literal);
  for (let i = 0; i < text.length; i += 1) i = reader.read(i);
  reader.flush(text.length);
  return { words: reader.words, open: reader.open };
}

/** A stage's words, split at white space and operators outside quotes, with the quotes taken off. */
export function argv(text: string): Word[] {
  return readWords(text).words;
}

// -------------------------------------------------------------------------------------------
// Groups
// -------------------------------------------------------------------------------------------

interface Grouping {
  /** The stage's text without the grouping characters that open it and close it. */
  readonly start: number;
  readonly end: number;
  /** The subshells it opens, and the closing parentheses it ends with that close none of its own. */
  readonly opens: number;
  readonly closes: number;
}

/**
 * The grouping characters a subshell, a brace group or a `!` leaves on a stage. A closing `)` is a
 * group's only where it has no `(` to close inside the stage (`bash)` after `(cat x.sh | bash`,
 * not the end of `$(date)`), and a `}` is one only as a word of its own (`{ echo x; }`, not the
 * `{}` of `xargs -I{} sh -c {}`).
 */
function grouping(text: string): Grouping {
  let start = 0;
  let end = text.length;
  let opens = 0;
  const space = (i: number): boolean => isSpace(text.charCodeAt(i));
  while (start < end && ('({!'.includes(text.charAt(start)) || space(start))) {
    if (text.charAt(start) === '(') opens += 1;
    start += 1;
  }
  let excess = 0;
  for (let i = start; i < end; i += 1) {
    const ch = text.charAt(i);
    if (ch === '(') excess -= 1;
    else if (ch === ')') excess += 1;
  }
  const closes = Math.max(0, excess);
  for (;;) {
    while (end > start && (text.charAt(end - 1) === ';' || space(end - 1))) end -= 1;
    const last = text.charAt(end - 1);
    if (end > start && last === ')' && excess > 0) {
      excess -= 1;
      end -= 1;
    } else if (end > start && last === '}' && (end - 1 === start || space(end - 2))) end -= 1;
    else break;
  }
  return { start, end, opens, closes };
}

/** The subshells a stage opens and closes: `(cd sub)` opens one and closes it; `bash)` closes one. */
export function groupMarks(text: string): { readonly opens: number; readonly closes: number } {
  const { opens, closes } = grouping(text);
  return { opens, closes };
}
