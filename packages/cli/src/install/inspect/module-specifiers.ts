// The modules a JavaScript file asks for by name: `import ... from 'x'`, `export ... from 'x'`, `import 'x'`,
// `require('x')` and `import('x')` with a string written out.
//
// Whether a server's code can be pinned depends on this: Node looks a name up in folders above the file
// that asks, and what it finds there is not among the bytes that were confirmed. So the names are read
// from the text, without running it and without a parser (none is a dependency here).
//
// The reading is one pass over the text with a small lexer, so its work grows with the text and nothing
// else, whatever the text is: a comment or a string is skipped and not read for imports, a regular
// expression is told from a division by the token before it, a template literal is followed through its
// `${ }` holes, and a string ends at the end of its line, so a quote that was mistaken for the start of
// one costs one line and not the rest of the file. It is a reading and not a verdict: code that builds
// a module name at run time has no name to read, and the blind spots say so.
import { builtinModules } from 'node:module';

/** The most distinct specifiers one file is read for. */
export const MAX_SPECIFIERS = 200;
/** The most tokens an import or export clause may take before it is given up as something else. */
const MAX_CLAUSE_TOKENS = 2000;

interface Token {
  readonly kind: 'word' | 'string' | 'punct' | 'other';
  readonly text: string;
}

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
]);

const isWordChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x24 ||
  code >= 0x80;
const isSpace = (code: number): boolean =>
  code <= 0x20 || code === 0xa0 || code === 0xfeff || code === 0x2028 || code === 0x2029;

class Lexer {
  private pos = 0;
  private previous: Token | null = null;
  private braces = 0;
  /** The brace depth at which each open `${` of a template literal will end. */
  private readonly holes: number[] = [];

  constructor(private readonly text: string) {
    if (text.startsWith('#!')) this.pos = this.lineEnd(0);
  }

  private lineEnd(from: number): number {
    const at = this.text.indexOf('\n', from);
    return at === -1 ? this.text.length : at;
  }

  private emit(token: Token): Token {
    this.previous = token;
    return token;
  }

  /** A string up to its closing quote, or to the end of its line if it has none. */
  private readString(quote: number): Token {
    let at = this.pos + 1;
    while (at < this.text.length) {
      const code = this.text.charCodeAt(at);
      if (code === 0x5c) at += 2;
      else if (code === quote) break;
      else if (code === 0x0a) return this.finish(at, OTHER);
      else at += 1;
    }
    const body = this.text.slice(this.pos + 1, Math.min(at, this.text.length));
    return this.finish(at + 1, { kind: 'string', text: body });
  }

  private finish(next: number, token: Token): Token {
    this.pos = Math.min(next, this.text.length);
    return this.emit(token);
  }

  /**
   * Template text from `from` to the closing backtick, or to a `${` whose hole the lexer then reads as
   * code. A template with no hole is a string, and one with a hole has no name to read.
   */
  private readTemplate(from: number, whole: boolean): Token {
    let at = from;
    while (at < this.text.length) {
      const code = this.text.charCodeAt(at);
      if (code === 0x5c) at += 2;
      else if (code === 0x60)
        return this.finish(
          at + 1,
          whole ? { kind: 'string', text: this.text.slice(from, at) } : OTHER,
        );
      else if (code === 0x24 && this.text.charCodeAt(at + 1) === 0x7b) {
        this.holes.push(this.braces);
        return this.finish(at + 2, OTHER);
      } else at += 1;
    }
    return this.finish(at, OTHER);
  }

  private skipRegex(): Token {
    let at = this.pos + 1;
    let inClass = false;
    while (at < this.text.length) {
      const code = this.text.charCodeAt(at);
      if (code === 0x0a) break;
      if (code === 0x5c) at += 1;
      else if (code === 0x5b) inClass = true;
      else if (code === 0x5d) inClass = false;
      else if (code === 0x2f && !inClass) {
        at += 1;
        while (at < this.text.length && isWordChar(this.text.charCodeAt(at))) at += 1;
        break;
      }
      at += 1;
    }
    return this.finish(at, OTHER);
  }

  private regexAllowed(): boolean {
    const before = this.previous;
    if (before === null) return true;
    if (before.kind === 'punct')
      return before.text !== ')' && before.text !== ']' && before.text !== '}';
    return before.kind === 'word' && BEFORE_REGEX.has(before.text);
  }

  /** Skips blanks and comments; false at the end of the text. */
  private skipTrivia(): boolean {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (isSpace(code)) this.pos += 1;
      else if (code === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x2f)
        this.pos = this.lineEnd(this.pos);
      else if (code === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x2a) {
        const end = this.text.indexOf('*/', this.pos + 2);
        this.pos = end === -1 ? this.text.length : end + 2;
      } else return true;
    }
    return false;
  }

  next(): Token | null {
    if (!this.skipTrivia()) return null;
    const code = this.text.charCodeAt(this.pos);
    if (code === 0x27 || code === 0x22) return this.readString(code);
    if (code === 0x60) return this.readTemplate(this.pos + 1, true);
    if (code === 0x2f && this.regexAllowed()) return this.skipRegex();
    if (isWordChar(code)) return this.readWord();
    return this.readPunct(code);
  }

  private readWord(): Token {
    let at = this.pos + 1;
    while (at < this.text.length && isWordChar(this.text.charCodeAt(at))) at += 1;
    const word = this.text.slice(this.pos, at);
    const numeric = word.charCodeAt(0) <= 0x39;
    return this.finish(at, numeric ? OTHER : { kind: 'word', text: word });
  }

  private readPunct(code: number): Token {
    const char = this.text[this.pos] ?? '';
    if (code === 0x7b) this.braces += 1;
    if (code === 0x7d) {
      if (this.holes.length > 0 && this.holes[this.holes.length - 1] === this.braces) {
        this.holes.pop();
        return this.readTemplate(this.pos + 1, false);
      }
      this.braces = Math.max(0, this.braces - 1);
    }
    return this.finish(this.pos + 1, { kind: 'punct', text: char });
  }
}

interface ClauseState {
  readonly at: 'clause';
  readonly depth: number;
  readonly closed: boolean;
  readonly used: number;
}

type State =
  | { readonly at: 'idle' }
  | { readonly at: 'require' }
  | { readonly at: 'call' }
  | { readonly at: 'callEnd'; readonly specifier: string }
  | { readonly at: 'import' }
  | { readonly at: 'export' }
  | { readonly at: 'from' }
  | ClauseState;

const CLAUSE_START: ClauseState = { at: 'clause', depth: 0, closed: false, used: 0 };

const IDLE: State = { at: 'idle' };
const isPunct = (token: Token, text: string): boolean =>
  token.kind === 'punct' && token.text === text;

/** What follows `import` or `export` when it starts a clause that ends in `from 'x'`. */
function clauseStep(state: ClauseState, token: Token): State | 'abort' {
  const used = state.used + 1;
  if (used > MAX_CLAUSE_TOKENS) return 'abort';
  if (token.kind === 'word' && state.depth === 0 && token.text === 'from') return { at: 'from' };
  if (state.closed) return 'abort';
  if (isPunct(token, '{')) return { ...state, depth: state.depth + 1, used };
  if (isPunct(token, '}'))
    return state.depth === 1
      ? { at: 'clause', depth: 0, closed: true, used }
      : { ...state, depth: Math.max(0, state.depth - 1), used };
  if (token.kind === 'string') return state.depth > 0 ? { ...state, used } : 'abort';
  if (token.kind === 'word') {
    const own = ['import', 'export', 'require'].includes(token.text);
    return own ? 'abort' : { ...state, used };
  }
  return isPunct(token, ',') || isPunct(token, '*') ? { ...state, used } : 'abort';
}

/** One step of the reader of tokens: the next state, the specifier it found, and whether the token must be read again. */
function step(
  state: State,
  token: Token,
  afterDot: boolean,
): { state: State; found?: string; again?: true } {
  switch (state.at) {
    case 'call':
      return token.kind === 'string'
        ? { state: { at: 'callEnd', specifier: token.text } }
        : { state: IDLE, again: true };
    case 'callEnd':
      // `require('a' + b)` names no module: the string is closed by `)`, or by `,` before options.
      return isPunct(token, ')') || isPunct(token, ',')
        ? { state: IDLE, found: state.specifier }
        : { state: IDLE, again: true };
    case 'require':
      return isPunct(token, '(') ? { state: { at: 'call' } } : { state: IDLE, again: true };
    case 'from':
      return token.kind === 'string'
        ? { state: IDLE, found: token.text }
        : { state: IDLE, again: true };
    case 'import':
      if (isPunct(token, '(')) return { state: { at: 'call' } };
      if (token.kind === 'string') return { state: IDLE, found: token.text };
      if (isPunct(token, '.')) return { state: IDLE };
      if (token.kind === 'word' || isPunct(token, '{') || isPunct(token, '*'))
        return stepClause(CLAUSE_START, token);
      return { state: IDLE, again: true };
    case 'export':
      return isPunct(token, '{') || isPunct(token, '*')
        ? stepClause(CLAUSE_START, token)
        : { state: IDLE, again: true };
    case 'clause':
      return stepClause(state, token);
    case 'idle':
      return stepIdle(token, afterDot);
  }
}

function stepClause(state: ClauseState, token: Token): { state: State; again?: true } {
  const next = clauseStep(state, token);
  return next === 'abort' ? { state: IDLE, again: true } : { state: next };
}

function stepIdle(token: Token, afterDot: boolean): { state: State } {
  if (token.kind !== 'word') return { state: IDLE };
  if (token.text === 'require') return { state: { at: 'require' } };
  if (token.text === 'import' && !afterDot) return { state: { at: 'import' } };
  if (token.text === 'export' && !afterDot) return { state: { at: 'export' } };
  return { state: IDLE };
}

/**
 * The specifiers a file asks for, each once, in the order they first appear, at most `limit` of them.
 * A specifier is the text between the quotes as it is written, with no escape read.
 */
export function moduleSpecifiers(text: string, limit = MAX_SPECIFIERS): string[] {
  const lexer = new Lexer(text);
  const found = new Set<string>();
  let state: State = IDLE;
  let afterDot = false;
  for (let token = lexer.next(); token !== null && found.size < limit; token = lexer.next()) {
    let result = step(state, token, afterDot);
    if (result.again === true) result = step(result.state, token, afterDot);
    state = result.state;
    if (result.found !== undefined) found.add(result.found);
    afterDot = isPunct(token, '.');
  }
  return [...found];
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
/** A drive letter or a backslash start: a path on Windows, which Node reads as one. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\)/;
/** A scheme: letters, then a colon. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Whether Node looks the specifier up by name in folders above the file that asks: it is not a path
 * (relative, absolute, a Windows path), not a built-in, not `node:`, `file:` or `data:`, and not a
 * `#` import that the package maps itself. A scheme that Node cannot load (`https:`) or that belongs to
 * another runtime (`npm:`) is counted: its code comes from outside the tree as well.
 */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier === '' || specifier === '.' || specifier === '..') return false;
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/'))
    return false;
  if (specifier.startsWith('#') || WINDOWS_PATH.test(specifier)) return false;
  if (BUILTINS.has(specifier)) return false;
  const scheme = SCHEME.exec(specifier)?.[0];
  return scheme === undefined || !['node:', 'file:', 'data:'].includes(scheme.toLowerCase());
}

/** The package a bare specifier names: `@scope/name` or `name`, without the path inside it. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? '');
}
