// A lexer for JavaScript text that reads what Node reads and, where it cannot be sure, says so.
//
// It exists for one question: which modules does this file ask for (see `module-specifiers.ts`). The
// answer has to hold against a file written to be read differently by a reader and by Node, so the lexer
// has no recovery. Wherever the text could be read two ways and the ways differ in what they skip, it
// stops and sets a doubt (with the reason and the place), and the caller treats a file with a doubt as one
// it could not read. That is cheaper than being exact and it cannot read as "nothing found": the reading is
// either complete or it says it is not.
//
// The one place where JavaScript cannot be lexed without its grammar is a `/`: it divides, or it starts a
// regular expression, and what follows decides what the text is. The standard answer is used here, from the
// token before it and the brackets around it:
//  - after a word that is a property name (`a.default / 2`), a literal, `]`, or a `)` that closes anything but
//    the head of an `if`, `while`, `for`, `with`, `catch` or `switch`, it divides;
//  - after an operator, `(`, `[`, `,`, `;`, `${`, `=>`, a keyword that is followed by an expression (`return`,
//    `typeof`, `case`, ...), or the `)` of such a head, it starts a regular expression;
//  - after `}` it depends on whether the brace closed a block or an object, a function or a class that is a
//    value, which is decided from the token before the matching `{` (and where the `function` or `class` stood);
//  - after `of`, `yield`, `await`, `let`, `static`, `async`, `get` and `set` (words that are names in some
//    places and keywords in others), and after a `}` that cannot be told, it is a doubt.
// A stack of the open brackets keeps this, and doubles as a check on the lexer itself: a closing bracket that
// matches nothing, or a bracket left open at the end, means that something earlier was read wrongly, and is a
// doubt too.
//
// One pass, no backtracking, and no look-ahead beyond a token: the work is a few steps per character.

export interface Token {
  readonly kind: 'word' | 'string' | 'punct' | 'other';
  readonly text: string;
  /** Where the token starts in the text. */
  readonly at: number;
  /** For a string: its text holds a backslash, so it is not the module name it spells. */
  readonly escaped?: boolean;
}

export interface Doubt {
  readonly reason: string;
  readonly at: number;
}

/** The deepest nesting of brackets that is followed; deeper is a doubt. */
const DEPTH_MAX = 4096;
/** The nesting of `${ }` inside template literals that is followed; deeper is a doubt. */
const HOLES_MAX = 64;

type BraceKind = 'block' | 'object' | 'function-expr' | 'class-expr' | 'ambiguous';
/** Whether a `function` or a `class` stands where a statement starts (a declaration) or inside an expression. */
type Position = 'stmt' | 'expr' | 'unknown';

type Frame =
  | {
      readonly kind: 'paren';
      /** The head of `if`, `while`, `for`, `with`, `catch` or `switch`: a statement follows it. */
      readonly head: boolean;
      readonly forHead: boolean;
      /** The parameters of a `function`, with the position of the keyword. */
      readonly fn: Position | null;
    }
  | { readonly kind: 'bracket' }
  | { readonly kind: 'brace'; readonly brace: BraceKind }
  | { readonly kind: 'hole' };

/** What the last closing bracket was, for the `/` that may follow it. */
type Closed = Extract<Frame, { kind: 'paren' | 'bracket' | 'brace' }>;

const OTHER = (at: number): Token => ({ kind: 'other', text: '', at });

/** After these a `/` starts a regular expression: an expression follows. */
const REGEX_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'extends',
  'default',
]);
/** Words that are values: a `/` after one divides. */
const VALUE_WORDS: ReadonlySet<string> = new Set(['this', 'null', 'true', 'false', 'super']);
/** Names in some places and keywords in others, so that a `/` after one is a doubt. */
const AMBIGUOUS_WORDS: ReadonlySet<string> = new Set([
  'of',
  'yield',
  'await',
  'let',
  'static',
  'async',
  'get',
  'set',
]);
/** The heads of statements whose parenthesis is followed by a statement. */
const HEAD_WORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with', 'catch', 'switch']);
/** Before `{` these make a block. */
const BLOCK_WORDS: ReadonlySet<string> = new Set(['else', 'do', 'try', 'finally']);
/** Before `{` these make an object: an expression follows them. */
const OBJECT_WORDS: ReadonlySet<string> = new Set([
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
  'yield',
  'await',
  'default',
  'extends',
]);

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

const isPunct = (token: Token | null, text: string): boolean =>
  token?.kind === 'punct' && token.text === text;
const isWord = (token: Token | null, text?: string): boolean =>
  token?.kind === 'word' && (text === undefined || token.text === text);
/** A token after which an operator stands: it ends an operand. */
const endsOperand = (token: Token | null): boolean =>
  token !== null &&
  (token.kind === 'string' ||
    token.kind === 'other' ||
    (token.kind === 'word' && !REGEX_WORDS.has(token.text)) ||
    isPunct(token, ')') ||
    isPunct(token, ']'));

export class Lexer {
  private pos = 0;
  private prev: Token | null = null;
  private prev2: Token | null = null;
  private prev3: Token | null = null;
  private readonly frames: Frame[] = [];
  private holes = 0;
  private closed: Closed | null = null;
  private pendingFn: { position: Position; depth: number } | null = null;
  private pendingClass: { position: Position; depth: number } | null = null;
  /** A line terminator came since the last token (and the text starts at a line start). */
  private lineStart = true;
  private reason: Doubt | null = null;

  constructor(private readonly text: string) {
    // A hashbang is a comment only as the very first thing in the text.
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (text.startsWith('#!', start)) this.pos = this.lineEnd(start);
  }

  /** Why the text could not be read with certainty, and where, or null. Once set, `next` returns null. */
  get doubt(): Doubt | null {
    return this.reason;
  }

  private fail(reason: string, at = this.pos): null {
    this.reason ??= { reason, at };
    this.pos = this.text.length;
    return null;
  }

  private lineEnd(from: number): number {
    for (let at = from; at < this.text.length; at += 1)
      if (isLineTerminator(this.text.charCodeAt(at))) return at;
    return this.text.length;
  }

  // ---------------------------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------------------------

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
    if (this.reason !== null) return null;
    if (!this.skipTrivia()) return this.atEnd();
    const code = this.text.charCodeAt(this.pos);
    if (code === 0x27 || code === 0x22) return this.readString(code);
    if (code === 0x60) return this.readTemplate(this.pos + 1, true, this.pos);
    if (code === 0x2f) return this.slash();
    if (isWordChar(code) || code === 0x5c) return this.readWord();
    return this.readPunct(code);
  }

  /** The end of the text: every bracket that was opened has to have been closed. */
  private atEnd(): null {
    if (this.reason === null && this.frames.length > 0)
      this.fail('a bracket is not closed', this.text.length);
    return null;
  }

  private emit(next: number, token: Token): Token {
    this.pos = Math.min(next, this.text.length);
    this.prev3 = this.prev2;
    this.prev2 = this.prev;
    this.prev = token;
    this.lineStart = false;
    // Between `function` and its parameters there is only a name and a star.
    if (this.pendingFn !== null && token.kind !== 'word' && !isPunct(token, '*'))
      this.pendingFn = null;
    return token;
  }

  /** A string up to its closing quote; a line break before it, or the end of the text, is a doubt. */
  private readString(quote: number): Token | null {
    const start = this.pos;
    let at = start + 1;
    let escaped = false;
    for (;;) {
      const code = this.text.charCodeAt(at);
      if (Number.isNaN(code) || code === 0x0a || code === 0x0d)
        return this.fail('a string is not closed on its line', start);
      if (code === quote) break;
      if (code === 0x5c) {
        escaped = true;
        at += this.text.startsWith('\r\n', at + 1) ? 3 : 2;
      } else at += 1;
    }
    return this.emit(at + 1, {
      kind: 'string',
      text: this.text.slice(start + 1, at),
      at: start,
      escaped,
    });
  }

  /**
   * Template text from `from` to the closing backtick, or to a `${` whose hole is then read as code. A
   * template with no hole is a string; one with a hole has no name to read.
   */
  private readTemplate(from: number, whole: boolean, start: number): Token | null {
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
          whole
            ? { kind: 'string', text: this.text.slice(from, at), at: start, escaped }
            : OTHER(start),
        );
      else if (code === 0x24 && this.text.charCodeAt(at + 1) === 0x7b) {
        if (this.holes >= HOLES_MAX) return this.fail('templates are nested too deep', start);
        if (!this.push({ kind: 'hole' })) return null;
        this.holes += 1;
        return this.emit(at + 2, { kind: 'punct', text: '${', at });
      } else at += 1;
    }
    return this.fail('a template is not closed', start);
  }

  private readWord(): Token | null {
    const start = this.pos;
    let at = start;
    let word = '';
    while (at < this.text.length) {
      const code = this.text.charCodeAt(at);
      if (code === 0x5c) {
        const escape = this.identifierEscape(at);
        if (escape === null)
          return this.fail('a backslash escape that is not part of an identifier');
        word += escape.char;
        at = escape.end;
      } else if (isWordChar(code)) {
        word += this.text[at];
        at += 1;
      } else break;
    }
    // A number is not a name: `1e5` and `0x1f` are one token that nothing reads.
    const token: Token =
      word.charCodeAt(0) <= 0x39 ? OTHER(start) : { kind: 'word', text: word, at: start };
    if (!this.memberOf() && token.kind === 'word') this.noteKeyword(token);
    return this.emit(at, token);
  }

  /**
   * An escape in an identifier, `\u0072` or `\u{72}`, as the character it spells: `\u0072equire` is `require`,
   * and is read as that word. Anything else after a backslash is not JavaScript.
   */
  private identifierEscape(at: number): { char: string; end: number } | null {
    if (this.text[at + 1] !== 'u') return null;
    const braced = this.text[at + 2] === '{';
    const digits = braced
      ? /^[0-9a-fA-F]{1,6}(?=\})/.exec(this.text.slice(at + 3, at + 10))?.[0]
      : /^[0-9a-fA-F]{4}/.exec(this.text.slice(at + 2, at + 6))?.[0];
    if (digits === undefined) return null;
    const point = Number.parseInt(digits, 16);
    if (point > 0x10ffff) return null;
    return { char: String.fromCodePoint(point), end: at + 2 + (braced ? 2 : 0) + digits.length };
  }

  /** Whether the word being read follows a `.`, `?.` or `#`: a property name, whatever it spells. */
  private memberOf(): boolean {
    return isPunct(this.prev, '.') || isPunct(this.prev, '?.') || isPunct(this.prev, '#');
  }

  /** `function` and `class` start something whose end (`}`) is a value or a statement by where they stand. */
  private noteKeyword(token: Token): void {
    if (token.text === 'function')
      this.pendingFn = { position: this.positionBefore(), depth: this.frames.length };
    else if (token.text === 'class')
      this.pendingClass = { position: this.positionBefore(), depth: this.frames.length };
  }

  // ---------------------------------------------------------------------------------------------
  // Brackets
  // ---------------------------------------------------------------------------------------------

  private push(frame: Frame): boolean {
    if (this.frames.length >= DEPTH_MAX) {
      this.fail('brackets are nested too deep');
      return false;
    }
    this.frames.push(frame);
    return true;
  }

  private readPunct(code: number): Token | null {
    const start = this.pos;
    const char = this.text[start] ?? '';
    // `<!--` and a `-->` that starts a line are comments in a script and not in a module: no reading of
    // the text settles which of them Node uses for this file, so the text is not read.
    if (code === 0x3c && this.text.startsWith('<!--', start))
      return this.fail('an HTML-like comment');
    if (code === 0x2d && this.lineStart && this.text.startsWith('-->', start))
      return this.fail('an HTML-like comment');
    if (code === 0x28) return this.open({ kind: 'paren', ...this.parenRole() }, '(');
    if (code === 0x5b) return this.open({ kind: 'bracket' }, '[');
    if (code === 0x7b) return this.open({ kind: 'brace', brace: this.braceKind() }, '{');
    if (code === 0x29 || code === 0x5d || code === 0x7d) return this.close(code);
    const two = this.text.slice(start, start + 2);
    if (two === '++' || two === '--' || two === '=>')
      return this.emit(start + 2, { kind: 'punct', text: two, at: start });
    if (two === '?.' && !/[0-9]/.test(this.text[start + 2] ?? ''))
      return this.emit(start + 2, { kind: 'punct', text: '?.', at: start });
    if (char === ';') {
      this.pendingClass = null;
      this.pendingFn = null;
    }
    return this.emit(start + 1, { kind: 'punct', text: char, at: start });
  }

  private open(frame: Frame, char: string): Token | null {
    const start = this.pos;
    if (!this.push(frame)) return null;
    return this.emit(start + 1, { kind: 'punct', text: char, at: start });
  }

  private close(code: number): Token | null {
    const start = this.pos;
    const top = this.frames[this.frames.length - 1];
    const want = code === 0x29 ? 'paren' : code === 0x5d ? 'bracket' : 'brace';
    if (code === 0x7d && top?.kind === 'hole') {
      this.frames.pop();
      this.holes -= 1;
      return this.readTemplate(start + 1, false, start);
    }
    if (top === undefined || top.kind !== want)
      return this.fail(`a ${String.fromCharCode(code)} closes nothing that was opened`);
    this.frames.pop();
    this.closed = top as Closed;
    return this.emit(start + 1, { kind: 'punct', text: String.fromCharCode(code), at: start });
  }

  /** What a `(` is: the head of a statement, the parameters of a `function`, or anything else. */
  private parenRole(): { head: boolean; forHead: boolean; fn: Position | null } {
    const pending = this.pendingFn;
    if (pending !== null && pending.depth === this.frames.length) {
      this.pendingFn = null;
      return { head: false, forHead: false, fn: pending.position };
    }
    const before = this.prev;
    const word = before?.kind === 'word' && !this.afterMember(this.prev2) ? before.text : '';
    // `for await (`: the head is the one of `for`.
    const forAwait = word === 'await' && isWord(this.prev2, 'for');
    return {
      head: HEAD_WORDS.has(word) || forAwait,
      forHead: word === 'for' || forAwait,
      fn: null,
    };
  }

  private afterMember(token: Token | null): boolean {
    return isPunct(token, '.') || isPunct(token, '?.') || isPunct(token, '#');
  }

  /** What a `{` opens, from the token before it: it decides whether a `/` after the matching `}` divides. */
  private braceKind(): BraceKind {
    const before = this.prev;
    const pending = this.pendingClass;
    if (pending !== null && pending.depth === this.frames.length && before !== null) {
      if (before.kind === 'word' || isPunct(before, ')') || isPunct(before, ']')) {
        this.pendingClass = null;
        return this.valueOrStatement(pending.position, 'class-expr');
      }
    }
    if (before === null) return 'block';
    if (before.kind === 'word') return this.braceAfterWord(before.text);
    if (before.kind !== 'punct') return 'ambiguous';
    switch (before.text) {
      case ')':
        return this.braceAfterParen();
      case '=>':
      case ';':
      case '{':
      case '}':
        return 'block';
      case ':':
      case ']':
        return 'ambiguous';
      default:
        // An operator, `(`, `[`, `,`, `=`, `?`, `${`: an expression is expected, so this is an object.
        return 'object';
    }
  }

  private braceAfterWord(word: string): BraceKind {
    if (BLOCK_WORDS.has(word)) return 'block';
    return OBJECT_WORDS.has(word) ? 'object' : 'ambiguous';
  }

  private braceAfterParen(): BraceKind {
    const closed = this.closed;
    if (closed === null || closed.kind !== 'paren') return 'ambiguous';
    if (closed.fn !== null) return this.valueOrStatement(closed.fn, 'function-expr');
    // A head (`if (a) {`), a method (`m() {`), a catch or a switch: a block.
    return 'block';
  }

  private valueOrStatement(position: Position, value: BraceKind): BraceKind {
    if (position === 'stmt') return 'block';
    return position === 'expr' ? value : 'ambiguous';
  }

  /** Whether the keyword being read (`function`, `class`) stands where a statement starts, or in an expression. */
  private positionBefore(): Position {
    const before = this.prev;
    if (before === null) return 'stmt';
    if (before.kind === 'word') return this.positionAfterWord(before.text);
    if (before.kind !== 'punct') return 'unknown';
    switch (before.text) {
      case ';':
        return 'stmt';
      case '{':
        return this.positionInBrace();
      case '}':
        return this.closed?.kind === 'brace' && this.closed.brace === 'block' ? 'stmt' : 'unknown';
      case ')':
        return this.closed?.kind === 'paren' && this.closed.head ? 'stmt' : 'unknown';
      case ':':
        return 'unknown';
      default:
        return 'expr';
    }
  }

  private positionInBrace(): Position {
    const top = this.frames[this.frames.length - 1];
    // Inside a block, and inside the body of a function that is a value, statements start.
    return top?.kind === 'brace' && (top.brace === 'block' || top.brace === 'function-expr')
      ? 'stmt'
      : 'unknown';
  }

  private positionAfterWord(word: string): Position {
    if (word === 'export' || word === 'else' || word === 'do') return 'stmt';
    if (word === 'default') return isWord(this.prev2, 'export') ? 'stmt' : 'expr';
    return OBJECT_WORDS.has(word) ? 'expr' : 'unknown';
  }

  // ---------------------------------------------------------------------------------------------
  // The slash
  // ---------------------------------------------------------------------------------------------

  private slash(): Token | null {
    const mode = this.slashMode();
    if (mode === 'regex') return this.readRegex();
    if (mode === 'doubt')
      return this.fail('a slash that could divide or start a regular expression');
    const start = this.pos;
    return this.emit(start + 1, { kind: 'punct', text: '/', at: start });
  }

  private slashMode(): 'regex' | 'divide' | 'doubt' {
    const before = this.prev;
    if (before === null) return 'regex';
    if (before.kind === 'string' || before.kind === 'other') return 'divide';
    if (before.kind === 'word') return this.slashAfterWord(before.text);
    switch (before.text) {
      case ')':
        return this.closed?.kind === 'paren' && this.closed.head ? 'regex' : 'divide';
      case ']':
        return 'divide';
      case '}':
        return this.slashAfterBrace();
      case '++':
      case '--':
        // `a++ / 2` divides. A prefix `++` has to be followed by an operand, so a slash there is no JavaScript.
        return endsOperand(this.prev2) ? 'divide' : 'doubt';
      default:
        return 'regex';
    }
  }

  private slashAfterWord(word: string): 'regex' | 'divide' | 'doubt' {
    if (this.afterMember(this.prev2)) return 'divide';
    if (VALUE_WORDS.has(word)) return 'divide';
    if (REGEX_WORDS.has(word)) return 'regex';
    if (AMBIGUOUS_WORDS.has(word)) return this.slashAfterAmbiguous(word);
    return 'divide';
  }

  /**
   * `of` after a binding inside the head of a `for` is a keyword and a regular expression follows. Every
   * other `of`, `yield`, `await`, `let`, `static`, `async`, `get` and `set` is a name in some places and a
   * keyword in others, and a slash after one is a doubt.
   */
  private slashAfterAmbiguous(word: string): 'regex' | 'doubt' {
    const top = this.frames[this.frames.length - 1];
    if (word === 'of' && top?.kind === 'paren' && top.forHead && endsOperand(this.prev2))
      return 'regex';
    return 'doubt';
  }

  private slashAfterBrace(): 'regex' | 'divide' | 'doubt' {
    const closed = this.closed;
    if (closed === null || closed.kind !== 'brace') return 'doubt';
    switch (closed.brace) {
      case 'block':
        return 'regex';
      case 'object':
      case 'function-expr':
      case 'class-expr':
        return 'divide';
      case 'ambiguous':
        return 'doubt';
    }
  }

  private readRegex(): Token | null {
    const start = this.pos;
    let at = start + 1;
    let inClass = false;
    for (;;) {
      const code = this.text.charCodeAt(at);
      if (Number.isNaN(code) || isLineTerminator(code))
        return this.fail('a regular expression is not closed on its line', start);
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
    return this.emit(at, OTHER(start));
  }
}

/** The line (from 1) of a place in a text, counting `\n` only: a place for a person to look, not a position. */
export function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}
