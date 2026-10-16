// A lexer for JavaScript text that reads what Node reads and, where it cannot be sure, says so.
//
// It exists for one question: which modules does this file ask for (see `module-specifiers.ts`). The
// answer has to hold against a file written to be read differently by a reader and by Node, so the lexer
// has no recovery. Wherever the text could be read two ways and the ways differ in what they skip, it
// stops and sets `doubt`, and the caller treats a file with a doubt as one it could not read. That is
// cheaper than being exact (a regular expression is told from a division only by the token before it)
// and it cannot read as "nothing found": the reading is either complete or it says it is not.
//
// One pass, no backtracking: every position is looked at a bounded number of times, and a look-ahead is
// bounded by `AHEAD_MAX` characters of one line.

export interface Token {
  readonly kind: 'word' | 'string' | 'punct' | 'other';
  readonly text: string;
  /** For a string: its text holds a backslash, so it is not the module name it spells. */
  readonly escaped?: boolean;
}

/** The nesting of `${ }` inside template literals that is followed; deeper is a doubt. */
const HOLES_MAX = 64;
/** How far ahead on a line a slash is examined to tell whether it could start a regular expression. */
const AHEAD_MAX = 4096;

const OTHER: Token = { kind: 'other', text: '' };
/** Words after which a `/` starts a regular expression and does not divide. */
const BEFORE_REGEX: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'default',
]);
/** After these a `/` can be a division or the start of a regular expression, and only the text after it says which. */
const AMBIGUOUS_BEFORE: ReadonlySet<string> = new Set([')', ']', '}', '+', '-']);

const isLineTerminator = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

/** The white space of the language: tab, vertical tab, form feed, space, no-break space, the BOM and every `Zs`. */
const isBlank = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0b ||
  code === 0x0c ||
  code === 0x20 ||
  code === 0xa0 ||
  code === 0xfeff ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000;

const isWordChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x24 ||
  (code >= 0x80 && !isBlank(code) && !isLineTerminator(code));

export class Lexer {
  private pos = 0;
  private previous: Token | null = null;
  private braces = 0;
  /** The brace depth at which each open `${` of a template literal ends. */
  private readonly holes: number[] = [];
  /** A line terminator came since the last token (and the text starts at a line start). */
  private lineStart = true;
  /** Why the text could not be read with certainty, or null. Once set, `next` returns null. */
  doubt: string | null = null;

  constructor(private readonly text: string) {
    // A hashbang is a comment only as the very first thing in the text.
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (text.startsWith('#!', start)) this.pos = this.lineEnd(start);
  }

  private fail(reason: string): null {
    this.doubt ??= reason;
    this.pos = this.text.length;
    return null;
  }

  private lineEnd(from: number): number {
    for (let at = from; at < this.text.length; at += 1)
      if (isLineTerminator(this.text.charCodeAt(at))) return at;
    return this.text.length;
  }

  private emit(next: number, token: Token): Token {
    this.pos = Math.min(next, this.text.length);
    this.previous = token;
    this.lineStart = false;
    return token;
  }

  /** Skips blanks and comments; false at the end of the text, or when a comment is not closed. */
  private skipTrivia(): boolean {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (isLineTerminator(code)) {
        this.lineStart = true;
        this.pos += 1;
      } else if (isBlank(code)) this.pos += 1;
      else if (code === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x2f)
        this.pos = this.lineEnd(this.pos);
      else if (code === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x2a) {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end === -1) {
          this.fail('a comment is not closed');
          return false;
        }
        // A comment that holds a line break counts as one for the HTML-like `-->` comment.
        for (let at = this.pos; at < end; at += 1)
          if (isLineTerminator(this.text.charCodeAt(at))) this.lineStart = true;
        this.pos = end + 2;
      } else return true;
    }
    return false;
  }

  next(): Token | null {
    if (this.doubt !== null) return null;
    if (!this.skipTrivia()) {
      if (this.doubt === null && this.holes.length > 0) this.fail('a template hole is not closed');
      return null;
    }
    const code = this.text.charCodeAt(this.pos);
    if (code === 0x27 || code === 0x22) return this.readString(code);
    if (code === 0x60) return this.readTemplate(this.pos + 1, true);
    if (code === 0x2f) return this.slash();
    if (code === 0x5c) return this.fail('a backslash outside a string, which spells an identifier');
    if (isWordChar(code)) return this.readWord();
    return this.readPunct(code);
  }

  /** A string up to its closing quote; a line break before it, or the end of the text, is a doubt. */
  private readString(quote: number): Token | null {
    let at = this.pos + 1;
    let escaped = false;
    for (;;) {
      const code = this.text.charCodeAt(at);
      if (Number.isNaN(code) || code === 0x0a || code === 0x0d)
        return this.fail('a string is not closed on its line');
      if (code === quote) break;
      if (code === 0x5c) {
        escaped = true;
        at += this.text.startsWith('\r\n', at + 1) ? 3 : 2;
      } else at += 1;
    }
    return this.emit(at + 1, { kind: 'string', text: this.text.slice(this.pos + 1, at), escaped });
  }

  /**
   * Template text from `from` to the closing backtick, or to a `${` whose hole is then read as code. A
   * template with no hole is a string; one with a hole has no name to read.
   */
  private readTemplate(from: number, whole: boolean): Token | null {
    let at = from;
    let escaped = false;
    while (at < this.text.length) {
      const code = this.text.charCodeAt(at);
      if (code === 0x5c) {
        escaped = true;
        at += 2;
      } else if (code === 0x60)
        return this.emit(
          at + 1,
          whole ? { kind: 'string', text: this.text.slice(from, at), escaped } : OTHER,
        );
      else if (code === 0x24 && this.text.charCodeAt(at + 1) === 0x7b) {
        if (this.holes.length >= HOLES_MAX) return this.fail('templates are nested too deep');
        this.holes.push(this.braces);
        return this.emit(at + 2, OTHER);
      } else at += 1;
    }
    return this.fail('a template is not closed');
  }

  private slash(): Token | null {
    const before = this.previous;
    const text = before?.kind === 'punct' || before?.kind === 'word' ? before.text : '';
    const ambiguous = before?.kind === 'punct' && AMBIGUOUS_BEFORE.has(text);
    const regex =
      before === null ||
      (before.kind === 'punct' && !ambiguous) ||
      (before.kind === 'word' && BEFORE_REGEX.has(text));
    if (regex) return this.readRegex();
    if (ambiguous && this.couldBeRegex())
      return this.fail('a slash could divide or start a regular expression');
    return this.emit(this.pos + 1, { kind: 'punct', text: '/' });
  }

  /**
   * Whether the slash at the cursor could start a regular expression whose text would be read differently
   * as code: it has a closing slash on its line, and between them a quote, a backtick or a brace. No
   * closing slash on the line means it divides. A line that goes on past what is looked at is a doubt.
   */
  private couldBeRegex(): boolean {
    let inClass = false;
    const end = Math.min(this.text.length, this.pos + 1 + AHEAD_MAX);
    for (let at = this.pos + 1; at < end; at += 1) {
      const code = this.text.charCodeAt(at);
      if (isLineTerminator(code)) return false;
      if (code === 0x5c) at += 1;
      else if (code === 0x5b) inClass = true;
      else if (code === 0x5d) inClass = false;
      else if (code === 0x2f && !inClass) return this.riskyBetween(this.pos + 1, at);
    }
    return end < this.text.length;
  }

  private riskyBetween(from: number, to: number): boolean {
    for (let at = from; at < to; at += 1) {
      const code = this.text.charCodeAt(at);
      if (code === 0x27 || code === 0x22 || code === 0x60 || code === 0x7b || code === 0x7d)
        return true;
    }
    return false;
  }

  private readRegex(): Token | null {
    let at = this.pos + 1;
    let inClass = false;
    for (;;) {
      const code = this.text.charCodeAt(at);
      if (Number.isNaN(code) || isLineTerminator(code))
        return this.fail('a regular expression is not closed on its line');
      if (code === 0x5c) at += 2;
      else if (code === 0x5b) {
        inClass = true;
        at += 1;
      } else if (code === 0x5d) {
        inClass = false;
        at += 1;
      } else if (code === 0x2f && !inClass) break;
      else at += 1;
    }
    at += 1;
    while (at < this.text.length && isWordChar(this.text.charCodeAt(at))) at += 1;
    return this.emit(at, OTHER);
  }

  private readWord(): Token {
    let at = this.pos + 1;
    while (at < this.text.length && isWordChar(this.text.charCodeAt(at))) at += 1;
    const word = this.text.slice(this.pos, at);
    // A number is not a name: `1e5` and `0x1f` are one token that nothing reads.
    return this.emit(at, word.charCodeAt(0) <= 0x39 ? OTHER : { kind: 'word', text: word });
  }

  private readPunct(code: number): Token | null {
    const char = this.text[this.pos] ?? '';
    // `<!--` and a `-->` that starts a line are comments in a script and not in a module: no reading of
    // the text settles which of them Node uses for this file, so the text is not read.
    if (code === 0x3c && this.text.startsWith('<!--', this.pos))
      return this.fail('an HTML-like comment');
    if (code === 0x2d && this.lineStart && this.text.startsWith('-->', this.pos))
      return this.fail('an HTML-like comment');
    if (code === 0x7b) this.braces += 1;
    if (code === 0x7d) {
      if (this.holes.length > 0 && this.holes[this.holes.length - 1] === this.braces) {
        this.holes.pop();
        return this.readTemplate(this.pos + 1, false);
      }
      this.braces = Math.max(0, this.braces - 1);
    }
    return this.emit(this.pos + 1, { kind: 'punct', text: char });
  }
}
